import { and, desc, eq, isNotNull, ne } from "drizzle-orm";
import { actionContracts } from "./actions.ts";
import { buildAgentInput, evaluateContext, readDiffScope } from "./agent-input.ts";
import { config, getRepositoryPath } from "./config.ts";
import { runCommands, withValidationSlot } from "./commands.ts";
import { createRunDatabase, removeRunDatabase } from "./databases.ts";
import { db } from "./db.ts";
import { describeError, type ErrorDetails } from "./errors.ts";
import { behindCleanly, createMergeCommit, fetchPullRequestHead, fetchRepository, git, hasConflicts, hasPendingMerge, isAncestor, mergeBase } from "./git.ts";
import { GitHubRepository } from "./github.ts";
import { freshness, savedEvaluation } from "./freshness.ts";
import { startOperation } from "./logging.ts";
import { assertConfiguredRepository, itemRepository, observe } from "./observation.ts";
import { executePi } from "./pi.ts";
import { prReviewHistory, resolvePrReview } from "./pr-assessment.ts";
import { reviewPullRequest } from "./pr-review.ts";
import { publishRun } from "./publication.ts";
import { CheckFailure, hasValidationCheckpoint, type AgentResult } from "./results.ts";
import { items, runs, workspaces } from "./schema.ts";
import { childEnvironment } from "./secrets.ts";
import { claimTask, finishRun } from "./tasks.ts";
import { assertNoCommittedSecrets, checkpointWorkspace, commitWorkspace, createWorkspace, getWorkspace, removeWorkspace, validateCheckpoint, validateWorkspace } from "./workspaces.ts";

type Workspace = Awaited<ReturnType<typeof createWorkspace>>;
type DatabaseConfig = NonNullable<NonNullable<typeof config.workspace>["database"]>;
type Environment = Record<string, string | undefined>;
type References = { itemId: string; taskId: string; runId: string };

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
  return `Scrat's validation failed after your changes (round ${round} of ${maxValidationCorrections}).\n\nCommand: ${message.split("\n")[0].replace(/^Command failed: /, "")}\nExit code: ${exitCode ?? "unknown"}\n${tail("stdout", stdout)}${tail("stderr", stderr)}\nFix only what is reported. Scrat re-validates after your turn, so a full rerun of the failing check is not needed. Then end your turn with your complete final handoff (it becomes the PR or comment text) and the usual SCRAT_STATUS footer.`;
}

function assertComplete(result: AgentResult) {
  if (result.outcome !== "complete") {
    throw Object.assign(new Error(`Agent returned ${result.outcome}: ${result.text}`), { code: "AGENT_INCOMPLETE" });
  }
}

const unresolvedConflict = "PR still conflicts with its base branch after resolution";

async function validateAndCommit(options: {
  run: typeof runs.$inferSelect; workspace: Workspace; validationOnly: boolean; title: string;
  commandEnvironment: Environment; databaseConfig: DatabaseConfig | null | undefined; references: References; secretBaseSha: string;
  acceptance: { kind: "conflict-free" | "nonempty-diff" | "complete"; repositoryPath: string; mainSha: string; baseRef: string };
}) {
  const { run, workspace, commandEnvironment, references, acceptance } = options;
  if (!options.validationOnly) db.update(runs).set({ agentCheckpoint: await checkpointWorkspace(workspace) }).where(eq(runs.id, run.id)).run();
  await asCheckFailure(() => prepareWorkspace(workspace, commandEnvironment, options.databaseConfig, references));
  const checkpoint = await checkpointWorkspace(workspace);
  db.update(runs).set({ agentCheckpoint: checkpoint }).where(eq(runs.id, run.id)).run();
  const validationTree = checkpoint.treeSha;
  const commands = await asCheckFailure(() => withValidationSlot(() => runCommands(config.workspace?.validate ?? [], workspace.path, commandEnvironment, references), references));
  await git(workspace.path, ["add", "--all"]);
  if (await git(workspace.path, ["write-tree"]) !== validationTree) throw new Error("Validation changed the source tree; revalidate the resulting changes");
  await assertNoCommittedSecrets(workspace, options.secretBaseSha, validationTree);
  const message = /^[a-z]+(\([^)]*\))?!?: /.test(options.title) ? options.title : `fix: ${options.title}`;
  const commitSha = await commitWorkspace(workspace, message, botAuthor(), references);
  if (await git(workspace.path, ["rev-parse", `${commitSha}^{tree}`]) !== validationTree) throw new Error("Committed tree differs from the validated tree; revalidation required");
  db.update(runs).set({ headSha: commitSha, publication: { status: "pending", commitSha }, verification: { headSha: commitSha, commands } }).where(eq(runs.id, run.id)).run();
  if (acceptance.kind === "conflict-free" && await hasConflicts(acceptance.repositoryPath, acceptance.mainSha, commitSha)) {
    throw new Error(unresolvedConflict);
  }
  if (acceptance.kind === "nonempty-diff" && !await git(workspace.path, ["diff", "--name-only", `${acceptance.baseRef}...HEAD`])) {
    throw new Error("Implementation produced no changes against the base branch");
  }
}

export async function runNextTask() {
  const claimed = claimTask();
  if (!claimed) return;
  const { task, run, item } = claimed;
  const references = { itemId: item.id, taskId: task.id, runId: run.id };
  const operation = startOperation("run.execute", { ...references, action: task.action });
  const contract = actionContracts[task.action];
  const readOnly = contract.mode === "review";
  let reviewWorkspace: Awaited<ReturnType<typeof createWorkspace>> | undefined;
  let databaseRequested = false;
  try {
    const repository = itemRepository(item) ?? item.payload.html_url;
    assertConfiguredRepository(repository);
    const repositoryPath = getRepositoryPath();
    const github = new GitHubRepository(repository);
    const context = await github.fetchItemContext(item.kind, item.payload.number);
    if (context.item.state !== "open") throw new Error("GitHub item is no longer open");
    const pullRequest = "head" in context.item ? context.item : undefined;
    const observation = observe(repository, context);
    const { remote, baseBranch } = observation;
    const gitEnvironment = await github.getGitEnvironment();
    const mainSha = await fetchRepository(repositoryPath, remote, baseBranch, gitEnvironment);
    if (run.stage !== "publishing") {
      if (task.action === "address_review") {
        const state = await resolvePrReview(prReviewHistory(item.id), observation, mainSha);
        if (state.kind !== "current" || state.assessment.originId !== task.input.assessmentRunId) {
          throw new Error("The review this repair addresses is no longer the current assessment");
        }
      }
      const validationOnly = run.stage === "validating";
      const baseRef = mainSha;
      const headRef = pullRequest
        ? await fetchPullRequestHead(repositoryPath, remote, pullRequest.number, gitEnvironment)
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
        if (readOnly) reviewWorkspace = workspace;
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
            operation.log.warn({ event: "workspace.base_update_skipped", workspaceId: workspace.id, err: error });
          }
        }
      }
      const startHeadSha = await git(workspace.path, ["rev-parse", "HEAD"]);
      let headSha = startHeadSha;
      if (!validationOnly) db.update(runs).set({ workspaceId: workspace.id, mainSha, headSha }).where(eq(runs.id, run.id)).run();
      const databaseConfig = !readOnly ? config.workspace?.database : undefined;
      let database: Awaited<ReturnType<typeof createRunDatabase>> | undefined;
      if (databaseConfig) {
        databaseRequested = true;
        database = await createRunDatabase(run.id, databaseConfig.image, references);
      }
      const environment = { ...config.workspace?.environment,
        ...Object.fromEntries((databaseConfig?.environment ?? []).map((name) => [name, database!.url])),
      };
      const commandEnvironment = { ...childEnvironment(), ...environment };
      let result = run.result;
      const validate = (target: Workspace, kind: "conflict-free" | "nonempty-diff" | "complete") => validateAndCommit({
        run, workspace: target, validationOnly, title: context.item.title, commandEnvironment, databaseConfig, references,
        secretBaseSha: validationOnly ? run.headSha ?? baseRef : startHeadSha,
        acceptance: { kind, repositoryPath, mainSha, baseRef },
      });
      let validated = false, validationFailure: ErrorDetails | undefined;
      let agentInput: { contextDir: string; revisions: Record<string, string> } | undefined;
      if (!validationOnly) {
        const previous = !readOnly ? db.select().from(runs).where(and(
          eq(runs.workspaceId, workspace.id), ne(runs.id, run.id), isNotNull(runs.piSessionFile),
        )).orderBy(desc(runs.sequence)).limit(1).get() : undefined;
        const scope = await readDiffScope(repositoryPath, mainSha, preparedHead, Boolean(pullRequest));
        const { diffPaths } = scope;
        let { diffBaseSha } = scope;
        const evaluated = evaluateContext(run, task, observation);
        db.update(runs).set({ context: evaluated }).where(eq(runs.id, run.id)).run();
        const preparationDeferred = mergeInProgress || Boolean(run.retryOfRunId) || task.action === "resolve_conflicts";
        if (contract.mode === "change" && task.action === "resolve_conflicts" && !mergeInProgress && !run.retryOfRunId
          && await behindCleanly(repositoryPath, mainSha, headSha)) {
          await mergeBase(workspace.path, mainSha, `Merge ${baseBranch} into ${pullRequest!.head.ref}`, botAuthor());
          headSha = await git(workspace.path, ["rev-parse", "HEAD"]);
          result = { text: `Merged ${baseBranch} (${mainSha.slice(0, 7)}) into this branch; no conflicts`, ready: false, paths: [...new Set(diffPaths)], outcome: "complete" };
          db.update(runs).set({ result, stage: "validating" }).where(eq(runs.id, run.id)).run();
          try {
            await validate(workspace, contract.acceptance);
            validated = true;
          } catch (error) {
            if (!(error instanceof CheckFailure) && !(error instanceof Error && error.message === unresolvedConflict)) throw error;
            validationFailure = describeError(error instanceof CheckFailure ? error.cause : error);
          }
        }
        if (!validated) {
          if (readOnly || !preparationDeferred) {
            try { await prepareWorkspace(workspace, commandEnvironment, databaseConfig, references); }
            catch (error) {
              const humanReview = readOnly && context.item.user?.login !== config.github.botLogin;
              if (!pullRequest || !(humanReview || !readOnly) || await isAncestor(repositoryPath, mainSha, headSha)) throw error;
              if (await hasConflicts(repositoryPath, mainSha, headSha)) {
                if (!readOnly) throw error;
                throw new Error(`PR branch is behind ${baseBranch} and does not merge cleanly; the author needs to update it`);
              }
              if (readOnly) {
                const synthetic = await createMergeCommit(repositoryPath, mainSha, headSha, `Review merge of ${baseBranch} into the PR head`, botAuthor());
                reviewWorkspace = undefined;
                try { await removeWorkspace(workspace.id, references); }
                catch { operation.log.warn({ event: "run.cleanup_pending", workspaceId: workspace.id }); }
                workspace = reviewWorkspace = await createWorkspace({ repositoryPath, baseRef: synthetic }, references);
                db.update(runs).set({ workspaceId: workspace.id }).where(eq(runs.id, run.id)).run();
                headSha = synthetic;
                diffBaseSha = mainSha;
              } else {
                await mergeBase(workspace.path, mainSha, `Merge ${baseBranch} into ${pullRequest.head.ref}`, botAuthor()).catch(() => { throw error; });
                headSha = await git(workspace.path, ["rev-parse", "HEAD"]);
              }
              await prepareWorkspace(workspace, commandEnvironment, databaseConfig, references);
            }
          }
          db.update(runs).set({ stage: "agent" }).where(eq(runs.id, run.id)).run();
          const { prompt, contextDir, revisions } = await buildAgentInput({
            run, task, evaluated, diffBaseSha, diffPaths, mainSha, headSha, baseRef, mergeInProgress, workspace, validationFailure,
            database: database ? {
              ...database, environment, schemaPrepared: !preparationDeferred,
              prepare: config.workspace?.prepare, migrate: databaseConfig?.migrate,
            } : undefined,
          });
          agentInput = { contextDir, revisions };
          const agentResult = contract.agent === "panel"
            ? await reviewPullRequest(run, workspace.path, prompt, operation.log, { baseSha: diffBaseSha, contextDir, revisions })
            : await executePi({ run, cwd: workspace.path, context: prompt, readOnly, log: operation.log, sessionFile: previous?.piSessionFile ?? undefined, environment, contextDir, revisions });
          result = { ...agentResult, paths: [...new Set([...diffPaths, ...agentResult.paths])] };
          db.update(runs).set({ result, stage: "validating" }).where(eq(runs.id, run.id)).run();
        }
      }
      if (!result) throw new Error("No saved agent result to validate");
      assertComplete(result);
      const unchanged = !readOnly && !validated && !validationOnly && contract.mode === "change" && contract.acceptance === "complete"
        && startHeadSha === preparedHead && !mergeInProgress && await git(workspace.path, ["rev-parse", "HEAD"]) === startHeadSha
        && !await git(workspace.path, ["status", "--porcelain"]);
      if (unchanged) db.update(runs).set({ publication: { status: "pending", commitSha: startHeadSha } }).where(eq(runs.id, run.id)).run();
      else if (!readOnly && !validated) {
        for (let round = 1; ; round++) {
          try { await validate(workspace, contract.acceptance); break; }
          catch (error) {
            if (!(error instanceof CheckFailure)) throw error;
            const sessionFile = db.select().from(runs).where(eq(runs.id, run.id)).get()!.piSessionFile ?? undefined;
            if (validationOnly || !agentInput || !sessionFile || round > maxValidationCorrections) throw error.cause;
            operation.log.warn({ event: "pi.validation_retry", round });
            db.update(runs).set({ stage: "agent" }).where(eq(runs.id, run.id)).run();
            const followUp = await executePi({ run, cwd: workspace.path, context: "", readOnly, log: operation.log, sessionFile, environment, ...agentInput, followUp: validationMessage(error, round) });
            result = { ...followUp, paths: [...new Set([...result.paths, ...followUp.paths])] };
            db.update(runs).set({ result, stage: "validating" }).where(eq(runs.id, run.id)).run();
            assertComplete(result);
          }
        }
      }
      db.update(runs).set({ stage: "publishing" }).where(eq(runs.id, run.id)).run();
    }
    const evaluatedRun = db.select().from(runs).where(eq(runs.id, run.id)).get()!;
    const publicationContext = run.stage !== "publishing"
      ? await github.fetchItemContext(item.kind, item.payload.number) : context;
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
      : await fetchRepository(repositoryPath, remote, current.baseBranch, await github.getGitEnvironment()) : undefined;
    if (contract.publication === "pr-assessment") await currentMainSha?.();
    else {
      const state = await freshness(savedEvaluation(evaluatedRun), { ...current, mainSha: currentMainSha }, "relevant-paths", { unknownBase: "current" });
      if (state.kind === "stale") throw new Error(state.reason === "context"
        ? "GitHub task context changed; enqueue a fresh task instead of retrying publication"
        : "Reviewed code changed; enqueue a fresh review instead of retrying publication");
    }
    await publishRun(github, task, evaluatedRun, publicationContext, references);
    finishRun(run.id, { status: "completed" });
    operation.complete();
    return db.select().from(runs).where(eq(runs.id, run.id)).get()!;
  } catch (error) {
    const failed = finishRun(run.id, { status: "failed", error });
    operation.fail(error);
    return failed;
  } finally {
    if (databaseRequested) {
      try { await removeRunDatabase(run.id, references); }
      catch { operation.log.warn({ event: "run.cleanup_pending", resource: "database" }); }
    }
    if (reviewWorkspace) {
      try { await removeWorkspace(reviewWorkspace.id, references); }
      catch { operation.log.warn({ event: "run.cleanup_pending", workspaceId: reviewWorkspace.id }); }
    }
  }
}
