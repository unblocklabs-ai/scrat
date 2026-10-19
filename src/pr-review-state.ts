import { eq } from "drizzle-orm";
import { config, getRepositoryPath } from "./config.ts";
import { db } from "./db.ts";
import type { EventReferences } from "./events.ts";
import { git } from "./git.ts";
import { fetchItemContext, postComment, updateComment, type GithubComment } from "./github.ts";
import { gradeLabels, reconcileLabels } from "./labels.ts";
import { prReviewHistory, resolvePrReview } from "./pr-assessment.ts";
import { runs, tasks } from "./schema.ts";

type Run = typeof runs.$inferSelect;
type Task = typeof tasks.$inferSelect;
// One serve process owns delivery; serialize its poller and worker calls per PR.
const pendingReviews = new Map<string, Promise<void>>();
const reviewMarker = "<!-- scrat-review -->";

function reviewBody(text: string, taskId: string) {
  return `${text}\n\n${reviewMarker}\n<!-- scrat-task:${taskId} -->`;
}

function canonicalComment(comments: GithubComment[], reviews: ReturnType<typeof prReviewHistory>) {
  const own = comments.filter((comment) => comment.id.startsWith("issue:") && comment.author === config.github.botLogin);
  for (const { run, task } of reviews) {
    // Receipts identify physical comments, not assessment authority. Recover lost
    // responses only from a complete rendered report, never a quoted marker.
    const existing = own.findLast((comment) => comment.id === `issue:${run.publication.commentId}`
      || (run.result && comment.body === reviewBody(run.result.text, task.id)));
    if (existing) return existing;
  }
}

async function reconcile(repository: string, itemId: string, number: number, references: EventReferences, publication?: { task: Task; run: Run }) {
  const current = await fetchItemContext(repository, "pr", number);
  const reviews = prReviewHistory(itemId);
  const existing = canonicalComment(current.comments, reviews);
  const baseBranch = "base" in current.item ? current.item.base.ref : config.github.baseBranch;
  const mainSha = await git(getRepositoryPath(), ["rev-parse", `refs/remotes/origin/${baseBranch}`]);
  const state = await resolvePrReview(reviews, current, mainSha);
  const desired = state.kind === "current" ? state.assessment : undefined;
  const deliveryReferences = desired ? { ...references, itemId, taskId: desired.task.id, runId: desired.run.id } : references;
  let labels = current.item.labels ?? [];
  const body = desired ? reviewBody(desired.result.text, desired.task.id) : undefined;
  const replacing = desired && existing?.body !== body;
  if (!desired || replacing) {
    // GitHub cannot atomically replace a report and its grade. Prefer no grade
    // over a grade attached to the wrong report if either write fails.
    await reconcileLabels(repository, number, { current: labels, desired: [], managed: Object.values(gradeLabels) }, deliveryReferences);
    const managed = new Set<string>(Object.values(gradeLabels).map((name) => name.toLowerCase()));
    labels = labels.filter((label) => !managed.has((typeof label === "string" ? label : label.name ?? "").toLowerCase()));
  }
  if (publication && !desired) throw new Error("Reviewed code changed or PR context changed; enqueue a fresh review");

  if (desired && body) {
    const { run } = desired;
    let commentId: number;
    if (existing) {
      commentId = Number(existing.id.slice("issue:".length));
      if (existing.body !== body) await updateComment(repository, commentId, body, deliveryReferences);
    } else commentId = (await postComment(repository, number, body, deliveryReferences)).data.id;
    run.publication = { ...run.publication, commentId };
    db.update(runs).set({ publication: run.publication }).where(eq(runs.id, run.id)).run();
  }

  const grade = desired?.result.grade;
  await reconcileLabels(repository, number, {
    current: labels, desired: grade ? [gradeLabels[grade]] : [], managed: Object.values(gradeLabels),
  }, deliveryReferences);
  if (desired) db.update(runs).set({ publication: { ...desired.run.publication, status: "published" } })
    .where(eq(runs.id, desired.run.id)).run();
  if (publication && publication.run.id !== desired?.run.id) db.update(runs).set({ publication: { ...publication.run.publication, status: "not_needed" } })
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
