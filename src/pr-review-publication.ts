import { upsertComment } from "./comments.ts";
import { getRepositoryPath } from "./config.ts";
import { redactSecrets } from "./errors.ts";
import type { EventReferences } from "./events.ts";
import { git } from "./git.ts";
import type { GitHubRepository } from "./github.ts";
import type { GithubContext } from "./github-types.ts";
import { botName } from "./identity.ts";
import { gradeLabels, reconcileLabels } from "./labels.ts";
import { acknowledgedTaskIds, isIssueComment, issueCommentId, parseIssueCommentId, reviewMarker, taskMarker, withMarker } from "./markers.ts";
import { logger } from "./logging.ts";
import { observe, type ItemObservation } from "./observation.ts";
import { prReviewHistory, resolvePrReview, type PrReviewState } from "./pr-assessment.ts";
import { getRun, runHistory, runText, updateRun } from "./run-history.ts";
import type { Run, Task } from "./schema.ts";
import { serialized } from "./single-flight.ts";
import { latestTask } from "./tasks.ts";

const pendingReviews = new Map<string, Promise<unknown>>();

function reviewBody(text: string, taskId: string) {
  return withMarker(text, reviewMarker, taskMarker(taskId));
}

function canonicalComment(own: ItemObservation["own"], reviews: ReturnType<typeof runHistory>) {
  const issueComments = own.filter(isIssueComment);
  for (const { run, task } of reviews) {
    let body: string | undefined;
    const existing = issueComments.findLast((comment) => comment.id === issueCommentId(run.publication.commentId)
      || (run.result && comment.body === (body ??= reviewBody(runText(run.id), task.id))));
    if (existing) return existing;
  }
  const taskIds = new Set(reviews.map(({ task }) => task.id));
  return issueComments.findLast((comment) => acknowledgedTaskIds(comment.body)
    .some((id) => taskIds.has(id) && comment.body.trimEnd().endsWith(`${reviewMarker}\n${taskMarker(id)}`)));
}

export type ResolvedReview = { reviews: ReturnType<typeof runHistory>; state: PrReviewState; mainSha: string };

async function reconcile(github: GitHubRepository, subjectId: string, number: number, references: EventReferences, publication?: { task: Task; run: Run }, observed?: GithubContext, known?: ResolvedReview) {
  const current = observed ?? await github.fetchItemContext("pr", number);
  const reviews = known?.reviews ?? prReviewHistory(subjectId);
  const observation = observe(current);
  const existing = canonicalComment(observation.own, reviews);
  const mainSha = await git(getRepositoryPath(), ["rev-parse", `refs/remotes/origin/${observation.baseBranch}`]);
  const state = known?.mainSha === mainSha ? known.state : await resolvePrReview(reviews, observation, mainSha);
  const desired = state.kind === "current" ? state.assessment : undefined;
  const latest = reviews[0];
  const failed = latest?.task.status === "failed" && latest.run.error && latest.run.finishedAt
    && latestTask(subjectId, latest.task.action)?.id === latest.task.id
    && (latest.run.context?.revision ?? latest.task.input.revision ?? observation.revision) === observation.revision
    && (latest.run.mainSha ?? latest.task.input.mainSha ?? mainSha) === mainSha ? latest : undefined;
  const shown = desired ?? (state.kind === "blocked" ? state.attempt : failed);
  const deliveryReferences = shown ? { ...references, subjectId, taskId: shown.task.id, runId: shown.run.id } : references;
  const labels = observation.labels;
  const managed = Object.values(gradeLabels);
  const grade = desired?.result.grade;
  const gradeLabel = grade ? [gradeLabels[grade]] : [];
  const kept = gradeLabel.filter((name) => labels.includes(name));
  await reconcileLabels(github, number, { current: labels, desired: kept, managed }, deliveryReferences);
  if (publication && !desired) throw new Error("Reviewed code changed or PR context changed; enqueue a fresh review");

  let commentId: number | undefined;
  if (shown) {
    let text: string;
    if (desired) text = runText(desired.run.id);
    else if (state.kind === "blocked") text = `This PR is behind ${observation.baseBranch} and does not merge cleanly; update the branch and ${botName} will review it.`;
    else {
      let error = getRun(shown.run.id)!.error!;
      while (error.cause) error = error.cause;
      const reason = redactSecrets(error.message).replace(/\s+/g, " ").slice(0, 500);
      text = `${botName} review failed during the **${shown.run.stage}** stage. No completed assessment was published by this attempt.\n\n> ${reason}\n\nAutomatic retry is not scheduled for this failure. Retry task \`${shown.task.id}\` with \`npm run retry -- ${shown.task.id}\`, or push an update to request a fresh review.`;
    }
    const body = reviewBody(text, shown.task.id);
    const { run } = shown;
    const unchanged = existing && acknowledgedTaskIds(existing.body).some((id) => existing.body === reviewBody(text, id));
    if (existing && unchanged) logger.info({ ...deliveryReferences, event: "review.unchanged" });
    commentId = existing && unchanged ? parseIssueCommentId(existing.id) : await upsertComment(github, number, existing, body, deliveryReferences);
    updateRun(run.id, { publication: { ...run.publication, commentId } });
  }

  await reconcileLabels(github, number, {
    current: kept, desired: gradeLabel, managed,
  }, deliveryReferences);
  if (desired) updateRun(desired.run.id, { publication: { ...desired.run.publication, commentId, status: "published" } });
  if (publication && publication.run.id !== desired?.run.id) updateRun(publication.run.id, { publication: { ...publication.run.publication, status: "not_needed" } });
}

export const serializePr = <T>(github: GitHubRepository, number: number, work: () => Promise<T>) =>
  serialized(pendingReviews, `${github.repository}#${number}`, work);

export const reconcilePrReview = (github: GitHubRepository, subjectId: string, number: number, references: EventReferences = {}, publication?: { task: Task; run: Run }) =>
  serializePr(github, number, () => reconcile(github, subjectId, number, references, publication));

export const reconcileObserved = (github: GitHubRepository, subjectId: string, number: number, references: EventReferences, current: GithubContext, known?: ResolvedReview) =>
  reconcile(github, subjectId, number, references, undefined, current, known);
