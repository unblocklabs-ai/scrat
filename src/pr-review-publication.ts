import { upsertComment } from "./comments.ts";
import { getRepositoryPath } from "./config.ts";
import type { EventReferences } from "./events.ts";
import { git } from "./git.ts";
import type { GitHubRepository } from "./github.ts";
import type { GithubContext } from "./github-types.ts";
import { botName } from "./identity.ts";
import { gradeLabels, reconcileLabels } from "./labels.ts";
import { isIssueComment, issueCommentId, reviewMarker, taskMarker, withMarker } from "./markers.ts";
import { observe, type ItemObservation } from "./observation.ts";
import { prReviewHistory, resolvePrReview } from "./pr-assessment.ts";
import { runHistory, updateRun } from "./run-history.ts";
import type { Run, Task } from "./schema.ts";
import { serialized } from "./single-flight.ts";

const pendingReviews = new Map<string, Promise<unknown>>();

function reviewBody(text: string, taskId: string) {
  return withMarker(text, reviewMarker, taskMarker(taskId));
}

function canonicalComment(own: ItemObservation["own"], reviews: ReturnType<typeof runHistory>) {
  const issueComments = own.filter(isIssueComment);
  for (const { run, task } of reviews) {
    const existing = issueComments.findLast((comment) => comment.id === issueCommentId(run.publication.commentId)
      || (run.result && comment.body === reviewBody(run.result.text, task.id)));
    if (existing) return existing;
  }
}

async function reconcile(github: GitHubRepository, subjectId: string, number: number, references: EventReferences, publication?: { task: Task; run: Run }, observed?: GithubContext) {
  const current = observed ?? await github.fetchItemContext("pr", number);
  const reviews = prReviewHistory(subjectId);
  const observation = observe(github.repository, current);
  const existing = canonicalComment(observation.own, reviews);
  const mainSha = await git(getRepositoryPath(), ["rev-parse", `refs/remotes/origin/${observation.baseBranch}`]);
  const state = await resolvePrReview(reviews, observation, mainSha);
  const desired = state.kind === "current" ? state.assessment : undefined;
  const shown = desired ?? (state.kind === "blocked" ? state.attempt : undefined);
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
    const body = desired ? reviewBody(desired.result.text, desired.task.id)
      : reviewBody(`This PR is behind ${observation.baseBranch} and does not merge cleanly; update the branch and ${botName} will review it.`, shown.task.id);
    const { run } = shown;
    commentId = await upsertComment(github, number, existing, body, deliveryReferences);
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

export const reconcileObserved = (github: GitHubRepository, subjectId: string, number: number, references: EventReferences, current: GithubContext) =>
  reconcile(github, subjectId, number, references, undefined, current);
