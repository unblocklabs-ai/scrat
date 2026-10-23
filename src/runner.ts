import { eq } from "drizzle-orm";
import { actionsPublishing, manifestOf } from "./actions.ts";
import { buildAgentInput, evaluateContext, readDiffScope } from "./agent-input.ts";
import { commitInput, commitMetadata, describeCommit, startCommitThread } from "./commit-review.ts";
import { describeWindow } from "./window-review.ts";
import { config, getActionConfig, getRepositoryPath, isBotLogin } from "./config.ts";
import type { Manifest } from "./manifests.ts";
import { botName } from "./identity.ts";
import { runCommands, withValidationSlot } from "./commands.ts";
import { createRunDatabase, removeRunDatabase } from "./databases.ts";
import { db } from "./db.ts";
import { describeError, type ErrorDetails } from "./errors.ts";
import { behindCleanly, createMergeCommit, fetchPullRequestHead, fetchRepository, git, hasConflicts, hasPendingMerge, isAncestor, mergeBase } from "./git.ts";
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
import { claimTask, finishRun, interruptRun } from "./tasks.ts";
import { parseTriggerInput } from "./triggers.ts";
import { assertNoCommittedSecrets, checkpointWorkspace, commitWorkspace, createWorkspace, getWorkspace, isolateWorkspace, pinWorkspaceBase, removeWorkspace, validateCheckpoint, validateWorkspace } from "./workspaces.ts";

type DatabaseConfig = NonNullable<NonNullable<typeof config.workspace>["database"]>;
type Environment = Record<string, string | undefined>;
type References = { subjectId: string; taskId: string; runId: string };
type Acceptance = NonNullable<Manifest["acceptance"]>;

const botAuthor = () => ({ name: config.github.botLogin, email: `${config.github.botLogin}@users.noreply.github.com` });

async function prepareWorkspace(workspace: Workspace, environment: Environment, databaseConfig: DatabaseConfig | null | undefined, references: References) {
  await runCommands(config.workspace?.prepare ?? [], workspace.path, environment, references, "prepare");
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

async function validateAndCommit({ run, references, stop }: Ctx, p: Prepared, kind: Acceptance) {
  const { workspace, commandEnvironment } = p;
  if (!p.validationOnly) updateRun(run.id, { agentCheckpoint: await checkpointWorkspace(workspace) });
  await asCheckFailure(() => prepareWorkspace(workspace, commandEnvironment, p.databaseConfig, references));
  const checkpoint = await checkpointWorkspace(workspace);
  updateRun(run.id, { agentCheckpoint: checkpoint });
  const validationTree = checkpoint.treeSha;
  stopBefore(stop, "validation commands");
  const commands = await asCheckFailure(() => withValidationSlot(() => runCommands(config.workspace?.validate ?? [], workspace.path, commandEnvironment, references, "validate"), references, stop)
    .catch((error) => { throw stop?.aborted && error === stop.reason ? new InterruptedError("Worker is stopping; run left waiting for a validation slot") : error; }));
  await git(workspace.path, ["add", "--all"]);
  if (await git(workspace.path, ["write-tree"]) !== validationTree) throw new Error("Validation changed the source tree; revalidate the resulting changes");
  await assertNoCommittedSecrets(workspace, p.validationOnly ? run.headSha ?? p.baseRef : p.startHeadSha, validationTree);
  const message = /^[a-z]+(\([^)]*\))?!?: /.test(p.title) ? p.title : `fix: ${p.title}`;
  const commitSha = await commitWorkspace(workspace, message, botAuthor(), references);
  if (await git(workspace.path, ["rev-parse", `${commitSha}^{tree}`]) !== validationTree) throw new Error("Committed tree differs from the validated tree; revalidation required");
  if (kind === "conflict_free" && await hasConflicts(workspace.path, p.mainSha, commitSha)) {
    throw new Error(unresolvedConflict);
  }
  if (kind === "nonempty_diff" && !await git(workspace.path, ["diff", "--name-only", `${p.baseRef}...HEAD`])) {
    throw new Error("Implementation produced no changes against the base branch");
  }
  updateRun(run.id, { headSha: commitSha, publication: { status: "pending", commitSha }, verification: { headSha: commitSha, commands }, stage: "publishing" });
}

type Ctx = {
  task: Task; run: Run; subject: Subject; item: Item | undefined;
  references: References; operation: ReturnType<typeof startOperation>;
  manifest: Manifest; repositoryPath: string;
  readOnly: boolean; acceptance: Acceptance | undefined; stop: AbortSignal | undefined;
  cleanup: { reviewWorkspace?: Workspace; databaseRequested: boolean };
};
type Observed = {
  repository: string; github: GitHubRepository; context: GithubContext; pullRequest: GithubPullRequest | undefined;
  item: Item; observation: ItemObservation; gitEnvironment: NodeJS.ProcessEnv; mainSha: string;
};
type Prepared = {
  workspace: Workspace; validationOnly: boolean; mergeInProgress: boolean; mainSha: string; baseRef: string;
  preparedHead: string; startHeadSha: string; headSha: string; title: string;
  databaseConfig: DatabaseConfig | null | undefined; database: Awaited<ReturnType<typeof createRunDatabase>> | undefined;
  environment: Environment; commandEnvironment: Environment;
  result: AgentResult | null; validated: boolean; validationFailure: ErrorDetails | undefined;
  agentInput: { contextDir: string; revisions: Record<string, string> } | undefined;
  evaluated: ReturnType<typeof evaluateContext> | undefined; diffPaths: string[]; diffBaseSha: string;
  deferred: boolean; previousSessionFile: string | undefined;
};

function beginRun({ task, run, subject, item }: NonNullable<ReturnType<typeof claimTask>>, stop: AbortSignal | undefined): Ctx {
  const references = { subjectId: subject.id, taskId: task.id, runId: run.id };
  const { action } = task;
  const operation = startOperation("run.execute", { ...references, action });
  const manifest = manifestOf(action);
  return {
    task, run, subject, item, references, operation, manifest, repositoryPath: getRepositoryPath(),
    readOnly: manifest.mode === "review", acceptance: manifest.mode === "change" ? manifest.acceptance : undefined, stop,
    cleanup: { databaseRequested: false },
  };
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

async function acquireItemWorkspace(ctx: Ctx, observed: Observed) {
  const { task, run, references, readOnly, repositoryPath, cleanup } = ctx;
  const { repository, context, pullRequest, item, observation, gitEnvironment, mainSha } = observed;
  const trigger = parseTriggerInput(task.input);
  if (trigger.kind === "low_grade") {
    const state = await resolvePrReview(runHistory(item.id, actionsPublishing("pr_assessment")), observation, mainSha);
    if (state.kind !== "current" || state.assessment.originId !== trigger.assessmentRunId) {
      throw new Error("The review this repair addresses is no longer the current assessment");
    }
  }
  const validationOnly = run.stage === "validating";
  const baseRef = mainSha;
  const headRef = pullRequest
    ? await fetchPullRequestHead(repositoryPath, observation.remote, pullRequest.number, pullRequest.head.sha, gitEnvironment)
    : baseRef;
  const preparedHead = await git(repositoryPath, ["rev-parse", headRef]);
  let workspace = !readOnly && item.workspaceId ? getWorkspace(item.workspaceId) : undefined;
  if (workspace?.removedAt) throw new Error(`Workspace was removed: ${workspace.id}`);
  if (workspace) {
    await validateWorkspace(workspace);
    await isolateWorkspace(workspace);
    if (config.workspace?.layout === "clone") await git(workspace.path, ["fetch", "--no-tags", "--", `${repositoryPath}/.git`, preparedHead, mainSha]);
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
    if (!readOnly && pullRequest && pullRequest.head.repo?.full_name !== repository) {
      throw new Error("Cannot update a PR branch in a different repository");
    }
    workspace = await createWorkspace({
      repositoryPath, baseRef: preparedHead,
      branch: !readOnly && pullRequest ? pullRequest.head.ref : undefined,
    }, references);
    if (readOnly) cleanup.reviewWorkspace = workspace;
    else db.update(subjects).set({ workspaceId: workspace.id }).where(eq(subjects.id, item.id)).run();
  }
  const mergeInProgress = !readOnly && await hasPendingMerge(workspace.path);
  if (!readOnly && !mergeInProgress && !validationOnly) {
    if (pullRequest) {
      await git(workspace.path, ["merge", "--ff-only", preparedHead]);
      await pinWorkspaceBase(workspace, preparedHead);
    } else {
      try {
        await git(workspace.path, ["merge", "--ff-only", preparedHead]);
        if (await git(workspace.path, ["rev-parse", "HEAD"]) === preparedHead) {
          await pinWorkspaceBase(workspace, preparedHead);
          db.update(workspaces).set({ baseSha: preparedHead }).where(eq(workspaces.id, workspace.id)).run();
        }
      } catch (error) {
        ctx.operation.log.warn({ event: "workspace.base_update_skipped", workspaceId: workspace.id, err: error });
      }
    }
  }
  const startHeadSha = await git(workspace.path, ["rev-parse", "HEAD"]);
  return { workspace, validationOnly, mergeInProgress, mainSha, baseRef, preparedHead, startHeadSha, title: context.item.title };
}

async function acquireCommitWorkspace({ subject, run, task, manifest, references, repositoryPath, operation, cleanup }: Ctx) {
  const input = commitInput(run.input), { sha } = input;
  if (manifest.start?.includes("slack_post")) await startCommitThread(subject, task.action, input, operation.log);
  const workspace = await createWorkspace({ repositoryPath, baseRef: sha }, references);
  cleanup.reviewWorkspace = workspace;
  return { workspace, validationOnly: false, mergeInProgress: false, mainSha: sha, baseRef: sha, preparedHead: sha, startHeadSha: sha, title: commitMetadata(subject).title };
}

async function acquireWindowWorkspace({ subject, manifest, references, repositoryPath, cleanup }: Ctx) {
  const { repository } = subject;
  assertConfiguredRepository(repository);
  const mainSha = await fetchRepository(repositoryPath, remoteUrl(repository), config.github.baseBranch, await new GitHubRepository(repository).getGitEnvironment());
  const workspace = await createWorkspace({ repositoryPath, baseRef: mainSha }, references);
  cleanup.reviewWorkspace = workspace;
  return { workspace, validationOnly: false, mergeInProgress: false, mainSha, baseRef: mainSha, preparedHead: mainSha, startHeadSha: mainSha, title: manifest.name };
}

async function acquireWorkspace(ctx: Ctx, observed: Observed | undefined): Promise<Prepared> {
  const { run, references, readOnly, cleanup } = ctx;
  const acquired = observed ? await acquireItemWorkspace(ctx, observed)
    : ctx.subject.kind === "window" ? await acquireWindowWorkspace(ctx) : await acquireCommitWorkspace(ctx);
  const { workspace, validationOnly, mainSha, startHeadSha } = acquired;
  if (!validationOnly) updateRun(run.id, { workspaceId: workspace.id, mainSha, headSha: startHeadSha });
  const databaseConfig = !readOnly ? config.workspace?.database : undefined;
  let database: Prepared["database"];
  if (databaseConfig) {
    cleanup.databaseRequested = true;
    database = await createRunDatabase(run.id, databaseConfig.image, references);
  }
  const environment: Environment = observed ? { ...config.workspace?.environment,
    ...Object.fromEntries((databaseConfig?.environment ?? []).map((name) => [name, database!.url])),
  } : {};
  return {
    ...acquired, headSha: startHeadSha, databaseConfig, database, environment,
    commandEnvironment: { ...childEnvironment(), ...environment }, result: run.result,
    validated: false, validationFailure: undefined, agentInput: undefined,
    evaluated: undefined, diffPaths: [], diffBaseSha: acquired.baseRef, deferred: false, previousSessionFile: undefined,
  };
}

async function planAgent({ task, run, subject, readOnly, acceptance, repositoryPath }: Ctx, observed: Observed | undefined, p: Prepared) {
  const previous = !readOnly ? latestSessionRun(p.workspace.id, run.id) : undefined;
  const { evaluated, diffPaths, diffBaseSha } = observed
    ? { evaluated: evaluateContext(run, task, observed.observation), ...await readDiffScope(p.workspace.path, p.mainSha, p.preparedHead, Boolean(observed.pullRequest)) }
    : subject.kind === "window" ? describeWindow(task.action, subject, p.mainSha) : await describeCommit(repositoryPath, subject, run.input);
  updateRun(run.id, { context: evaluated });
  Object.assign(p, {
    evaluated, diffPaths, diffBaseSha, previousSessionFile: previous?.piSessionFile ?? undefined,
    deferred: p.mergeInProgress || Boolean(run.retryOfRunId) || acceptance === "conflict_free",
  });
}

async function mergeBehind(ctx: Ctx, observed: Observed | undefined, p: Prepared) {
  const { run, acceptance } = ctx;
  if (!observed || acceptance !== "conflict_free" || p.mergeInProgress || run.retryOfRunId || !await behindCleanly(p.workspace.path, p.mainSha, p.headSha)) return;
  const { baseBranch } = observed.observation;
  await mergeBase(p.workspace.path, p.mainSha, `Merge ${baseBranch} into ${observed.pullRequest!.head.ref}`, botAuthor());
  p.headSha = await git(p.workspace.path, ["rev-parse", "HEAD"]);
  p.result = { text: `Merged ${baseBranch} (${p.mainSha.slice(0, 7)}) into this branch; no conflicts`, ready: false, paths: [...new Set(p.diffPaths)], outcome: "complete" };
  updateRun(run.id, { result: p.result, stage: "validating" });
  try {
    await validateAndCommit(ctx, p, acceptance);
    p.validated = true;
  } catch (error) {
    if (!(error instanceof CheckFailure) && !(error instanceof Error && error.message === unresolvedConflict)) throw error;
    p.validationFailure = describeError(error instanceof CheckFailure ? error.cause : error);
  }
}

async function prepareCommands({ run, readOnly, repositoryPath, references, operation, cleanup }: Ctx, observed: Observed | undefined, p: Prepared) {
  if (!observed || (!readOnly && p.deferred)) return;
  const { context, pullRequest, observation } = observed;
  const { baseBranch } = observation;
  try { await prepareWorkspace(p.workspace, p.commandEnvironment, p.databaseConfig, references); }
  catch (error) {
    const humanReview = readOnly && !isBotLogin(context.item.user?.login);
    if (!pullRequest || !(humanReview || !readOnly) || await isAncestor(p.workspace.path, p.mainSha, p.headSha)) throw error;
    if (await hasConflicts(p.workspace.path, p.mainSha, p.headSha)) {
      if (!readOnly) throw error;
      throw new Error(`PR branch is behind ${baseBranch} and does not merge cleanly; the author needs to update it`);
    }
    if (readOnly) {
      const synthetic = await createMergeCommit(repositoryPath, p.mainSha, p.headSha, `Review merge of ${baseBranch} into the PR head`, botAuthor());
      cleanup.reviewWorkspace = undefined;
      try { await removeWorkspace(p.workspace.id, references); }
      catch { operation.log.warn({ event: "run.cleanup_pending", workspaceId: p.workspace.id }); }
      p.workspace = cleanup.reviewWorkspace = await createWorkspace({ repositoryPath, baseRef: synthetic }, references);
      updateRun(run.id, { workspaceId: p.workspace.id });
      p.headSha = synthetic;
      p.diffBaseSha = p.mainSha;
    } else {
      await mergeBase(p.workspace.path, p.mainSha, `Merge ${baseBranch} into ${pullRequest.head.ref}`, botAuthor()).catch(() => { throw error; });
      p.headSha = await git(p.workspace.path, ["rev-parse", "HEAD"]);
    }
    await prepareWorkspace(p.workspace, p.commandEnvironment, p.databaseConfig, references);
  }
}

async function agentStage({ task, run, manifest, readOnly, operation, stop }: Ctx, p: Prepared) {
  const { action } = task;
  const { workspace, environment } = p;
  const configured = getActionConfig(action);
  const changeContext = manifest.context === "change";
  updateRun(run.id, { stage: "agent" });
  const { prompt, contextDir, revisions } = await buildAgentInput({
    run, task, evaluated: p.evaluated!, diffBaseSha: p.diffBaseSha, diffPaths: p.diffPaths, mainSha: p.mainSha, headSha: p.headSha,
    baseRef: p.baseRef, mergeInProgress: p.mergeInProgress, workspace, validationFailure: p.validationFailure,
    priorReviews: manifest.publish.includes("pr_assessment"),
    database: p.database ? {
      ...p.database, environment, schemaPrepared: !p.deferred,
      prepare: config.workspace?.prepare, migrate: p.databaseConfig?.migrate,
    } : undefined,
  });
  p.agentInput = { contextDir, revisions };
  const agentResult = configured.agent === "panel"
    ? await reviewPullRequest(run, workspace.path, prompt, operation.log, { baseSha: p.diffBaseSha, contextDir, revisions, tools: manifest.tools, scoped: manifest, requireGrade: !changeContext, stop })
    : await executePi({ run, cwd: workspace.path, context: prompt, readOnly, tools: manifest.tools, scoped: manifest, log: operation.log, sessionFile: p.previousSessionFile, environment, contextDir, revisions, baseSha: changeContext ? p.diffBaseSha : undefined, stop });
  p.result = { ...agentResult, paths: [...new Set([...p.diffPaths, ...agentResult.paths])] };
  updateRun(run.id, { result: p.result, stage: "validating" });
}

async function validateStage(ctx: Ctx, p: Prepared) {
  const { run, operation, readOnly, acceptance, stop } = ctx;
  const { workspace, validationOnly } = p;
  let { result } = p;
  if (!result) throw new Error("No saved agent result to validate");
  assertComplete(result);
  const unchanged = acceptance === "complete" && !p.validated && !validationOnly
    && p.startHeadSha === p.preparedHead && !p.mergeInProgress && await git(workspace.path, ["rev-parse", "HEAD"]) === p.startHeadSha
    && !await git(workspace.path, ["status", "--porcelain"]);
  if (unchanged) updateRun(run.id, { publication: { status: "pending", commitSha: p.startHeadSha }, stage: "publishing" });
  else if (acceptance && !p.validated) {
    for (let round = 1; ; round++) {
      try { await validateAndCommit(ctx, p, acceptance); break; }
      catch (error) {
        if (!(error instanceof CheckFailure)) throw error;
        const sessionFile = getRun(run.id)!.piSessionFile ?? undefined;
        if (validationOnly || !p.agentInput || !sessionFile || round > config.harness.corrections.validation) throw error.cause;
        operation.log.warn({ event: "pi.validation_retry", round });
        updateRun(run.id, { stage: "agent" });
        const followUp = await executePi({ run, cwd: workspace.path, context: "", readOnly, tools: ctx.manifest.tools, scoped: ctx.manifest, log: operation.log, sessionFile, environment: p.environment, ...p.agentInput, followUp: validationMessage(error, round), stop });
        result = { ...followUp, text: `${result.text}\n\n**Validation correction ${round}:** ${followUp.text}`, paths: [...new Set([...result.paths, ...followUp.paths])] };
        updateRun(run.id, { result, stage: "validating" });
        assertComplete(result);
      }
    }
  }
}

async function publishStage({ task, run, subject, references, readOnly, manifest, repositoryPath }: Ctx, observed: Observed | undefined) {
  if (!observed) return subject.kind === "window" ? publishWindow(subject, task, run, references) : publishCommit(subject, task, run);
  const { repository, github, context, item, observation, mainSha } = observed;
  const evaluatedRun = getRun(run.id)!;
  const publicationContext = run.stage !== "publishing"
    ? await github.fetchItemContext(observation.kind, item.payload.number) : context;
  if (publicationContext.item.state !== "open") throw new Error("GitHub item is no longer open");
  let headOverride: string | undefined;
  if (!readOnly && "head" in publicationContext.item && evaluatedRun.context?.headSha) {
    const { sha } = publicationContext.item.head;
    if (sha !== evaluatedRun.context.headSha && sha !== evaluatedRun.publication.publishedCommitSha
      && sha !== evaluatedRun.publication.commitSha) throw new Error("GitHub PR head changed during execution");
    headOverride = evaluatedRun.context.headSha;
  }
  const current = observe(repository, publicationContext, headOverride);
  const currentMainSha = readOnly ? async () => run.stage === "publishing" ? mainSha
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
  const ctx = beginRun(claimed, stop);
  const { run, references, operation, cleanup } = ctx;
  try {
    const observed = await connect(ctx);
    if (run.stage !== "publishing") {
      stopBefore(stop, "workspace acquisition");
      const prepared = await acquireWorkspace(ctx, observed);
      if (!prepared.validationOnly) {
        await planAgent(ctx, observed, prepared);
        await mergeBehind(ctx, observed, prepared);
        if (!prepared.validated) {
          stopBefore(stop, "workspace preparation");
          await prepareCommands(ctx, observed, prepared);
          stopBefore(stop, "the agent");
          await agentStage(ctx, prepared);
        }
      }
      await validateStage(ctx, prepared);
      if (!ctx.acceptance) updateRun(run.id, { stage: "publishing" });
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
    const failed = finishRun(run.id, { status: "failed", error });
    operation.fail(error);
    return failed;
  } finally {
    if (cleanup.databaseRequested) {
      try { await removeRunDatabase(run.id, references); }
      catch { operation.log.warn({ event: "run.cleanup_pending", resource: "database" }); }
    }
    if (cleanup.reviewWorkspace) {
      try { await removeWorkspace(cleanup.reviewWorkspace.id, references); }
      catch { operation.log.warn({ event: "run.cleanup_pending", workspaceId: cleanup.reviewWorkspace.id }); }
    }
  }
}
