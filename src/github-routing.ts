import type { Action } from "./actions.ts";
import type { Freshness } from "./freshness.ts";
import { botName, botSlug } from "./identity.ts";
import type { PrReviewState } from "./pr-assessment.ts";
import { type Run, type Task } from "./schema.ts";
import { isManual, triggerKeyOf, type KeyedTriggerInput } from "./triggers.ts";

type TaskFacts = Pick<Task, "status" | "input">;
type ReviewAttempt = Pick<Run, "mainSha"> & {
  context: Pick<NonNullable<Run["context"]>, "revision"> | null;
};
type PreviousReview = ReviewAttempt & Pick<Run, "headSha">;
export type RoutingDecision =
  | { type: "enqueue"; action: Action; reason: string; input: KeyedTriggerInput }
  | { type: "cancel"; action: Action; reason: string };

function queue(latest: TaskFacts | undefined, action: Action, reason: string, input: KeyedTriggerInput): RoutingDecision[] {
  if (latest?.status !== "cancelled" && latest && triggerKeyOf(latest.input) === input.triggerKey) return [];
  return [{ type: "enqueue", action, reason, input }];
}

export function planIssueTasks({ labelled, implemented, workspaceId, previouslyLabelled, latest, updatedAt, mainSha }: {
  labelled: boolean; implemented: boolean; workspaceId: string | null; previouslyLabelled?: boolean;
  latest?: TaskFacts; updatedAt: string; mainSha: string;
}): { review: boolean; decisions: RoutingDecision[] } {
  if (!labelled) return { review: true, decisions: [{ type: "cancel", action: "implement", reason: `${botName} label removed` }] };
  const decisions: RoutingDecision[] = [{ type: "cancel", action: "review_issue", reason: "Issue selected for implementation" }];
  if (implemented) decisions.push({ type: "cancel", action: "implement", reason: "An open PR already implements this issue" });
  else if (!workspaceId && (!latest || latest.status === "queued" || latest.status === "cancelled" || previouslyLabelled === false)) {
    decisions.push(...queue(latest, "implement", `Issue has the ${botSlug} label`, {
      source: "github_items", kind: "label", triggerKey: JSON.stringify({ labelledAt: updatedAt, mainSha }), mainSha,
    }));
  }
  return { review: false, decisions };
}

export function planPrMaintenance({ conflicts, stale, mainSha, headSha, pendingComments, conflictTask, feedbackTask }: {
  conflicts: boolean; stale: boolean; mainSha: string; headSha: string; pendingComments: string[];
  conflictTask?: TaskFacts; feedbackTask?: TaskFacts;
}): RoutingDecision[] {
  const decisions: RoutingDecision[] = conflicts || stale
    ? queue(conflictTask, "resolve_conflicts", conflicts ? `${botName} PR conflicts with its base branch` : `${botName} PR is behind its base branch and could not be prepared`, {
      source: "github_items", kind: "pr_conflicts", triggerKey: JSON.stringify({ mainSha, headSha }), mainSha, headSha,
    }) : [{ type: "cancel", action: "resolve_conflicts", reason: "PR no longer conflicts" }];
  const commentRevisions = [...pendingComments].sort();
  if (commentRevisions.length) decisions.push(...queue(feedbackTask, "address_pr_feedback", `New feedback on a ${botName} PR`, {
    source: "github_items", kind: "pr_feedback", triggerKey: JSON.stringify(commentRevisions), commentRevisions,
  }));
  else decisions.push({ type: "cancel", action: "address_pr_feedback", reason: "Feedback already handled" });
  return decisions;
}

export const lowGrades: readonly (string | undefined)[] = ["C", "D", "F"];

export function planSelfRepair({ owned, state, feedbackTask, reviewTask, repairTask, count, limit }: {
  owned: boolean; state: PrReviewState; feedbackTask?: TaskFacts; reviewTask?: TaskFacts; repairTask?: TaskFacts; count: number; limit: number;
}): { decisions: RoutingDecision[]; limited: boolean } {
  const cancel: RoutingDecision[] = [{ type: "cancel", action: "address_review", reason: "No current low-graded review to repair" }];
  const reviewActive = reviewTask?.status === "queued" || reviewTask?.status === "running";
  if (!owned || state.kind !== "current" || !lowGrades.includes(state.assessment.result.grade) || feedbackTask?.status === "queued" || reviewActive) {
    return { decisions: cancel, limited: false };
  }
  const { originId } = state.assessment, grade = state.assessment.result.grade;
  const decisions = queue(repairTask, "address_review", `Current review graded ${grade}`, { source: "github_items", kind: "low_grade", triggerKey: originId, assessmentRunId: originId, grade: grade! });
  return decisions.length && count >= limit ? { decisions: cancel, limited: true } : { decisions, limited: false };
}

type ReviewTriggerFacts = {
  revision: string; mainSha: string; latest?: TaskFacts; attempt?: ReviewAttempt;
};

export function reviewTrigger({ latest, attempt, revision, mainSha }: ReviewTriggerFacts) {
  const triggerKey = JSON.stringify({ revision, mainSha });
  const covered = latest?.status !== "cancelled" && ((latest && triggerKeyOf(latest.input) === triggerKey)
    || (latest?.status === "running" && isManual(latest.input))
    || (attempt?.context?.revision === revision && attempt.mainSha === mainSha));
  return { triggerKey, covered };
}

type ReviewFacts = ReviewTriggerFacts & (
  | { kind: "pr"; state: PrReviewState }
  | { kind: "issue"; completed?: PreviousReview; freshness?: Freshness }
);

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
    source: "github_items", kind: "item_changed", triggerKey, revision, mainSha, changedPaths,
    previousMainSha: completed?.mainSha ?? null, previousHeadSha: completed?.headSha ?? null,
  });
}
