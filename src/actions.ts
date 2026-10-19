export const actionIds = ["review_issue", "review_pr", "implement", "resolve_conflicts", "address_pr_feedback"] as const;
export type Action = typeof actionIds[number];

// Safety policy belongs in code; prompts, models and priorities remain config.
// Review mode implies a temporary workspace and no code publication. Change mode
// implies a retained workspace and exact-tree validation before publication.
type ActionContract =
  | { mode: "review"; agent: "single"; publication: "issue-assessment"; context: "all" }
  | { mode: "review"; agent: "panel"; publication: "pr-assessment"; context: "all" }
  | { mode: "change"; agent: "single"; publication: "pull-request"; context: "all"; acceptance: "nonempty-diff" }
  | { mode: "change"; agent: "single"; publication: "comment"; context: "all" | "feedback"; acceptance: "conflict-free" | "complete" };

export const actionContracts = {
  review_issue: { mode: "review", agent: "single", publication: "issue-assessment", context: "all" },
  review_pr: { mode: "review", agent: "panel", publication: "pr-assessment", context: "all" },
  implement: { mode: "change", agent: "single", publication: "pull-request", context: "all", acceptance: "nonempty-diff" },
  resolve_conflicts: { mode: "change", agent: "single", publication: "comment", context: "all", acceptance: "conflict-free" },
  address_pr_feedback: { mode: "change", agent: "single", publication: "comment", context: "feedback", acceptance: "complete" },
} as const satisfies Record<Action, ActionContract>;

export const temporaryWorkspaceActions = actionIds.filter((action) => actionContracts[action].mode === "review");
