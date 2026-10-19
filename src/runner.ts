import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { and, desc, eq, isNotNull, ne } from "drizzle-orm";
import { config } from "./config.ts";
import { db } from "./db.ts";
import { fetchPullRequestHead, fetchRepository, git, hasConflicts } from "./git.ts";
import { addLabels, createPullRequest, fetchItemContext, getGitEnvironment, githubRevision, postComment, removeLabels } from "./github.ts";
import { upsertItem } from "./items.ts";
import { startOperation } from "./logging.ts";
import { executePi } from "./pi.ts";
import { items, runs, tasks } from "./schema.ts";
import { claimTask, finishRun } from "./tasks.ts";
import { commitWorkspace, createWorkspace, getWorkspace, pushWorkspace, removeWorkspace } from "./workspaces.ts";

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
    const repositoryPath = resolve(fileURLToPath(new URL("..", import.meta.url)), config.github.repositoryPath);
    const context = await fetchItemContext(repository, item.kind, item.payload.number, operation.log);
    if (context.item.state !== "open") throw new Error("GitHub item is no longer open");
    const pullRequest = "head" in context.item ? context.item : undefined;
    const baseBranch = pullRequest?.base.ref ?? config.github.baseBranch;
    const gitEnvironment = await getGitEnvironment(repository);
    const mainSha = await fetchRepository(repositoryPath, remote, baseBranch, gitEnvironment);
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
    const comments = context.comments.filter((comment) => comment.author !== config.github.botLogin && comment.body.trim());
    const revision = githubRevision(context.item, comments);
    const input = {
      ...task.input, revision, mainSha,
      ...(readOnly ? { triggerKey: JSON.stringify({ revision, mainSha }) } : {}),
      ...(task.action === "address_pr_feedback" && !task.input.comments ? {
        commentRevisions: comments.map((comment) => `${comment.id}@${comment.updatedAt}`),
      } : {}),
    };
    db.update(tasks).set({ input }).where(eq(tasks.id, task.id)).run();
    const previousMainSha = task.input.previousMainSha;
    const previousHeadSha = task.input.previousHeadSha;
    const mainChanges = typeof previousMainSha === "string" && previousMainSha !== mainSha
      ? await git(repositoryPath, ["diff", previousMainSha, mainSha]) : undefined;
    const prChanges = pullRequest && typeof previousHeadSha === "string" && previousHeadSha !== headSha
      ? await git(repositoryPath, ["diff", previousHeadSha, headSha]) : undefined;
    const result = await executePi(run, workspace.path, JSON.stringify({
      action: task.action,
      reason: task.reason,
      item: { number: context.item.number, title: context.item.title, body: context.item.body, url: context.item.html_url },
      comments: task.action === "address_pr_feedback" && task.input.comments
        ? task.input.comments : comments,
      input,
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
    if (!readOnly) {
      await pushWorkspace(workspace, remote, await getGitEnvironment(repository, true), references);
    }
    if (task.action === "implement") {
      const existing = db.select().from(items).where(and(eq(items.workspaceId, workspace.id), eq(items.kind, "pr"), eq(items.state, "open"))).get();
      let pullRequestNumber = existing?.payload.number;
      if (!existing) {
        const response = await createPullRequest(repository, {
          title: `fix: ${context.item.title}`, body: `${result.text}\n\nCloses #${context.item.number}`,
          head: workspace.branch, base: baseBranch,
        }, references);
        pullRequestNumber = response.data.number;
        const created = upsertItem({ source: "github", externalId: response.data.node_id, kind: "pr", payload: response.data });
        db.update(items).set({ workspaceId: workspace.id }).where(eq(items.id, created.id)).run();
      }
      const current = db.select().from(runs).where(eq(runs.id, run.id)).get()!;
      db.update(runs).set({ publication: { ...current.publication, status: "published", pullRequestNumber } }).where(eq(runs.id, run.id)).run();
    } else {
      const response = await postComment(repository, context.item.number, result.text, references);
      const current = db.select().from(runs).where(eq(runs.id, run.id)).get()!;
      db.update(runs).set({ publication: { ...current.publication, status: "published", commentId: response.data.id } }).where(eq(runs.id, run.id)).run();
      if (task.action === "review_issue") {
        const labelled = context.item.labels?.some((label) => typeof label === "string" ? label === "scrat" : label.name === "scrat");
        if (result.ready && !labelled) await addLabels(repository, context.item.number, ["scrat"], references);
        if (!result.ready && labelled) await removeLabels(repository, context.item.number, ["scrat"], references);
      }
    }
    if (reviewWorkspace) {
      await removeWorkspace(reviewWorkspace.id, references);
      reviewWorkspace = undefined;
    }
    finishRun(run.id, { status: "completed" });
    operation.complete();
    return db.select().from(runs).where(eq(runs.id, run.id)).get()!;
  } catch (error) {
    if (reviewWorkspace) {
      try { await removeWorkspace(reviewWorkspace.id, references); }
      catch (cleanupError) { operation.log.error({ err: cleanupError, event: "run.cleanup_failed", workspaceId: reviewWorkspace.id }, "Review workspace cleanup failed"); }
    }
    const failed = finishRun(run.id, { status: "failed", error });
    operation.fail(error);
    return failed;
  }
}
