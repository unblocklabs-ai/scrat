import { and, desc, eq, isNotNull, ne } from "drizzle-orm";
import { actionContracts } from "./actions.ts";
import { config, getRepositoryPath } from "./config.ts";
import { runCommands } from "./commands.ts";
import { createRunDatabase, removeRunDatabase } from "./databases.ts";
import { db } from "./db.ts";
import { fetchPullRequestHead, fetchRepository, git, hasConflicts, hasPendingMerge } from "./git.ts";
import { GitHubRepository } from "./github.ts";
import { evaluateGithubContext } from "./github-context.ts";
import { startOperation } from "./logging.ts";
import { executePi } from "./pi.ts";
import { reviewPullRequest } from "./pr-review.ts";
import { publishRun } from "./publication.ts";
import { reviewChanges } from "./relevance.ts";
import { hasValidationCheckpoint } from "./results.ts";
import { items, runs } from "./schema.ts";
import { childEnvironment } from "./secrets.ts";
import { claimTask, finishRun } from "./tasks.ts";
import { assertNoCommittedSecrets, checkpointWorkspace, commitWorkspace, createWorkspace, getWorkspace, removeWorkspace, validateCheckpoint, validateWorkspace } from "./workspaces.ts";

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
    const repository = new URL(item.payload.html_url).pathname.split("/").slice(1, 3).join("/");
    const remote = `https://github.com/${repository}.git`;
    const repositoryPath = getRepositoryPath();
    const github = new GitHubRepository(repository);
    const context = await github.fetchItemContext(item.kind, item.payload.number);
    if (context.item.state !== "open") throw new Error("GitHub item is no longer open");
    const pullRequest = "head" in context.item ? context.item : undefined;
    const baseBranch = pullRequest?.base.ref ?? config.github.baseBranch;
    const gitEnvironment = await github.getGitEnvironment();
    const mainSha = await fetchRepository(repositoryPath, remote, baseBranch, gitEnvironment);
    const { comments, revision } = evaluateGithubContext(context, config.github.botLogin);
    if (run.stage !== "publishing") {
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
        if (readOnly || !hasValidationCheckpoint(run)) throw new Error("No complete agent checkpoint to resume; use normal retry to repair");
        if (!workspace || workspace.id !== run.workspaceId) throw new Error("Validation checkpoint workspace is no longer attached to this item");
        if (run.context.revision !== revision || run.context.baseBranch !== baseBranch || run.mainSha !== mainSha) {
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
      if (!readOnly && pullRequest && !mergeInProgress && !validationOnly) await git(workspace.path, ["merge", "--ff-only", preparedHead]);
      const headSha = await git(workspace.path, ["rev-parse", "HEAD"]);
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
      if (!validationOnly) {
        const previous = !readOnly ? db.select().from(runs).where(and(
          eq(runs.workspaceId, workspace.id), ne(runs.id, run.id), isNotNull(runs.piSessionFile),
        )).orderBy(desc(runs.startedAt)).limit(1).get() : undefined;
        const diff = pullRequest ? await git(repositoryPath, ["diff", `${mainSha}...${preparedHead}`]) : undefined;
        const diffBaseSha = pullRequest ? await git(repositoryPath, ["merge-base", mainSha, preparedHead]) : mainSha;
        const diffPaths = pullRequest ? (await git(repositoryPath, ["diff", "--name-only", "--no-renames", "-z", `${mainSha}...${preparedHead}`])).split("\0").filter(Boolean) : [];
        const requested = run.input.commentRevisions;
        const ids = new Set(Array.isArray(requested)
          ? requested.filter((entry: unknown): entry is string => typeof entry === "string").map((entry) => entry.split("@")[0]) : []);
        const evaluatedComments = contract.context === "feedback" && ids.size
          ? comments.filter((comment) => ids.has(comment.id)) : comments;
        const evaluated = {
          revision, baseBranch, headSha: pullRequest?.head.sha,
          item: { number: context.item.number, title: context.item.title, body: context.item.body, url: context.item.html_url },
          comments: evaluatedComments,
          commentRevisions: evaluatedComments.map((comment) => `${comment.id}@${comment.revision}`),
        };
        db.update(runs).set({ context: evaluated }).where(eq(runs.id, run.id)).run();
        const previousMainSha = task.input.previousMainSha;
        const previousHeadSha = task.input.previousHeadSha;
        const mainChanges = typeof previousMainSha === "string" && previousMainSha !== mainSha
          ? await git(repositoryPath, ["diff", previousMainSha, mainSha]) : undefined;
        const prChanges = pullRequest && typeof previousHeadSha === "string" && previousHeadSha !== headSha
          ? await git(repositoryPath, ["diff", previousHeadSha, headSha]) : undefined;
        const preparationDeferred = mergeInProgress || Boolean(run.retryOfRunId);
        if (readOnly || !preparationDeferred) {
          await runCommands(config.workspace?.prepare ?? [], workspace.path, commandEnvironment, references);
          if (databaseConfig) await runCommands([databaseConfig.migrate], workspace.path, commandEnvironment, references);
        }
        db.update(runs).set({ stage: "agent" }).where(eq(runs.id, run.id)).run();
        const input = { ...run.input };
        delete input.comments;
        const prompt = JSON.stringify({
          action: task.action,
          reason: task.reason,
          ...evaluated,
          input,
          previousFailure: run.retryOfRunId ? db.select().from(runs).where(eq(runs.id, run.retryOfRunId)).get()?.error : undefined,
          workspace: { path: workspace.path, branch: workspace.branch, baseRef, baseBranch, mainSha, headSha, mergeInProgress },
          diff, diffBaseSha, diffPaths, mainChanges, prChanges,
          database: database ? {
            ...database, environment, schemaPrepared: !preparationDeferred,
            prepare: config.workspace?.prepare, migrate: databaseConfig?.migrate,
          } : undefined,
        }, null, 2);
        const agentResult = contract.agent === "panel"
          ? await reviewPullRequest(run, workspace.path, prompt, operation.log, diffBaseSha)
          : await executePi({ run, cwd: workspace.path, context: prompt, readOnly, log: operation.log, sessionFile: previous?.piSessionFile ?? undefined, environment });
        result = { ...agentResult, paths: [...new Set([...diffPaths, ...agentResult.paths])] };
        db.update(runs).set({ result, stage: "validating" }).where(eq(runs.id, run.id)).run();
      }
      if (!result) throw new Error("No saved agent result to validate");
      if (result.outcome !== "complete") {
        throw Object.assign(new Error(`Agent returned ${result.outcome}: ${result.text}`), { code: "AGENT_INCOMPLETE" });
      }
      if (!readOnly) {
        if (!validationOnly) db.update(runs).set({ agentCheckpoint: await checkpointWorkspace(workspace) }).where(eq(runs.id, run.id)).run();
        await runCommands(config.workspace?.prepare ?? [], workspace.path, commandEnvironment, references);
        if (databaseConfig) await runCommands([databaseConfig.migrate], workspace.path, commandEnvironment, references);
        const checkpoint = await checkpointWorkspace(workspace);
        db.update(runs).set({ agentCheckpoint: checkpoint }).where(eq(runs.id, run.id)).run();
        const validationTree = checkpoint.treeSha;
        const commands = await runCommands(config.workspace?.validate ?? [], workspace.path, commandEnvironment, references);
        await git(workspace.path, ["add", "--all"]);
        if (await git(workspace.path, ["write-tree"]) !== validationTree) throw new Error("Validation changed the source tree; revalidate the resulting changes");
        // A validation-only retry keeps the original run's pre-agent head.
        await assertNoCommittedSecrets(workspace, validationOnly ? run.headSha ?? baseRef : headSha, validationTree);
        const commitSha = await commitWorkspace(workspace, `fix: ${context.item.title}`, {
          name: config.github.botLogin, email: `${config.github.botLogin}@users.noreply.github.com`,
        }, references);
        if (await git(workspace.path, ["rev-parse", `${commitSha}^{tree}`]) !== validationTree) throw new Error("Committed tree differs from the validated tree; revalidation required");
        db.update(runs).set({ headSha: commitSha, publication: { status: "pending", commitSha }, verification: { headSha: commitSha, commands } }).where(eq(runs.id, run.id)).run();
        if (contract.acceptance === "conflict-free" && await hasConflicts(repositoryPath, mainSha, commitSha)) {
          throw new Error("PR still conflicts with its base branch after resolution");
        }
        if (contract.acceptance === "nonempty-diff" && !await git(workspace.path, ["diff", "--name-only", `${baseRef}...HEAD`])) {
          throw new Error("Implementation produced no changes against the base branch");
        }
      }
      db.update(runs).set({ stage: "publishing" }).where(eq(runs.id, run.id)).run();
    }
    const evaluatedRun = db.select().from(runs).where(eq(runs.id, run.id)).get()!;
    const publicationContext = run.stage !== "publishing"
      ? await github.fetchItemContext(item.kind, item.payload.number) : context;
    if (publicationContext.item.state !== "open") throw new Error("GitHub item is no longer open");
    const currentBaseBranch = "head" in publicationContext.item ? publicationContext.item.base.ref : config.github.baseBranch;
    let revisionItem = publicationContext.item;
    if (!readOnly && "head" in revisionItem && evaluatedRun.context?.headSha) {
      if (revisionItem.head.sha !== evaluatedRun.context.headSha && revisionItem.head.sha !== evaluatedRun.publication.publishedCommitSha
        && revisionItem.head.sha !== evaluatedRun.publication.commitSha) throw new Error("GitHub PR head changed during execution");
      revisionItem = { ...revisionItem, head: { ...revisionItem.head, sha: evaluatedRun.context.headSha } };
    }
    const { revision: currentRevision } = evaluateGithubContext({ ...publicationContext, item: revisionItem }, config.github.botLogin);
    if (contract.publication !== "pr-assessment" && (evaluatedRun.context?.revision !== currentRevision
      || evaluatedRun.context.baseBranch !== currentBaseBranch)) {
      throw new Error("GitHub task context changed; enqueue a fresh task instead of retrying publication");
    }
    if (readOnly) {
      const currentMainSha = run.stage === "publishing" ? mainSha
        : await fetchRepository(repositoryPath, remote, currentBaseBranch, await github.getGitEnvironment());
      if (contract.publication !== "pr-assessment" && evaluatedRun.mainSha && evaluatedRun.mainSha !== currentMainSha) {
        const changes = await reviewChanges(repositoryPath, evaluatedRun.mainSha, currentMainSha, evaluatedRun.result?.paths ?? []);
        if (changes.relevant) throw new Error("Reviewed code changed; enqueue a fresh review instead of retrying publication");
      }
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
