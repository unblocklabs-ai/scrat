import type { Action } from "./actions.ts";
import type { Freshness } from "./freshness.ts";
import type { PrReviewState } from "./pr-assessment.ts";
import type { runs, tasks } from "./schema.ts";

type TaskFacts = Pick<typeof tasks.$inferSelect, "status" | "input">;
type Run = typeof runs.$inferSelect;
type ReviewAttempt = Pick<Run, "mainSha"> & {
  context: Pick<NonNullable<Run["context"]>, "revision"> | null;
};
type PreviousReview = ReviewAttempt & Pick<Run, "headSha">;
type QueueInput = Record<string, unknown> & { triggerKey: string };
export type RoutingDecision =
  | { type: "enqueue"; action: Action; reason: string; input: QueueInput }
  | { type: "cancel"; action: Action; reason: string };

function queue(latest: TaskFacts | undefined, action: Action, reason: string, input: QueueInput): RoutingDecision[] {
  if (latest?.status !== "cancelled" && latest?.input.triggerKey === input.triggerKey) return [];
  return [{ type: "enqueue", action, reason, input }];
}

export function planIssueTasks({ labelled, implemented, workspaceId, previouslyLabelled, latest, updatedAt, mainSha }: {
  labelled: boolean; implemented: boolean; workspaceId: string | null; previouslyLabelled?: boolean;
  latest?: TaskFacts; updatedAt: string; mainSha: string;
}): { review: boolean; decisions: RoutingDecision[] } {
  if (!labelled) return { review: true, decisions: [{ type: "cancel", action: "implement", reason: "Scrat label removed" }] };
  const decisions: RoutingDecision[] = [{ type: "cancel", action: "review_issue", reason: "Issue selected for implementation" }];
  if (implemented) decisions.push({ type: "cancel", action: "implement", reason: "An open PR already implements this issue" });
  else if (!workspaceId && (!latest || latest.status === "queued" || latest.status === "cancelled" || previouslyLabelled === false)) {
    decisions.push(...queue(latest, "implement", "Issue has the scrat label", {
      triggerKey: JSON.stringify({ labelledAt: updatedAt, mainSha }), mainSha,
    }));
  }
  return { review: false, decisions };
}

// A behind branch whose latest run could not be prepared at this very head is updated like a conflicting one;
// the new head ends the condition, so each (mainSha, headSha) fires at most once.
export function planPrMaintenance({ conflicts, stale, mainSha, headSha, pendingComments, conflictTask, feedbackTask }: {
  conflicts: boolean; stale: boolean; mainSha: string; headSha: string; pendingComments: string[];
  conflictTask?: TaskFacts; feedbackTask?: TaskFacts;
}): RoutingDecision[] {
  const decisions: RoutingDecision[] = conflicts || stale
    ? queue(conflictTask, "resolve_conflicts", conflicts ? "Scrat PR conflicts with its base branch" : "Scrat PR is behind its base branch and could not be prepared", {
      triggerKey: JSON.stringify({ mainSha, headSha }), mainSha, headSha,
    }) : [{ type: "cancel", action: "resolve_conflicts", reason: "PR no longer conflicts" }];
  const commentRevisions = [...pendingComments].sort();
  if (commentRevisions.length) decisions.push(...queue(feedbackTask, "address_pr_feedback", "New feedback on a Scrat PR", {
    triggerKey: JSON.stringify(commentRevisions), commentRevisions,
  }));
  else decisions.push({ type: "cancel", action: "address_pr_feedback", reason: "Feedback already handled" });
  return decisions;
}

const lowGrades: readonly (string | undefined)[] = ["C", "D", "F"];

// A low grade on a current assessment of a Scrat PR queues one repair per assessment, up to the item's cap.
// Anything else cancels a queued repair, so it never runs against a stale assessment or ahead of human feedback.
export function planSelfRepair({ owned, state, feedbackTask, reviewTask, repairTask, count, limit }: {
  owned: boolean; state: PrReviewState; feedbackTask?: TaskFacts; reviewTask?: TaskFacts; repairTask?: TaskFacts; count: number; limit: number;
}): { decisions: RoutingDecision[]; limited: boolean } {
  const cancel: RoutingDecision[] = [{ type: "cancel", action: "address_review", reason: "No current low-graded review to repair" }];
  const reviewActive = reviewTask?.status === "queued" || reviewTask?.status === "running";
  if (!owned || state.kind !== "current" || !lowGrades.includes(state.assessment.result.grade) || feedbackTask?.status === "queued" || reviewActive) {
    return { decisions: cancel, limited: false };
  }
  const { originId } = state.assessment, grade = state.assessment.result.grade;
  const decisions = queue(repairTask, "address_review", `Current review graded ${grade}`, { triggerKey: originId, assessmentRunId: originId, grade });
  return decisions.length && count >= limit ? { decisions: cancel, limited: true } : { decisions, limited: false };
}

type ReviewTriggerFacts = {
  revision: string; mainSha: string; latest?: TaskFacts; attempt?: ReviewAttempt;
};

// Shared by observation gathering and final policy: covered work must not need
// historical Git objects just to decide that there is nothing to enqueue.
export function reviewTrigger({ latest, attempt, revision, mainSha }: ReviewTriggerFacts) {
  const triggerKey = JSON.stringify({ revision, mainSha });
  const covered = latest?.status !== "cancelled" && (latest?.input.triggerKey === triggerKey
    || (latest?.status === "running" && latest.input.manual === true)
    || (attempt?.context?.revision === revision && attempt.mainSha === mainSha));
  return { triggerKey, covered };
}

type ReviewFacts = ReviewTriggerFacts & (
  | { kind: "pr"; state: PrReviewState }
  | { kind: "issue"; completed?: PreviousReview; freshness?: Freshness }
);

// Observations in, intents out. Queue transactions and external effects belong
// to the caller; publication independently rechecks freshness.
export function planReview(facts: ReviewFacts): RoutingDecision[] {
  const { latest, revision, mainSha } = facts;
  const action = facts.kind === "pr" ? "review_pr" : "review_issue";
  if (facts.kind === "pr" && facts.state.kind === "current") {
    return [{ type: "cancel", action, reason: "No observed relevant changes since the authoritative review" }];
  }
  const { triggerKey, covered } = reviewTrigger(facts);
  if (covered) return [];
  const completed = facts.kind === "pr"
    ? facts.state.kind === "stale" ? facts.state.assessment.run : undefined : facts.completed;
  let changedPaths: string[] = facts.kind === "pr" && facts.state.kind === "stale" ? facts.state.changedPaths : [];
  if (facts.kind === "issue" && completed) {
    if (!facts.freshness) throw new Error("Missing freshness observation for issue review");
    if (facts.freshness.kind === "current") return [{ type: "cancel", action, reason: facts.freshness.baseMoved
      ? "Base changes do not affect the reviewed scope" : "No changes since the last review" }];
    changedPaths = facts.freshness.changedPaths;
  }
  return queue(latest, action, completed ? "Relevant GitHub or base-branch changes" : "Initial GitHub review", {
    triggerKey, revision, mainSha, changedPaths,
    previousMainSha: completed?.mainSha ?? null, previousHeadSha: completed?.headSha ?? null,
  });
}
