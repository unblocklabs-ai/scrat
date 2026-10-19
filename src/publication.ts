import { and, eq } from "drizzle-orm";
import { config } from "./config.ts";
import { db } from "./db.ts";
import type { EventReferences } from "./events.ts";
import { branchContainsCommit } from "./git.ts";
import { createPullRequest, fetchItemContext, findPullRequest, getGitEnvironment, postComment, updateComment } from "./github.ts";
import { gradeLabels, reconcileLabels } from "./labels.ts";
import { upsertItem } from "./items.ts";
import { items, runs, tasks } from "./schema.ts";
import { getWorkspace, pushWorkspace } from "./workspaces.ts";

export async function publishRun(task: typeof tasks.$inferSelect, run: typeof runs.$inferSelect, current: Awaited<ReturnType<typeof fetchItemContext>>, references: EventReferences) {
  const { result, context } = run;
  if (!result || !context) throw new Error("Run has no evaluated result to publish");
  if (result.outcome !== "complete") throw new Error("Incomplete agent work cannot be published");
  const repository = new URL(context.item.url).pathname.split("/").slice(1, 3).join("/");
  const remote = `https://github.com/${repository}.git`;
  const marker = `<!-- scrat-task:${task.id} -->`;
  let publication = run.publication;
  function saveReceipt(patch: Partial<typeof publication>, database: Pick<typeof db, "update"> = db) {
    publication = { ...publication, ...patch };
    database.update(runs).set({ publication }).where(eq(runs.id, run.id)).run();
  }
  const mutatesCode = task.action !== "review_issue" && task.action !== "review_pr";
  if (mutatesCode) {
    const workspace = run.workspaceId ? getWorkspace(run.workspaceId) : undefined;
    if (!workspace || workspace.removedAt) throw new Error("Publication workspace is no longer active");
    const commitSha = publication.commitSha;
    if (!commitSha) throw new Error("Run has no validated commit to publish");
    if (publication.publishedCommitSha !== commitSha) {
      const env = await getGitEnvironment(repository, true);
      if (!await branchContainsCommit(workspace.repositoryPath, remote, workspace.branch, commitSha, env)) {
        await pushWorkspace(workspace, remote, commitSha, env, references);
      }
      saveReceipt({ publishedCommitSha: commitSha });
    }
    if (task.action === "implement") {
      if (!publication.pullRequestNumber) {
        let pr: Awaited<ReturnType<typeof findPullRequest>> | Awaited<ReturnType<typeof createPullRequest>>["data"] = await findPullRequest(repository, workspace.branch, context.baseBranch);
        if (pr?.state === "closed") throw new Error("The workspace PR was already closed");
        pr ??= (await createPullRequest(repository, {
          title: `fix: ${context.item.title}`, body: `${result.text}\n\nCloses #${context.item.number}\n\n${marker}`,
          head: workspace.branch, base: context.baseBranch,
        }, references)).data;
        const publishedPr = pr;
        db.transaction((transaction) => {
          const created = upsertItem({ source: "github", externalId: publishedPr.node_id, kind: "pr", payload: publishedPr }, transaction);
          transaction.update(items).set({ workspaceId: workspace.id }).where(eq(items.id, created.id)).run();
          saveReceipt({ pullRequestNumber: publishedPr.number }, transaction);
        });
      }
      saveReceipt({ status: "published" });
      return;
    }
  }
  const reviewMarker = "<!-- scrat-review -->";
  const body = `${result.text}\n\n${task.action === "review_pr" ? reviewMarker + "\n" : ""}${marker}`;
  const reviews = task.action === "review_pr" ? db.select({ publication: runs.publication, taskId: tasks.id, createdAt: tasks.createdAt }).from(runs)
    .innerJoin(tasks, eq(runs.taskId, tasks.id)).where(and(eq(tasks.itemId, task.itemId), eq(tasks.action, "review_pr"))).all() : [];
  const reviewIds = new Set(reviews.flatMap(({ publication }) => publication.commentId ? [publication.commentId] : []));
  const existing = current.comments.findLast((comment) => comment.id.startsWith("issue:") && comment.author === config.github.botLogin
    && (comment.body.includes(marker) || (task.action === "review_pr"
      && (comment.body.includes(reviewMarker) || reviewIds.has(Number(comment.id.slice("issue:".length)))))));
  // A publication-only retry retains its original task order, not its new run's timestamp.
  if (existing && reviews.some((review) => review.publication.commentId === Number(existing.id.slice("issue:".length))
    && (review.createdAt > task.createdAt || (review.createdAt === task.createdAt && review.taskId > task.id)))) {
    saveReceipt({ status: "not_needed" });
    return;
  }
  if (!publication.commentId) {
    let commentId: number;
    if (existing) {
      commentId = Number(existing.id.slice("issue:".length));
      if (existing.body !== body) await updateComment(repository, commentId, body, references);
    } else {
      commentId = (await postComment(repository, context.item.number, body, references)).data.id;
    }
    saveReceipt({ commentId });
  }
  if (task.action === "review_issue") {
    await reconcileLabels(repository, context.item.number, {
      current: current.item.labels ?? [], desired: result.ready ? ["scrat"] : [], managed: ["scrat"],
    }, references);
    saveReceipt({ scratLabel: result.ready });
  }
  if (task.action === "review_pr" && result.grade) await reconcileLabels(repository, context.item.number, {
    current: current.item.labels ?? [], desired: [gradeLabels[result.grade]], managed: Object.values(gradeLabels),
  }, references);
  saveReceipt({ status: "published" });
}
