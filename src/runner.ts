import { and, desc, eq, isNotNull, ne } from "drizzle-orm";
import { actionContracts, type Action } from "./actions.ts";
import { buildAgentInput, evaluateContext, readDiffScope } from "./agent-input.ts";
import { describeCommit, publishCommit, startCommitThread } from "./commit-review.ts";
import { config, getActionConfig, getRepositoryPath, isBotLogin } from "./config.ts";
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
import { assertConfiguredRepository, itemRepository } from "./repository.ts";
import { executePi } from "./pi.ts";
import { prReviewHistory, resolvePrReview } from "./pr-assessment.ts";
import { reviewPullRequest } from "./pr-review.ts";
import { publishRun } from "./publication.ts";
import { assertComplete, type AgentResult, CheckFailure, hasValidationCheckpoint } from "./results.ts";
import { items, runs, tasks, workspaces } from "./schema.ts";
import { childEnvironment } from "./secrets.ts";
import { claimTask, finishRun } from "./tasks.ts";
import { assertNoCommittedSecrets, checkpointWorkspace, commitWorkspace, createWorkspace, getWorkspace, removeWorkspace, validateCheckpoint, validateWorkspace } from "./workspaces.ts";

type Workspace = Awaited<ReturnType<typeof createWorkspace>>;
type DatabaseConfig = NonNullable<NonNullable<typeof config.workspace>["database"]>;
type Environment = Record<string, string | undefined>;
type References = { itemId: string; taskId: string; runId: string };
type Acceptance = "conflict-free" | "nonempty-diff" | "complete";

const maxValidationCorrections = 2;

const botAuthor = () => ({ name: config.github.botLogin, email: `${config.github.botLogin}@users.noreply.github.com` });

async function prepareWorkspace(workspace: Workspace, environment: Environment, databaseConfig: DatabaseConfig | null | undefined, references: References) {
  await runCommands(config.workspace?.prepare ?? [], workspace.path, environment, references);
  if (databaseConfig) await runCommands([databaseConfig.migrate], workspace.path, environment, references);
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
  const { message, exitCode, stdout, stderr } = describeError(error.cause);
  const tail = (label: string, text?: string) => text?.trim() ? `\n${label} (last 6000 characters):\n${text.trim().slice(-6000)}\n` : "";
  return `${botName}'s validation failed after your changes (round ${round} of ${maxValidationCorrections}).\n\nCommand: ${message.split("\n")[0].replace(/^Command failed: /, "")}\nExit code: ${exitCode ?? "unknown"}\n${tail("stdout", stdout)}${tail("stderr", stderr)}\nFix only what is reported. ${botName} re-validates after your turn, so a full rerun of the failing check is not needed. Then end your turn with one or two sentences on what you changed to fix this (it is appended to your earlier handoff), and the usual SCRAT_STATUS footer (add SCRAT_READY if the change is still ready).`;
}

const unresolvedConflict = "PR still conflicts with its base branch after resolution";

async function validateAndCommit({ run, references, repositoryPath }: Ctx, p: Prepared, kind: Acceptance) {
  const { workspace, commandEnvironment } = p;
  if (!p.validationOnly) db.update(runs).set({ agentCheckpoint: await checkpointWorkspace(workspace) }).where(eq(runs.id, run.id)).run();
  await asCheckFailure(() => prepareWorkspace(workspace, commandEnvironment, p.databaseConfig, references));
  const checkpoint = await checkpointWorkspace(workspace);
  db.update(runs).set({ agentCheckpoint: checkpoint }).where(eq(runs.id, run.id)).run();
  const validationTree = checkpoint.treeSha;
  const commands = await asCheckFailure(() => withValidationSlot(() => runCommands(config.workspace?.validate ?? [], workspace.path, commandEnvironment, references), references));
  await git(workspace.path, ["add", "--all"]);
  if (await git(workspace.path, ["write-tree"]) !== validationTree) throw new Error("Validation changed the source tree; revalidate the resulting changes");
  await assertNoCommittedSecrets(workspace, p.validationOnly ? run.headSha ?? p.baseRef : p.startHeadSha, validationTree);
  const message = /^[a-z]+(\([^)]*\))?!?: /.test(p.title) ? p.title : `fix: ${p.title}`;
  const commitSha = await commitWorkspace(workspace, message, botAuthor(), references);
  if (await git(workspace.path, ["rev-parse", `${commitSha}^{tree}`]) !== validationTree) throw new Error("Committed tree differs from the validated tree; revalidation required");
  db.update(runs).set({ headSha: commitSha, publication: { status: "pending", commitSha }, verification: { headSha: commitSha, commands } }).where(eq(runs.id, run.id)).run();
  if (kind === "conflict-free" && await hasConflicts(repositoryPath, p.mainSha, commitSha)) {
    throw new Error(unresolvedConflict);
  }
  if (kind === "nonempty-diff" && !await git(workspace.path, ["diff", "--name-only", `${p.baseRef}...HEAD`])) {
    throw new Error("Implementation produced no changes against the base branch");
  }
}

type Ctx = {
  task: typeof tasks.$inferSelect; run: typeof runs.$inferSelect; item: typeof items.$inferSelect;
  references: References; operation: ReturnType<typeof startOperation>;
  contract: typeof actionContracts[Action]; repositoryPath: string;
  readOnly: boolean; acceptance: Acceptance | undefined;
  cleanup: { reviewWorkspace?: Workspace; databaseRequested: boolean };
};
type Observed = {
  repository: string; github: GitHubRepository; context: GithubContext; pullRequest: GithubPullRequest | undefined;
  observation: ItemObservation; gitEnvironment: NodeJS.ProcessEnv; mainSha: string;
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

function beginRun({ task, run, item }: NonNullable<ReturnType<typeof claimTask>>): Ctx {
  const references = { itemId: item.id, taskId: task.id, runId: run.id };
  const { action } = task;
  const operation = startOperation("run.execute", { ...references, action });
  const contract = actionContracts[action];
  return {
    task, run, item, references, operation, contract, repositoryPath: getRepositoryPath(),
    readOnly: contract.mode === "review", acceptance: contract.mode === "change" ? contract.acceptance : undefined,
    cleanup: { databaseRequested: false },
  };
}

async function connect({ item, repositoryPath }: Ctx): Promise<Observed | undefined> {
  if (item.kind === "commit") return;
  const repository = itemRepository(item) ?? item.payload.html_url;
  assertConfiguredRepository(repository);
  const github = new GitHubRepository(repository);
  const context = await github.fetchItemContext(item.kind, item.payload.number);
  if (context.item.state !== "open") throw new Error("GitHub item is no longer open");
  const pullRequest = "head" in context.item ? context.item : undefined;
  const observation = observe(repository, context);
  const gitEnvironment = await github.getGitEnvironment();
  const mainSha = await fetchRepository(repositoryPath, observation.remote, observation.baseBranch, gitEnvironment);
  return { repository, github, context, pullRequest, observation, gitEnvironment, mainSha };
}

async function acquireItemWorkspace(ctx: Ctx, observed: Observed) {
  const { task, run, item, references, readOnly, repositoryPath, cleanup } = ctx;
  const { repository, context, pullRequest, observation, gitEnvironment, mainSha } = observed;
  if (typeof task.input.assessmentRunId === "string") {
    const state = await resolvePrReview(prReviewHistory(item.id), observation, mainSha);
    if (state.kind !== "current" || state.assessment.originId !== task.input.assessmentRunId) {
      throw new Error("The review this repair addresses is no longer the current assessment");
    }
  }
  const validationOnly = run.stage === "validating";
  const baseRef = mainSha;
  const headRef = pullRequest
    ? await fetchPullRequestHead(repositoryPath, observation.remote, pullRequest.number, gitEnvironment)
    : baseRef;
  const preparedHead = await git(repositoryPath, ["rev-parse", headRef]);
  let workspace = !readOnly && item.workspaceId ? getWorkspace(item.workspaceId) : undefined;
  if (workspace?.removedAt) throw new Error(`Workspace was removed: ${workspace.id}`);
  if (workspace) await validateWorkspace(workspace);
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
    else db.update(items).set({ workspaceId: workspace.id }).where(eq(items.id, item.id)).run();
  }
  const mergeInProgress = !readOnly && await hasPendingMerge(workspace.path);
  if (!readOnly && !mergeInProgress && !validationOnly) {
    if (pullRequest) await git(workspace.path, ["merge", "--ff-only", preparedHead]);
    else {
      try {
        await git(workspace.path, ["merge", "--ff-only", preparedHead]);
        if (await git(workspace.path, ["rev-parse", "HEAD"]) === preparedHead) {
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

async function acquireCommitWorkspace({ item, run, references, repositoryPath, operation, cleanup }: Ctx) {
  const { sha } = await startCommitThread(item, run.input, operation.log);
  const workspace = await createWorkspace({ repositoryPath, baseRef: sha }, references);
  cleanup.reviewWorkspace = workspace;
  return { workspace, validationOnly: false, mergeInProgress: false, mainSha: sha, baseRef: sha, preparedHead: sha, startHeadSha: sha, title: item.payload.title };
}

async function acquireWorkspace(ctx: Ctx, observed: Observed | undefined): Promise<Prepared> {
  const { run, references, readOnly, cleanup } = ctx;
  const acquired = observed ? await acquireItemWorkspace(ctx, observed) : await acquireCommitWorkspace(ctx);
  const { workspace, validationOnly, mainSha, startHeadSha } = acquired;
  if (!validationOnly) db.update(runs).set({ workspaceId: workspace.id, mainSha, headSha: startHeadSha }).where(eq(runs.id, run.id)).run();
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

async function planAgent({ task, run, item, readOnly, acceptance, repositoryPath }: Ctx, observed: Observed | undefined, p: Prepared) {
  const previous = !readOnly ? db.select().from(runs).where(and(
    eq(runs.workspaceId, p.workspace.id), ne(runs.id, run.id), isNotNull(runs.piSessionFile),
  )).orderBy(desc(runs.sequence)).limit(1).get() : undefined;
  const { evaluated, diffPaths, diffBaseSha } = observed
    ? { evaluated: evaluateContext(run, task, observed.observation), ...await readDiffScope(repositoryPath, p.mainSha, p.preparedHead, Boolean(observed.pullRequest)) }
    : await describeCommit(repositoryPath, item, run.input);
  db.update(runs).set({ context: evaluated }).where(eq(runs.id, run.id)).run();
  Object.assign(p, {
    evaluated, diffPaths, diffBaseSha, previousSessionFile: previous?.piSessionFile ?? undefined,
    deferred: p.mergeInProgress || Boolean(run.retryOfRunId) || acceptance === "conflict-free",
  });
}

async function mergeBehind(ctx: Ctx, observed: Observed | undefined, p: Prepared) {
  const { run, acceptance, repositoryPath } = ctx;
  if (!observed || acceptance !== "conflict-free" || p.mergeInProgress || run.retryOfRunId || !await behindCleanly(repositoryPath, p.mainSha, p.headSha)) return;
  const { baseBranch } = observed.observation;
  await mergeBase(p.workspace.path, p.mainSha, `Merge ${baseBranch} into ${observed.pullRequest!.head.ref}`, botAuthor());
  p.headSha = await git(p.workspace.path, ["rev-parse", "HEAD"]);
  p.result = { text: `Merged ${baseBranch} (${p.mainSha.slice(0, 7)}) into this branch; no conflicts`, ready: false, paths: [...new Set(p.diffPaths)], outcome: "complete" };
  db.update(runs).set({ result: p.result, stage: "validating" }).where(eq(runs.id, run.id)).run();
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
    if (!pullRequest || !(humanReview || !readOnly) || await isAncestor(repositoryPath, p.mainSha, p.headSha)) throw error;
    if (await hasConflicts(repositoryPath, p.mainSha, p.headSha)) {
      if (!readOnly) throw error;
      throw new Error(`PR branch is behind ${baseBranch} and does not merge cleanly; the author needs to update it`);
    }
    if (readOnly) {
      const synthetic = await createMergeCommit(repositoryPath, p.mainSha, p.headSha, `Review merge of ${baseBranch} into the PR head`, botAuthor());
      cleanup.reviewWorkspace = undefined;
      try { await removeWorkspace(p.workspace.id, references); }
      catch { operation.log.warn({ event: "run.cleanup_pending", workspaceId: p.workspace.id }); }
      p.workspace = cleanup.reviewWorkspace = await createWorkspace({ repositoryPath, baseRef: synthetic }, references);
      db.update(runs).set({ workspaceId: p.workspace.id }).where(eq(runs.id, run.id)).run();
      p.headSha = synthetic;
      p.diffBaseSha = p.mainSha;
    } else {
      await mergeBase(p.workspace.path, p.mainSha, `Merge ${baseBranch} into ${pullRequest.head.ref}`, botAuthor()).catch(() => { throw error; });
      p.headSha = await git(p.workspace.path, ["rev-parse", "HEAD"]);
    }
    await prepareWorkspace(p.workspace, p.commandEnvironment, p.databaseConfig, references);
  }
}

async function agentStage({ task, run, contract, readOnly, operation }: Ctx, observed: Observed | undefined, p: Prepared) {
  const { action } = task;
  const { workspace, environment } = p;
  const configured = getActionConfig(action);
  const changeContext = contract.context === "change";
  db.update(runs).set({ stage: "agent" }).where(eq(runs.id, run.id)).run();
  const { prompt, contextDir, revisions } = await buildAgentInput({
    run, task, evaluated: p.evaluated!, diffBaseSha: p.diffBaseSha, diffPaths: p.diffPaths, mainSha: p.mainSha, headSha: p.headSha,
    baseRef: p.baseRef, mergeInProgress: p.mergeInProgress, workspace, validationFailure: p.validationFailure,
    scratAuthored: isBotLogin(observed?.pullRequest?.user?.login),
    database: p.database ? {
      ...p.database, environment, schemaPrepared: !p.deferred,
      prepare: config.workspace?.prepare, migrate: p.databaseConfig?.migrate,
    } : undefined,
  });
  p.agentInput = { contextDir, revisions };
  const agentResult = ("agent" in configured ? configured.agent : contract.agent) === "panel"
    ? await reviewPullRequest(run, workspace.path, prompt, operation.log, { baseSha: p.diffBaseSha, contextDir, revisions, requireGrade: !changeContext })
    : await executePi({ run, cwd: workspace.path, context: prompt, readOnly, log: operation.log, sessionFile: p.previousSessionFile, environment, contextDir, revisions, baseSha: changeContext ? p.diffBaseSha : undefined });
  p.result = { ...agentResult, paths: [...new Set([...p.diffPaths, ...agentResult.paths])] };
  db.update(runs).set({ result: p.result, stage: "validating" }).where(eq(runs.id, run.id)).run();
}

async function validateStage(ctx: Ctx, p: Prepared) {
  const { run, operation, readOnly, acceptance } = ctx;
  const { workspace, validationOnly } = p;
  let { result } = p;
  if (!result) throw new Error("No saved agent result to validate");
  assertComplete(result);
  const unchanged = acceptance === "complete" && !p.validated && !validationOnly
    && p.startHeadSha === p.preparedHead && !p.mergeInProgress && await git(workspace.path, ["rev-parse", "HEAD"]) === p.startHeadSha
    && !await git(workspace.path, ["status", "--porcelain"]);
  if (unchanged) db.update(runs).set({ publication: { status: "pending", commitSha: p.startHeadSha } }).where(eq(runs.id, run.id)).run();
  else if (acceptance && !p.validated) {
    for (let round = 1; ; round++) {
      try { await validateAndCommit(ctx, p, acceptance); break; }
      catch (error) {
        if (!(error instanceof CheckFailure)) throw error;
        const sessionFile = db.select().from(runs).where(eq(runs.id, run.id)).get()!.piSessionFile ?? undefined;
        if (validationOnly || !p.agentInput || !sessionFile || round > maxValidationCorrections) throw error.cause;
        operation.log.warn({ event: "pi.validation_retry", round });
        db.update(runs).set({ stage: "agent" }).where(eq(runs.id, run.id)).run();
        const followUp = await executePi({ run, cwd: workspace.path, context: "", readOnly, log: operation.log, sessionFile, environment: p.environment, ...p.agentInput, followUp: validationMessage(error, round) });
        result = { ...followUp, text: `${result.text}\n\n**Validation correction ${round}:** ${followUp.text}`, paths: [...new Set([...result.paths, ...followUp.paths])] };
        db.update(runs).set({ result, stage: "validating" }).where(eq(runs.id, run.id)).run();
        assertComplete(result);
      }
    }
  }
}

async function publishStage({ task, run, item, references, readOnly, contract, repositoryPath }: Ctx, observed: Observed | undefined) {
  if (!observed) return publishCommit(item, run);
  const { repository, github, context, observation, mainSha } = observed;
  const evaluatedRun = db.select().from(runs).where(eq(runs.id, run.id)).get()!;
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
  if (contract.publication === "pr-assessment") await currentMainSha?.();
  else {
    const state = await freshness(savedEvaluation(evaluatedRun), { ...current, mainSha: currentMainSha }, "relevant-paths", { unknownBase: "current" });
    if (state.kind === "stale") throw new Error(state.reason === "context"
      ? "GitHub task context changed; enqueue a fresh task instead of retrying publication"
      : "Reviewed code changed; enqueue a fresh review instead of retrying publication");
  }
  await publishRun(github, task, evaluatedRun, publicationContext, references);
}

export async function runNextTask() {
  const claimed = claimTask();
  if (!claimed) return;
  const ctx = beginRun(claimed);
  const { run, references, operation, cleanup } = ctx;
  try {
    const observed = await connect(ctx);
    if (run.stage !== "publishing") {
      const prepared = await acquireWorkspace(ctx, observed);
      if (!prepared.validationOnly) {
        await planAgent(ctx, observed, prepared);
        await mergeBehind(ctx, observed, prepared);
        if (!prepared.validated) {
          await prepareCommands(ctx, observed, prepared);
          await agentStage(ctx, observed, prepared);
        }
      }
      await validateStage(ctx, prepared);
      db.update(runs).set({ stage: "publishing" }).where(eq(runs.id, run.id)).run();
    }
    await publishStage(ctx, observed);
    finishRun(run.id, { status: "completed" });
    operation.complete();
    return db.select().from(runs).where(eq(runs.id, run.id)).get()!;
  } catch (error) {
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
