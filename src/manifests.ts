import { type Static, type TSchema, Type } from "typebox";
import { nextTick, parseCron, parseWindow } from "./cron.ts";
import { prGrades } from "./results.ts";
import { triggerKinds } from "./triggers.ts";
type TriggerKind = (typeof triggerKinds)[number];

export const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const toolNames = ["read", "grep", "find", "ls", "git", "read_base", "bash", "edit", "write", "http", "browser", "github_search"] as const;
export const contextFileNames = ["discussion", "review", "previous_assessment", "previous_repair", "history", "validation", "triage", "issue", "storefront", "cloudflare", "store_changes"] as const;
export const effectNames = ["push", "pull_request", "comment", "labels", "pr_assessment", "issue", "slack_reply", "site_map"] as const;
export const startEffectNames = ["slack_post"] as const;
export type ThinkingLevel = (typeof thinkingLevels)[number];
export type ToolName = (typeof toolNames)[number];
export type ContextFileName = (typeof contextFileNames)[number];
export type EffectName = (typeof effectNames)[number];
export type StartEffectName = (typeof startEffectNames)[number];

const strict = { additionalProperties: false } as const;
export const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const list = <T extends TSchema>(items: T, minItems = 0) => Type.Array(items, { minItems, uniqueItems: true });
export const modelSettings = Type.Object({ provider: Type.String(), model: Type.String(), thinkingLevel: Type.Enum(thinkingLevels) }, strict);
export const labelCategories = Type.Array(Type.Object({
  category: Type.String({ minLength: 1, pattern: "\\S" }),
  choices: Type.Array(Type.Object({
    name: Type.String({ minLength: 1, maxLength: 50, pattern: "^\\S(?:.*\\S)?$" }),
    description: Type.String({ minLength: 1, pattern: "\\S" }),
  }, strict), { minItems: 1 }),
}, strict));
export type LabelCategory = Static<typeof labelCategories>[number];

export type LabelSettings = { targets?: ("issues" | "prs")[]; issue_labels?: LabelCategory[]; pr_labels?: LabelCategory[] };

export function labelConfigProblems(entry: LabelSettings) {
  const problems: string[] = [];
  if (!entry.targets?.length) problems.push("kind item_labels requires targets");
  for (const target of ["issues", "prs"] as const) {
    const categories = (target === "issues" ? entry.issue_labels : entry.pr_labels) ?? [];
    if (entry.targets?.includes(target) && !categories.length) problems.push(`${target} target requires non-empty ${target === "issues" ? "issue_labels" : "pr_labels"}`);
    const names = categories.flatMap(({ choices }) => choices.map(({ name }) => name.toLowerCase()));
    if (new Set(names).size !== names.length) problems.push(`${target}: label names must be unique across categories (case-insensitive)`);
    const keys = categories.map(({ category }) => category.toLowerCase());
    if (new Set(keys).size !== keys.length) problems.push(`${target}: category names must be unique (case-insensitive)`);
  }
  return problems;
}

export const httpSettings = Type.Object({ binding: Type.String(), methods: Type.Optional(list(Type.Enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]), 1)) }, strict);
export const browserSettings = Type.Object({ navigationHosts: list(Type.String(), 1), resourceHosts: list(Type.String()), binding: Type.Optional(Type.String()) }, strict);

type Grade = (typeof prGrades)[number];
type ModelEntry = Static<typeof modelSettings>;

export type ActionTrigger = {
  source: "github_items" | "github_commits" | "schedule" | "storefront" | "shopify" | "workflow";
  kind: TriggerKind;
  item?: "issue" | "pr";
  author?: string;
  grades?: Grade[];
  branch?: string;
  granularity?: "range" | "commit";
  message?: string;
  role?: "canonical" | "advisory";
  paths?: string[];
  workflow?: string;
};

export type Action = {
  name: string;
  trigger: ActionTrigger;
  mode: "review" | "change";
  agent: "single" | "panel";
  reviewers: ModelEntry[];
  context: "all" | "feedback" | "change";
  tools: ToolName[];
  http?: Static<typeof httpSettings>;
  browser?: Static<typeof browserSettings>;
  files: ContextFileName[];
  acceptance?: "complete" | "nonempty_diff" | "conflict_free";
  commitPrefix?: string;
  start?: StartEffectName[];
  publish: EffectName[];
  enabled?: boolean;
  skill: string;
  provider: string;
  model: string;
  thinkingLevel: ThinkingLevel;
  codemode?: boolean;
  maxRangeCommits?: number;
  browserSteps?: number;
  browserSeconds?: number;
  rootInstructions?: string;
};

export function scheduleProblem(key: "cron" | "window", value: string) {
  try { if (key === "cron") nextTick(parseCron(value), new Date(0)); else parseWindow(value); } catch (error) { return (error as Error).message; }
}

export type Signal = {
  source: ActionTrigger["source"];
  kind: TriggerKind;
  item?: "issue" | "pr";
  author?: "bot" | "other";
  grade?: Grade;
};

export function findTriggerConflicts<T extends { file: string; trigger: ActionTrigger }>(entries: readonly T[], enabled: (entry: T) => boolean) {
  const live = entries.filter((entry) => enabled(entry) && entry.trigger.role !== "advisory" && entry.trigger.source !== "schedule" && entry.trigger.source !== "workflow"), problems: string[] = [];
  live.forEach((a, index) => live.slice(index + 1).forEach((b) => {
    const [x, y] = [a.trigger, b.trigger];
    const grades = !x.grades || !y.grades || x.grades.some((grade) => y.grades!.includes(grade));
    if (x.source === y.source && x.kind === y.kind && x.item === y.item && x.branch === y.branch && grades && (x.source !== "github_commits" || (x.author === y.author && x.message === y.message))) {
      const shown = [`source: ${x.source}`, `kind: ${x.kind}`, ...x.item ? [`item: ${x.item}`] : [], ...x.branch ? [`branch: ${x.branch}`] : [], ...x.source === "github_commits" && x.author ? [`author: ${x.author}`] : [], ...x.message ? [`message: ${x.message}`] : []].join(", ");
      problems.push(`${a.file} and ${b.file} both match {${shown}}; disable one`);
    }
  }));
  return problems;
}
