import { actionsPublishing } from "./actions.ts";
import { upsertComment } from "./comments.ts";
import { getRepositoryPath } from "./config.ts";
import type { EventReferences } from "./events.ts";
import { git } from "./git.ts";
import type { GitHubRepository } from "./github.ts";
import type { GithubContext } from "./github-types.ts";
import { gradeLabels, reconcileLabels } from "./labels.ts";
import { isIssueComment, issueCommentId, reviewMarker, taskMarker } from "./markers.ts";
import { observe, type ItemObservation } from "./observation.ts";
import { resolvePrReview } from "./pr-assessment.ts";
import { runHistory, updateRun } from "./run-history.ts";
import type { Run, Task } from "./schema.ts";
import { serialized } from "./single-flight.ts";

const pendingReviews = new Map<string, Promise<unknown>>();

function reviewBody(text: string, taskId: string) {
  return `${text}\n\n${reviewMarker}\n${taskMarker(taskId)}`;
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
  const reviews = runHistory(subjectId, actionsPublishing("pr_assessment"));
  const observation = observe(github.repository, current);
  const existing = canonicalComment(observation.own, reviews);
  const mainSha = await git(getRepositoryPath(), ["rev-parse", `refs/remotes/origin/${observation.baseBranch}`]);
  const state = await resolvePrReview(reviews, observation, mainSha);
  const desired = state.kind === "current" ? state.assessment : undefined;
  const managed = Object.values(gradeLabels);
  const labels = observation.labels;
  if (!desired) {
    await reconcileLabels(github, number, { current: labels, desired: [], managed }, references);
    if (publication) throw new Error("Reviewed code changed or PR context changed; enqueue a fresh review");
    return;
  }
  const deliveryReferences = { ...references, subjectId, taskId: desired.task.id, runId: desired.run.id };
  const { run } = desired;
  const body = reviewBody(desired.result.text, desired.task.id);
  const grade = desired.result.grade;
  const gradeLabel = grade ? [gradeLabels[grade]] : [];
  const kept = gradeLabel.filter((name) => labels.includes(name));
  await reconcileLabels(github, number, { current: labels, desired: kept, managed }, deliveryReferences);
  const commentId = await upsertComment(github, number, existing, body, deliveryReferences);
  run.publication = { ...run.publication, commentId };
  updateRun(run.id, { publication: run.publication });

  await reconcileLabels(github, number, {
    current: labels.filter((label) => !managed.includes(label) || kept.includes(label)), desired: gradeLabel, managed,
  }, deliveryReferences);
  updateRun(run.id, { publication: { ...run.publication, status: "published" } });
  if (publication && publication.run.id !== run.id) updateRun(publication.run.id, { publication: { ...publication.run.publication, status: "not_needed" } });
}

export const serializePr = <T>(github: GitHubRepository, number: number, work: () => Promise<T>) =>
  serialized(pendingReviews, `${github.repository}#${number}`, work);

export const reconcilePrReview = (github: GitHubRepository, subjectId: string, number: number, references: EventReferences = {}, publication?: { task: Task; run: Run }) =>
  serializePr(github, number, () => reconcile(github, subjectId, number, references, publication));

export const reconcileObserved = (github: GitHubRepository, subjectId: string, number: number, references: EventReferences, current: GithubContext) =>
  reconcile(github, subjectId, number, references, undefined, current);
