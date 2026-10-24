import { eq } from "drizzle-orm";
import { actionsPublishing, manifestOf } from "./actions.ts";
import { buildAgentInput, evaluateContext, readDiffScope } from "./agent-input.ts";
import { commitInput, describeCommit, startCommitThread } from "./commit-review.ts";
import { describeWindow } from "./window-review.ts";
import { config, getActionConfig, getRepositoryPath, isBotLogin } from "./config.ts";
import type { Manifest } from "./manifests.ts";
import { botName } from "./identity.ts";
import { runCommands, withValidationSlot } from "./commands.ts";
import { createRunDatabase, removeRunDatabase } from "./databases.ts";
import { db } from "./db.ts";
import { branchConflictCode, describeError, type ErrorDetails } from "./errors.ts";
import { conventionalTitle, createMergeCommit, fetchPullRequestHead, fetchRepository, git, headOf, hasPendingMerge, mergeBase, prepareTarget } from "./git.ts";
import { GitHubRepository } from "./github.ts";
import { freshness, savedEvaluation } from "./freshness.ts";
import { startOperation } from "./logging.ts";
import type { GithubContext, GithubPullRequest } from "./github-types.ts";
import { observe, type ItemObservation } from "./observation.ts";
import { assertConfiguredRepository, remoteUrl } from "./repository.ts";
import { executePi } from "./pi.ts";
import { resolvePrReview } from "./pr-assessment.ts";
import { getRun, latestSessionRun, runHistory, updateRun } from "./run-history.ts";
import { reviewPullRequest } from "./pr-review.ts";
import { publishCommit, publishRun, publishWindow } from "./publication.ts";
import { assertComplete, type AgentResult, CheckFailure, hasValidationCheckpoint, InterruptedError } from "./results.ts";
import type { Item } from "./items.ts";
import { subjects, workspaces, type Run, type Task, type Subject, type Workspace } from "./schema.ts";
import { childEnvironment } from "./secrets.ts";
import { recordEvent } from "./events.ts";
import { claimTask, configuredReviewers, finishRun, interruptRun, retryTransientFailure } from "./tasks.ts";
import { isBaseOnly, parseTriggerInput } from "./triggers.ts";
import { assertNoCommittedSecrets, checkpointWorkspace, commitWorkspace, createWorkspace, getWorkspace, pinWorkspaceBase, removeWorkspace, validateCheckpoint, validateWorkspace } from "./workspaces.ts";

type DatabaseConfig = NonNullable<typeof config.workspace.database>;
type Environment = Record<string, string | undefined>;
type References = { subjectId: string; taskId: string; runId: string };
type Acceptance = NonNullable<Manifest["acceptance"]>;

const botAuthor = () => ({ name: config.github.botLogin, email: `${config.github.botLogin}@users.noreply.github.com` });

async function prepareWorkspace(workspace: Workspace, environment: Environment, references: References, databaseConfig?: DatabaseConfig | null) {
  await runCommands(config.workspace.prepare, workspace.path, environment, references, "prepare");
  if (databaseConfig) await runCommands([databaseConfig.migrate], workspace.path, environment, references, "migrate");
}

async function asCheckFailure<T>(fn: () => Promise<T>) {
  try { return await fn(); }
  catch (error) {
    if (error instanceof Error && "code" in error && typeof error.code === "number" && error.code <= 128
      && !("signal" in error && error.signal) && !("killed" in error && error.killed)) {
      throw new CheckFailure(error.message, { cause: error });
    }
    throw error;
  }
}

function validationMessage(error: CheckFailure, round: number) {
  const { message, exitCode, stdout } = describeError(error.cause);
  const output = stdout?.trim() ? `\nOutput (tail):\n${stdout.trim()}\n` : "";
  return `${botName}'s validation failed after your changes (round ${round} of ${config.harness.corrections.validation}).\n\nCommand: ${message.split("\n")[0].replace(/^Command failed: /, "")}\nExit code: ${exitCode ?? "unknown"}\n${output}\nFix only what is reported. ${botName} re-validates after your turn, so a full rerun of the failing check is not needed. Then end your turn with one or two sentences on what you changed to fix this (it is appended to your earlier handoff), and the usual SCRAT_STATUS footer (add SCRAT_READY if the change is still ready).`;
}

function stopBefore(stop: AbortSignal | undefined, next: string) {
  if (stop?.aborted) throw new InterruptedError(`Worker is stopping; run left at the stage boundary before ${next}`);
}

const unresolvedConflict = "PR still conflicts with its base branch after resolution";

const commitPurposes: Record<string, string> = { address_review: "Address review", address_pr_feedback: "Address feedback", resolve_conflicts: "Resolve conflicts" };

async function validateAndCommit({ run, task, references, stop }: Ctx, p: Change, kind: Acceptance) {
  const { workspace, commandEnvironment } = p;
  if (!p.validationOnly) updateRun(run.id, { agentCheckpoint: await checkpointWorkspace(workspace) });
  await asCheckFailure(() => prepareWorkspace(workspace, commandEnvironment, references, p.databaseConfig));
  const checkpoint = await checkpointWorkspace(workspace);
  updateRun(run.id, { agentCheckpoint: checkpoint });
  const validationTree = checkpoint.treeSha;
  stopBefore(stop, "validation commands");
  const commands = await asCheckFailure(() => withValidationSlot(() => runCommands(config.workspace.validate, workspace.path, commandEnvironment, references, "validate"), references, stop)
    .catch((error) => { throw stop?.aborted && error === stop.reason ? new InterruptedError("Worker is stopping; run left waiting for a validation slot") : error; }));
  await git(workspace.path, ["add", "--all"]);
  if (await git(workspace.path, ["write-tree"]) !== validationTree) throw new Error("Validation changed the source tree; revalidate the resulting changes");
  await assertNoCommittedSecrets(workspace, p.validationOnly ? run.headSha ?? p.mainSha : p.startHeadSha, validationTree);
  const purpose = commitPurposes[task.action];
  const message = purpose ? `${purpose}: ${p.title}` : conventionalTitle(p.title);
  const commitSha = await commitWorkspace(workspace, message, botAuthor(), references);
  if (await git(workspace.path, ["rev-parse", `${commitSha}^{tree}`]) !== validationTree) throw new Error("Committed tree differs from the validated tree; revalidation required");
  if (kind === "conflict_free") {
    const { conflicts } = await targetOf(p, commitSha);
    if (conflicts) throw new Error(unresolvedConflict);
  }
  if (kind === "nonempty_diff" && !await git(workspace.path, ["diff", "--name-only", `${p.mainSha}...HEAD`])) {
    throw new Error("Implementation produced no changes against the base branch");
  }
  updateRun(run.id, { headSha: commitSha, publication: { status: "pending", commitSha }, verification: { headSha: commitSha, commands }, stage: "publishing" });
}

type Ctx = {
  task: Task; run: Run; subject: Subject; item: Item | undefined;
  references: References; operation: ReturnType<typeof startOperation>;
  manifest: Manifest; repositoryPath: string; stop: AbortSignal | undefined;
  cleanup: { reviewWorkspace?: Workspace; databaseRequested: boolean };
};
type Observed = {
  repository: string; github: GitHubRepository; context: GithubContext; pullRequest: GithubPullRequest | undefined;
  item: Item; observation: ItemObservation; gitEnvironment: NodeJS.ProcessEnv; mainSha: string;
};
type Review = { workspace: Workspace; mainSha: string; headSha: string; diffBaseSha: string };
type Change = {
  workspace: Workspace; validationOnly: boolean; mergeInProgress: boolean; mainSha: string;
  preparedHead: string; startHeadSha: string; headSha: string; title: string; deferred: boolean;
  target: Awaited<ReturnType<typeof prepareTarget>> | undefined;
  databaseConfig: DatabaseConfig | null | undefined;
  environment: Environment; commandEnvironment: Environment;
  result: AgentResult | null; validated: boolean; validationFailure: ErrorDetails | undefined;
  agentInput: { contextDir: string; revisions: Record<string, string> } | undefined;
};

async function targetOf(p: Change, headSha = p.headSha) {
  if (p.target?.headSha !== headSha || p.target.mainSha !== p.mainSha) p.target = await prepareTarget(p.workspace.path, p.mainSha, headSha);
  return p.target;
}

async function connect({ subject, item, repositoryPath }: Ctx): Promise<Observed | undefined> {
  if (!item) return;
  const { repository } = subject;
  assertConfiguredRepository(repository);
  const github = new GitHubRepository(repository);
  const context = await github.fetchItemContext(item.kind, item.payload.number);
  if (context.item.state !== "open") throw new Error("GitHub item is no longer open");
  const pullRequest = "head" in context.item ? context.item : undefined;
  const observation = observe(repository, context);
  const gitEnvironment = await github.getGitEnvironment();
  const mainSha = await fetchRepository(repositoryPath, observation.remote, observation.baseBranch, gitEnvironment);
  return { repository, github, context, pullRequest, item, observation, gitEnvironment, mainSha };
}

async function assertRepairCurrent({ task }: Ctx, { item, observation, mainSha }: Observed) {
  const trigger = parseTriggerInput(task.input);
  if (trigger.kind !== "low_grade") return;
  const state = await resolvePrReview(runHistory(item.id, actionsPublishing("pr_assessment")), observation, mainSha);
  if (state.kind !== "current" || state.assessment.originId !== trigger.assessmentRunId) {
    throw new Error("The review this repair addresses is no longer the current assessment");
  }
}

async function settleReviewPlan(ctx: Ctx, { item, observation, mainSha }: Observed) {
  const { run, task } = ctx;
  if (run.reviewers.length !== 1) return;
  const trigger = parseTriggerInput(run.input);
  if (isBaseOnly(trigger)) {
    const state = await resolvePrReview(runHistory(item.id, actionsPublishing("pr_assessment")), observation, mainSha);
    if (state.kind === "stale" && state.reason === "base" && (state.assessment.run.mainSha ?? null) === (trigger.previousMainSha ?? null)
      && (state.assessment.run.headSha ?? null) === (trigger.previousHeadSha ?? null)) return;
  }
  const { provider, model, thinkingLevel } = getActionConfig(task.action);
  updateRun(run.id, { reviewers: configuredReviewers(task.action), provider, model, thinkingLevel });
  ctx.run = getRun(run.id)!;
}

async function itemRevisions({ repositoryPath }: Ctx, { pullRequest, observation, gitEnvironment, mainSha }: Observed) {
  const headSha = pullRequest ? await fetchPullRequestHead(repositoryPath, observation.remote, pullRequest.number, pullRequest.head.sha, gitEnvironment) : mainSha;
  return { mainSha, headSha };
}

async function commitRevisions({ subject, run, task, manifest, operation }: Ctx) {
  const input = commitInput(run.input), { sha } = input;
  if (manifest.start?.includes("slack_post")) await startCommitThread(subject, task.action, input, operation.log);
  return { mainSha: sha, headSha: sha };
}

async function windowRevisions({ subject, repositoryPath }: Ctx) {
  const { repository } = subject;
  assertConfiguredRepository(repository);
  const mainSha = await fetchRepository(repositoryPath, remoteUrl(repository), config.github.baseBranch, await new GitHubRepository(repository).getGitEnvironment());
  return { mainSha, headSha: mainSha };
}

async function tryCleanup(operation: Ctx["operation"], detail: Record<string, string>, fn: () => Promise<unknown>) {
  try { await fn(); }
  catch { operation.log.warn({ event: "run.cleanup_pending", ...detail }); }
}

async function runAgent({ run, task, manifest, operation, stop }: Ctx, { environment, input, sessionFile, baseSha, panel }: {
  environment: Environment; input: Omit<Parameters<typeof buildAgentInput>[0], "run" | "task">;
  sessionFile?: string; baseSha?: string; panel?: { baseSha: string; requireGrade: boolean };
}) {
  const { workspace } = input;
  const { prompt, contextDir, revisions } = await buildAgentInput({ run, task, ...input });
  const shared = { tools: manifest.tools, scoped: manifest, contextDir, revisions, stop };
  const agentResult = panel
    ? await reviewPullRequest(run, workspace.path, prompt, operation.log, { ...shared, ...panel })
    : await executePi({ run, cwd: workspace.path, context: prompt, log: operation.log, sessionFile, environment, baseSha, ...shared });
  return { result: { ...agentResult, paths: [...new Set([...input.diffPaths, ...agentResult.paths])] }, contextDir, revisions };
}

async function prepareReviewCommands({ run, repositoryPath, references, operation, cleanup }: Ctx, { context, pullRequest, observation }: Observed, review: Review, environment: Environment) {
  try { await prepareWorkspace(review.workspace, environment, references); }
  catch (error) {
    if (!pullRequest || isBotLogin(context.item.user?.login)) throw error;
    const { behind, conflicts } = await prepareTarget(review.workspace.path, review.mainSha, review.headSha);
    if (!behind) throw error;
    const { baseBranch } = observation;
    if (conflicts) throw Object.assign(new Error(`PR branch is behind ${baseBranch} and does not merge cleanly; the author needs to update it`), { code: branchConflictCode });
    const synthetic = await createMergeCommit(repositoryPath, review.mainSha, review.headSha, `Review merge of ${baseBranch} into the PR head`, botAuthor());
    cleanup.reviewWorkspace = undefined;
    await tryCleanup(operation, { workspaceId: review.workspace.id }, () => removeWorkspace(review.workspace.id, references));
    review.workspace = cleanup.reviewWorkspace = await createWorkspace({ repositoryPath, baseRef: synthetic }, references);
    updateRun(run.id, { workspaceId: review.workspace.id });
    review.headSha = synthetic;
    review.diffBaseSha = review.mainSha;
    await prepareWorkspace(review.workspace, environment, references);
  }
}

async function reviewRun(ctx: Ctx, observed: Observed | undefined) {
  const { task, run, subject, manifest, repositoryPath, stop } = ctx;
  const { mainSha, headSha } = observed ? await itemRevisions(ctx, observed)
    : subject.kind === "window" ? await windowRevisions(ctx) : await commitRevisions(ctx);
  const workspace = ctx.cleanup.reviewWorkspace = await createWorkspace({ repositoryPath, baseRef: headSha }, ctx.references);
  updateRun(run.id, { workspaceId: workspace.id, mainSha, headSha });
  const { evaluated, diffPaths, diffBaseSha } = observed
    ? { evaluated: evaluateContext(run, task, observed.observation), ...await readDiffScope(workspace.path, mainSha, headSha, Boolean(observed.pullRequest)) }
    : subject.kind === "window" ? describeWindow(task.action, subject, mainSha) : await describeCommit(repositoryPath, subject, run.input);
  updateRun(run.id, { context: evaluated });
  const review: Review = { workspace, mainSha, headSha, diffBaseSha };
  const environment: Environment = observed ? { ...config.workspace.environment } : {};
  stopBefore(stop, "workspace preparation");
  if (observed) await prepareReviewCommands(ctx, observed, review, { ...childEnvironment(), ...environment });
  stopBefore(stop, "the agent");
  const changeContext = manifest.context === "change";
  if (observed) await settleReviewPlan(ctx, observed);
  updateRun(run.id, { stage: "agent" });
  const { result } = await runAgent(ctx, {
    environment, baseSha: changeContext ? review.diffBaseSha : undefined,
    panel: getActionConfig(task.action).agent === "panel" ? { baseSha: review.diffBaseSha, requireGrade: !changeContext } : undefined,
    input: { workspace: review.workspace, evaluated, diffBaseSha: review.diffBaseSha, diffPaths, mainSha: review.mainSha, headSha: review.headSha, baseRef: review.mainSha, mergeInProgress: false },
  });
  updateRun(run.id, { result, stage: "validating" });
  assertComplete(result);
  updateRun(run.id, { stage: "publishing" });
}

async function acquireChangeWorkspace(ctx: Ctx, observed: Observed) {
  const { repository, context, pullRequest, item, observation } = observed;
  const { run, references, repositoryPath } = ctx;
  const validationOnly = run.stage === "validating";
  const { mainSha, headSha: preparedHead } = await itemRevisions(ctx, observed);
  let workspace = item.workspaceId ? getWorkspace(item.workspaceId) : undefined;
  if (workspace?.removedAt) throw new Error(`Workspace was removed: ${workspace.id}`);
  if (workspace) {
    await validateWorkspace(workspace);
    await git(workspace.path, ["fetch", "--no-tags", "--", `${repositoryPath}/.git`, preparedHead, mainSha]);
  }
  if (validationOnly) {
    if (!hasValidationCheckpoint(run)) throw new Error("No complete agent checkpoint to resume; use normal retry to repair");
    if (!workspace || workspace.id !== run.workspaceId) throw new Error("Validation checkpoint workspace is no longer attached to this item");
    if ((await freshness(savedEvaluation(run), { ...observation, mainSha }, "exact")).kind === "stale") {
      throw new Error("Validation checkpoint context or base changed; use normal retry to repair against current requirements");
    }
    await validateCheckpoint(workspace, run.agentCheckpoint);
  }
  if (!workspace) {
    if (pullRequest && pullRequest.head.repo?.full_name !== repository) {
      throw new Error("Cannot update a PR branch in a different repository");
    }
    workspace = await createWorkspace({ repositoryPath, baseRef: preparedHead, branch: pullRequest?.head.ref }, references);
    db.update(subjects).set({ workspaceId: workspace.id }).where(eq(subjects.id, item.id)).run();
  }
  const mergeInProgress = await hasPendingMerge(workspace.path);
  if (!mergeInProgress && !validationOnly) {
    if (pullRequest) {
      await git(workspace.path, ["merge", "--ff-only", preparedHead]);
      await pinWorkspaceBase(workspace, preparedHead);
    } else {
      try {
        await git(workspace.path, ["merge", "--ff-only", preparedHead]);
        if (await headOf(workspace.path) === preparedHead) {
          await pinWorkspaceBase(workspace, preparedHead);
          db.update(workspaces).set({ baseSha: preparedHead }).where(eq(workspaces.id, workspace.id)).run();
        }
      } catch (error) {
        ctx.operation.log.warn({ event: "workspace.base_update_skipped", workspaceId: workspace.id, err: error });
      }
    }
  }
  const startHeadSha = await headOf(workspace.path);
  return { workspace, validationOnly, mergeInProgress, mainSha, preparedHead, startHeadSha, title: context.item.title };
}

async function mergeBehindBase(p: Change, { observation, pullRequest }: Observed, fail?: unknown) {
  const { behind, conflicts } = await targetOf(p);
  if (!behind || conflicts) return false;
  await mergeBase(p.workspace.path, p.mainSha, `Merge ${observation.baseBranch} into ${pullRequest!.head.ref}`, botAuthor()).catch((error) => { throw fail ?? error; });
  p.headSha = await headOf(p.workspace.path);
  return true;
}

async function mergeBehind(ctx: Ctx, observed: Observed, p: Change, diffPaths: string[], acceptance: Acceptance) {
  const { run } = ctx;
  if (acceptance !== "conflict_free" || p.mergeInProgress || run.retryOfRunId) return;
  if (!await mergeBehindBase(p, observed)) return;
  const { baseBranch } = observed.observation;
  p.result = { text: `Merged ${baseBranch} (${p.mainSha.slice(0, 7)}) into this branch; no conflicts`, ready: false, paths: [...new Set(diffPaths)], outcome: "complete" };
  updateRun(run.id, { result: p.result, stage: "validating" });
  try {
    await validateAndCommit(ctx, p, acceptance);
    p.validated = true;
  } catch (error) {
    if (!(error instanceof CheckFailure) && !(error instanceof Error && error.message === unresolvedConflict)) throw error;
    p.validationFailure = describeError(error instanceof CheckFailure ? error.cause : error);
  }
}

async function prepareChangeCommands({ references }: Ctx, observed: Observed, p: Change) {
  if (p.deferred) return;
  try { await prepareWorkspace(p.workspace, p.commandEnvironment, references, p.databaseConfig); }
  catch (error) {
    if (!observed.pullRequest || !await mergeBehindBase(p, observed, error)) throw error;
    await prepareWorkspace(p.workspace, p.commandEnvironment, references, p.databaseConfig);
  }
}

async function validateStage(ctx: Ctx, p: Change, acceptance: Acceptance) {
  const { run, operation, stop } = ctx;
  const { workspace, validationOnly } = p;
  let { result } = p;
  if (!result) throw new Error("No saved agent result to validate");
  assertComplete(result);
  const unchanged = acceptance === "complete" && !p.validated && !validationOnly
    && p.startHeadSha === p.preparedHead && !p.mergeInProgress && await headOf(workspace.path) === p.startHeadSha
    && !await git(workspace.path, ["status", "--porcelain"]);
  if (unchanged) updateRun(run.id, { publication: { status: "pending", commitSha: p.startHeadSha }, stage: "publishing" });
  else if (!p.validated) {
    for (let round = 1; ; round++) {
      try { await validateAndCommit(ctx, p, acceptance); break; }
      catch (error) {
        if (!(error instanceof CheckFailure)) throw error;
        const sessionFile = getRun(run.id)!.piSessionFile ?? undefined;
        if (validationOnly || !p.agentInput || !sessionFile || round > config.harness.corrections.validation) throw error.cause;
        operation.log.warn({ event: "pi.validation_retry", round });
        updateRun(run.id, { stage: "agent" });
        const followUp = await executePi({ run, cwd: workspace.path, context: "", tools: ctx.manifest.tools, scoped: ctx.manifest, log: operation.log, sessionFile, environment: p.environment, ...p.agentInput, followUp: validationMessage(error, round), stop });
        result = { ...followUp, text: `${result.text}\n\n**Validation correction ${round}:** ${followUp.text}`, paths: [...new Set([...result.paths, ...followUp.paths])] };
        updateRun(run.id, { result, stage: "validating" });
        assertComplete(result);
      }
    }
  }
}

async function changeRun(ctx: Ctx, observed: Observed) {
  const { task, run, references, cleanup, stop, manifest } = ctx;
  const acceptance = manifest.acceptance!;
  const acquired = await acquireChangeWorkspace(ctx, observed);
  const { workspace, validationOnly, mainSha, startHeadSha } = acquired;
  if (!validationOnly) updateRun(run.id, { workspaceId: workspace.id, mainSha, headSha: startHeadSha });
  const databaseConfig = config.workspace.database;
  let database: Awaited<ReturnType<typeof createRunDatabase>> | undefined;
  if (databaseConfig) {
    cleanup.databaseRequested = true;
    database = await createRunDatabase(run.id, databaseConfig.image, references);
  }
  const environment: Environment = { ...config.workspace.environment,
    ...Object.fromEntries((databaseConfig?.environment ?? []).map((name) => [name, database!.url])),
  };
  const p: Change = {
    ...acquired, headSha: startHeadSha, databaseConfig, environment,
    commandEnvironment: { ...childEnvironment(), ...environment }, result: run.result,
    validated: false, validationFailure: undefined, agentInput: undefined, target: undefined,
    deferred: acquired.mergeInProgress || Boolean(run.retryOfRunId) || acceptance === "conflict_free",
  };
  if (!validationOnly) {
    const evaluated = evaluateContext(run, task, observed.observation);
    const { diffPaths, diffBaseSha } = await readDiffScope(workspace.path, mainSha, p.preparedHead, Boolean(observed.pullRequest));
    updateRun(run.id, { context: evaluated });
    await mergeBehind(ctx, observed, p, diffPaths, acceptance);
    if (!p.validated) {
      stopBefore(stop, "workspace preparation");
      await prepareChangeCommands(ctx, observed, p);
      stopBefore(stop, "the agent");
      updateRun(run.id, { stage: "agent" });
      const { result, contextDir, revisions } = await runAgent(ctx, {
        environment, sessionFile: latestSessionRun(workspace.id, run.id)?.piSessionFile ?? undefined,
        input: {
          workspace, evaluated, diffBaseSha, diffPaths, mainSha, headSha: p.headSha, baseRef: mainSha, mergeInProgress: p.mergeInProgress, validationFailure: p.validationFailure,
          database: database ? { ...database, environment, schemaPrepared: !p.deferred, prepare: config.workspace.prepare, migrate: databaseConfig?.migrate } : undefined,
        },
      });
      p.agentInput = { contextDir, revisions };
      p.result = result;
      updateRun(run.id, { result: p.result, stage: "validating" });
    }
  }
  await validateStage(ctx, p, acceptance);
}

async function publishStage({ task, run, subject, references, manifest, repositoryPath }: Ctx, observed: Observed | undefined) {
  if (!observed) return subject.kind === "window" ? publishWindow(subject, task, run, references) : publishCommit(subject, task, run);
  const { repository, github, context, item, observation, mainSha } = observed;
  const review = manifest.mode === "review";
  const evaluatedRun = getRun(run.id)!;
  const publicationContext = run.stage !== "publishing"
    ? await github.fetchItemContext(observation.kind, item.payload.number) : context;
  if (publicationContext.item.state !== "open") throw new Error("GitHub item is no longer open");
  let headOverride: string | undefined;
  if (!review && "head" in publicationContext.item && evaluatedRun.context?.headSha) {
    const { sha } = publicationContext.item.head;
    if (sha !== evaluatedRun.context.headSha && sha !== evaluatedRun.publication.publishedCommitSha
      && sha !== evaluatedRun.publication.commitSha) throw new Error("GitHub PR head changed during execution");
    headOverride = evaluatedRun.context.headSha;
  }
  const current = observe(repository, publicationContext, headOverride);
  const currentMainSha = review ? async () => run.stage === "publishing" ? mainSha
    : await fetchRepository(repositoryPath, observation.remote, current.baseBranch, await github.getGitEnvironment()) : undefined;
  if (manifest.publish.includes("pr_assessment")) await currentMainSha?.();
  else {
    const state = await freshness(savedEvaluation(evaluatedRun), { ...current, mainSha: currentMainSha }, "relevant-paths", { unknownBase: "current" });
    if (state.kind === "stale") throw new Error(state.reason === "context"
      ? "GitHub task context changed; enqueue a fresh task instead of retrying publication"
      : "Reviewed code changed; enqueue a fresh review instead of retrying publication");
  }
  await publishRun(github, task, evaluatedRun, publicationContext, references);
}

export async function runNextTask(stop?: AbortSignal) {
  const claimed = claimTask();
  if (!claimed) return;
  const { task, run, subject, item } = claimed;
  const references = { subjectId: subject.id, taskId: task.id, runId: run.id };
  const operation = startOperation("run.execute", { ...references, action: task.action });
  const cleanup: Ctx["cleanup"] = { databaseRequested: false };
  const ctx: Ctx = { task, run, subject, item, references, operation, manifest: manifestOf(task.action), repositoryPath: getRepositoryPath(), stop, cleanup };
  try {
    const observed = await connect(ctx);
    if (run.stage !== "publishing") {
      stopBefore(stop, "workspace acquisition");
      if (observed) await assertRepairCurrent(ctx, observed);
      if (ctx.manifest.mode === "review") await reviewRun(ctx, observed);
      else await changeRun(ctx, observed!);
      stopBefore(stop, "publication");
    }
    await publishStage(ctx, observed);
    finishRun(run.id, { status: "completed" });
    operation.complete();
    return getRun(run.id)!;
  } catch (error) {
    if (error instanceof InterruptedError) {
      recordEvent({ ...references, type: "run.interrupting", data: { stage: getRun(run.id)!.stage, reason: error.message } });
      operation.complete({ interrupted: true });
      interruptRun(run.id, error);
      return getRun(run.id)!;
    }
    if (retryTransientFailure(run.id, error)) {
      operation.fail(error);
      return getRun(run.id)!;
    }
    const failed = finishRun(run.id, { status: "failed", error });
    operation.fail(error);
    return failed;
  } finally {
    if (cleanup.databaseRequested) await tryCleanup(operation, { resource: "database" }, () => removeRunDatabase(run.id, references));
    if (cleanup.reviewWorkspace) await tryCleanup(operation, { workspaceId: cleanup.reviewWorkspace.id }, () => removeWorkspace(cleanup.reviewWorkspace!.id, references));
  }
}
