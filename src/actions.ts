export const actionIds = ["review_issue", "review_pr", "implement", "resolve_conflicts", "address_pr_feedback", "address_review", "review_base_change"] as const;
export type Action = typeof actionIds[number];

type ActionContract =
  | { mode: "review"; agent: "single"; publication: "issue-assessment"; context: "all" }
  | { mode: "review"; agent: "single"; publication: "issue-report"; context: "all" }
  | { mode: "review"; agent: "panel"; publication: "pr-assessment"; context: "all" }
  | { mode: "review"; agent: "single" | "panel"; publication: "slack-thread"; context: "change" }
  | { mode: "change"; agent: "single"; publication: "pull-request"; context: "all"; acceptance: "nonempty-diff" }
  | { mode: "change"; agent: "single"; publication: "comment"; context: "all" | "feedback"; acceptance: "conflict-free" | "complete" };

export type Publication = ActionContract["publication"];

export const actionContracts = {
  review_issue: { mode: "review", agent: "single", publication: "issue-assessment", context: "all" },
  review_pr: { mode: "review", agent: "panel", publication: "pr-assessment", context: "all" },
  implement: { mode: "change", agent: "single", publication: "pull-request", context: "all", acceptance: "nonempty-diff" },
  resolve_conflicts: { mode: "change", agent: "single", publication: "comment", context: "all", acceptance: "conflict-free" },
  address_pr_feedback: { mode: "change", agent: "single", publication: "comment", context: "feedback", acceptance: "complete" },
  address_review: { mode: "change", agent: "single", publication: "comment", context: "all", acceptance: "complete" },
  review_base_change: { mode: "review", agent: "single", publication: "slack-thread", context: "change" },
} as const satisfies Record<Action, ActionContract>;

export const temporaryWorkspaceActions = actionIds.filter((action) => actionContracts[action].mode === "review");
