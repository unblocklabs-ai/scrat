import type { Action } from "./actions.ts";
import type { PrReviewState } from "./pr-assessment.ts";
import type { runs, tasks } from "./schema.ts";

type Task = typeof tasks.$inferSelect;
type Run = typeof runs.$inferSelect;
type QueueInput = Record<string, unknown> & { triggerKey: string };
export type RoutingDecision =
  | { type: "enqueue"; action: Action; reason: string; input: QueueInput }
  | { type: "cancel"; action: Action; reason: string };

function queue(latest: Task | undefined, action: Action, reason: string, input: QueueInput): RoutingDecision[] {
  if (latest?.status !== "cancelled" && latest?.input.triggerKey === input.triggerKey) return [];
  return [{ type: "enqueue", action, reason, input }];
}

export function planIssueTasks({ labelled, implemented, workspaceId, previouslyLabelled, latest, updatedAt, mainSha }: {
  labelled: boolean; implemented: boolean; workspaceId: string | null; previouslyLabelled?: boolean;
  latest?: Task; updatedAt: string; mainSha: string;
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

export function planPrMaintenance({ conflicts, mainSha, headSha, pendingComments, conflictTask, feedbackTask }: {
  conflicts: boolean; mainSha: string; headSha: string; pendingComments: string[];
  conflictTask?: Task; feedbackTask?: Task;
}): RoutingDecision[] {
  const decisions: RoutingDecision[] = conflicts
    ? queue(conflictTask, "resolve_conflicts", "Scrat PR conflicts with its base branch", {
      triggerKey: JSON.stringify({ mainSha, headSha }), mainSha, headSha,
    }) : [{ type: "cancel", action: "resolve_conflicts", reason: "PR no longer conflicts" }];
  const commentRevisions = [...pendingComments].sort();
  if (commentRevisions.length) decisions.push(...queue(feedbackTask, "address_pr_feedback", "New feedback on a Scrat PR", {
    triggerKey: JSON.stringify(commentRevisions), commentRevisions,
  }));
  else decisions.push({ type: "cancel", action: "address_pr_feedback", reason: "Feedback already handled" });
  return decisions;
}

type ReviewTriggerFacts = {
  revision: string; mainSha: string; latest?: Task; attempt?: Run;
};

// Shared by observation gathering and final policy: covered work must not need
// historical Git objects just to decide that there is nothing to enqueue.
export function reviewTrigger({ latest, attempt, revision, mainSha }: ReviewTriggerFacts) {
  const triggerKey = JSON.stringify({ revision, mainSha });
  const covered = latest?.status !== "cancelled" && (latest?.input.triggerKey === triggerKey
    || (attempt?.context?.revision === revision && attempt.mainSha === mainSha));
  return { triggerKey, covered };
}

type ReviewFacts = ReviewTriggerFacts & (
  | { kind: "pr"; state: PrReviewState }
  | { kind: "issue"; completed?: Run; baseChanges?: { paths: string[]; relevant: boolean } }
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
  if (facts.kind === "issue" && completed?.context?.revision === revision && completed.mainSha) {
    if (completed.mainSha === mainSha) return [{ type: "cancel", action, reason: "No changes since the last review" }];
    if (!facts.baseChanges) throw new Error("Missing base-change observation for issue review");
    changedPaths = facts.baseChanges.paths;
    if (!facts.baseChanges.relevant) return [{ type: "cancel", action, reason: "Base changes do not affect the reviewed scope" }];
  }
  return queue(latest, action, completed ? "Relevant GitHub or base-branch changes" : "Initial GitHub review", {
    triggerKey, revision, mainSha, changedPaths,
    previousMainSha: completed?.mainSha ?? null, previousHeadSha: completed?.headSha ?? null,
  });
}
