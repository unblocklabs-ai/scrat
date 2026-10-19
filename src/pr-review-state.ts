import { and, desc, eq } from "drizzle-orm";
import { config, getRepositoryPath } from "./config.ts";
import { db } from "./db.ts";
import type { EventReferences } from "./events.ts";
import { git } from "./git.ts";
import { fetchItemContext, githubRevision, postComment, updateComment, type GithubComment } from "./github.ts";
import { gradeLabels, reconcileLabels } from "./labels.ts";
import { reviewChanges } from "./relevance.ts";
import { runs, tasks } from "./schema.ts";

type Run = typeof runs.$inferSelect;
type Task = typeof tasks.$inferSelect;
const pendingReviews = new Map<string, Promise<void>>();
const reviewMarker = "<!-- scrat-review -->";

function reviewHistory(itemId: string) {
  return db.select({ run: runs, task: tasks }).from(runs).innerJoin(tasks, eq(runs.taskId, tasks.id))
    .where(and(eq(tasks.itemId, itemId), eq(tasks.action, "review_pr")))
    .orderBy(desc(tasks.createdAt), desc(tasks.id), desc(runs.startedAt), desc(runs.id)).all();
}

function canonicalComment(comments: GithubComment[], reviews: ReturnType<typeof reviewHistory>) {
  const own = comments.filter((comment) => comment.id.startsWith("issue:") && comment.author === config.github.botLogin);
  for (const { run } of reviews) {
    const recorded = own.find((comment) => comment.id === `issue:${run.publication.commentId}`);
    if (recorded) return recorded;
  }
  // Recover a lost write response from our own footer, never a quoted marker in prose.
  return own.findLast((comment) => {
    const footer = comment.body.trimEnd().match(/\n<!-- scrat-review -->\n<!-- scrat-task:([^\n>]+) -->$/);
    return footer && reviews.some(({ task }) => task.id === footer[1]);
  });
}

async function reconcile(repository: string, itemId: string, number: number, references: EventReferences, publication?: { task: Task; run: Run }) {
  const current = await fetchItemContext(repository, "pr", number);
  const reviews = reviewHistory(itemId);
  const existing = canonicalComment(current.comments, reviews);
  const baseBranch = "base" in current.item ? current.item.base.ref : config.github.baseBranch;
  const mainSha = await git(getRepositoryPath(), ["rev-parse", `refs/remotes/origin/${baseBranch}`]);
  const comments = current.comments.filter((comment) => comment.author !== config.github.botLogin && comment.body.trim());
  const revision = githubRevision(current.item, comments);
  async function applicable(run: Run) {
    if (current.item.state !== "open" || run.context?.revision !== revision || run.context.baseBranch !== baseBranch || !run.mainSha) return false;
    return run.mainSha === mainSha || !(await reviewChanges(getRepositoryPath(), run.mainSha, mainSha, run.result?.paths ?? [])).relevant;
  }

  if (publication) {
    const { task, run } = publication;
    const newer = reviews.some((review) => review.run.publication.commentId
      && (review.task.createdAt > task.createdAt || (review.task.createdAt === task.createdAt && review.task.id > task.id)));
    if (newer) {
      db.update(runs).set({ publication: { ...run.publication, status: "not_needed" } }).where(eq(runs.id, run.id)).run();
      return;
    }
    if (!await applicable(run)) throw new Error("Reviewed code or PR context changed; enqueue a fresh review");
    const body = `${run.result!.text}\n\n${reviewMarker}\n<!-- scrat-task:${task.id} -->`;
    let commentId: number;
    if (existing) {
      commentId = Number(existing.id.slice("issue:".length));
      if (existing.body !== body) await updateComment(repository, commentId, body, references);
    } else commentId = (await postComment(repository, number, body, references)).data.id;
    run.publication = { ...run.publication, commentId };
    db.update(runs).set({ publication: run.publication }).where(eq(runs.id, run.id)).run();
  }

  const latest = reviewHistory(itemId).find(({ run }) => run.publication.commentId && run.result?.outcome === "complete");
  const grade = latest && await applicable(latest.run) ? latest.run.result?.grade : undefined;
  await reconcileLabels(repository, number, {
    current: current.item.labels ?? [], desired: grade ? [gradeLabels[grade]] : [], managed: Object.values(gradeLabels),
  }, references);
  if (publication) db.update(runs).set({ publication: { ...publication.run.publication, status: "published" } })
    .where(eq(runs.id, publication.run.id)).run();
}

export async function reconcilePrReview(repository: string, itemId: string, number: number, references: EventReferences = {}, publication?: { task: Task; run: Run }) {
  const key = `${repository}#${number}`;
  const previous = pendingReviews.get(key);
  const pending = (async () => {
    if (previous) await previous.catch(() => {});
    await reconcile(repository, itemId, number, references, publication);
  })();
  pendingReviews.set(key, pending);
  try { await pending; }
  finally { if (pendingReviews.get(key) === pending) pendingReviews.delete(key); }
}
