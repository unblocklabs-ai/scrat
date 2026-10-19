import { and, desc, eq, isNotNull, ne } from "drizzle-orm";
import { config, getRepositoryPath } from "./config.ts";
import { db } from "./db.ts";
import { fetchPullRequestHead, fetchRepository, git, hasConflicts } from "./git.ts";
import { fetchItemContext, getGitEnvironment, githubRevision } from "./github.ts";
import { startOperation } from "./logging.ts";
import { executePi } from "./pi.ts";
import { publishRun } from "./publication.ts";
import { affectsPaths } from "./relevance.ts";
import { items, runs } from "./schema.ts";
import { claimTask, finishRun } from "./tasks.ts";
import { commitWorkspace, createWorkspace, getWorkspace, removeWorkspace } from "./workspaces.ts";

export async function runNextTask() {
  const claimed = claimTask();
  if (!claimed) return;
  const { task, run, item } = claimed;
  const references = { itemId: item.id, taskId: task.id, runId: run.id };
  const operation = startOperation("run.execute", { ...references, action: task.action });
  const readOnly = task.action === "review_issue" || task.action === "review_pr";
  let reviewWorkspace: Awaited<ReturnType<typeof createWorkspace>> | undefined;
  try {
    const repository = new URL(item.payload.html_url).pathname.split("/").slice(1, 3).join("/");
    const remote = `https://github.com/${repository}.git`;
    const repositoryPath = getRepositoryPath();
    const context = await fetchItemContext(repository, item.kind, item.payload.number, operation.log);
    if (context.item.state !== "open") throw new Error("GitHub item is no longer open");
    const pullRequest = "head" in context.item ? context.item : undefined;
    const baseBranch = pullRequest?.base.ref ?? config.github.baseBranch;
    const gitEnvironment = await getGitEnvironment(repository);
    const mainSha = await fetchRepository(repositoryPath, remote, baseBranch, gitEnvironment);
    const comments = context.comments.filter((comment) => comment.author !== config.github.botLogin && comment.body.trim());
    const revision = githubRevision(context.item, comments);
    if (run.stage === "publishing" && run.result && run.context) {
      if (readOnly) {
        if (run.context.revision !== revision) throw new Error("GitHub review context changed; enqueue a fresh review instead of retrying publication");
        if (run.mainSha && run.mainSha !== mainSha) {
          const changed = (await git(repositoryPath, ["diff", "--name-only", "--no-renames", run.mainSha, mainSha])).split("\n").filter(Boolean);
          if (affectsPaths(changed, run.result.paths)) throw new Error("Reviewed code changed; enqueue a fresh review instead of retrying publication");
        }
      }
    } else {
      const baseRef = mainSha;
      const headRef = pullRequest
        ? await fetchPullRequestHead(repositoryPath, remote, pullRequest.number, gitEnvironment)
        : baseRef;
      const preparedHead = await git(repositoryPath, ["rev-parse", headRef]);
      let workspace = !readOnly && item.workspaceId ? getWorkspace(item.workspaceId) : undefined;
      if (workspace?.removedAt) throw new Error(`Workspace was removed: ${workspace.id}`);
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
      if (!readOnly && pullRequest) await git(workspace.path, ["merge", "--ff-only", preparedHead]);
      const headSha = await git(workspace.path, ["rev-parse", "HEAD"]);
      db.update(runs).set({ workspaceId: workspace.id, mainSha, headSha, stage: "agent" }).where(eq(runs.id, run.id)).run();
      const previous = !readOnly ? db.select().from(runs).where(and(
        eq(runs.workspaceId, workspace.id), ne(runs.id, run.id), isNotNull(runs.piSessionFile), isNotNull(runs.result),
      )).orderBy(desc(runs.startedAt)).limit(1).get() : undefined;
      const diff = pullRequest ? await git(repositoryPath, ["diff", `${mainSha}...${preparedHead}`]) : undefined;
      const requested = run.input.commentRevisions;
      const ids = new Set(Array.isArray(requested)
        ? requested.filter((entry: unknown): entry is string => typeof entry === "string").map((entry) => entry.split("@")[0]) : []);
      const evaluatedComments = task.action === "address_pr_feedback" && ids.size
        ? comments.filter((comment) => ids.has(comment.id)) : comments;
      const evaluated = {
        revision, baseBranch,
        item: { number: context.item.number, title: context.item.title, body: context.item.body, url: context.item.html_url },
        comments: evaluatedComments,
        commentRevisions: evaluatedComments.map((comment) => `${comment.id}@${comment.updatedAt}`),
      };
      db.update(runs).set({ context: evaluated }).where(eq(runs.id, run.id)).run();
      const previousMainSha = task.input.previousMainSha;
      const previousHeadSha = task.input.previousHeadSha;
      const mainChanges = typeof previousMainSha === "string" && previousMainSha !== mainSha
        ? await git(repositoryPath, ["diff", previousMainSha, mainSha]) : undefined;
      const prChanges = pullRequest && typeof previousHeadSha === "string" && previousHeadSha !== headSha
        ? await git(repositoryPath, ["diff", previousHeadSha, headSha]) : undefined;
      const result = await executePi(run, workspace.path, JSON.stringify({
        action: task.action,
        reason: task.reason,
        ...evaluated,
        input: run.input,
        previousFailure: run.retryOfRunId ? db.select().from(runs).where(eq(runs.id, run.retryOfRunId)).get()?.error : undefined,
        workspace: { path: workspace.path, branch: workspace.branch, baseRef, baseBranch, mainSha, headSha },
        diff,
        mainChanges,
        prChanges,
      }, null, 2), readOnly, operation.log, previous?.piSessionFile ?? undefined);
      db.update(runs).set({ result, stage: "validating" }).where(eq(runs.id, run.id)).run();
      if (!readOnly) {
        const commitSha = await commitWorkspace(workspace, `fix: ${context.item.title}`, {
          name: config.github.botLogin, email: `${config.github.botLogin}@users.noreply.github.com`,
        }, references);
        db.update(runs).set({ headSha: commitSha, publication: { status: "pending", commitSha } }).where(eq(runs.id, run.id)).run();
        if (task.action === "resolve_conflicts" && await hasConflicts(repositoryPath, mainSha, commitSha)) {
          throw new Error("PR still conflicts with its base branch after resolution");
        }
        if (task.action === "implement" && !await git(workspace.path, ["diff", "--name-only", `${baseRef}...HEAD`])) {
          throw new Error("Implementation produced no changes against the base branch");
        }
      }
      db.update(runs).set({ stage: "publishing" }).where(eq(runs.id, run.id)).run();
    }
    await publishRun(task, db.select().from(runs).where(eq(runs.id, run.id)).get()!, context, references);
    finishRun(run.id, { status: "completed" });
    operation.complete();
    return db.select().from(runs).where(eq(runs.id, run.id)).get()!;
  } catch (error) {
    const failed = finishRun(run.id, { status: "failed", error });
    operation.fail(error);
    return failed;
  } finally {
    if (reviewWorkspace) {
      try { await removeWorkspace(reviewWorkspace.id, references); }
      catch { operation.log.warn({ event: "run.cleanup_pending", workspaceId: reviewWorkspace.id }); }
    }
  }
}
