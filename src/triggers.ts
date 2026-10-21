import { type Static, type TSchema, Type } from "typebox";
import Value from "typebox/value";

const text = Type.String();
const items = <K extends string, F extends Record<string, TSchema>>(kind: K, fields: F) =>
  Type.Object({ source: Type.Literal("github_items"), kind: Type.Literal(kind), manual: Type.Optional(Type.Boolean()), ...fields });

const itemChanged = items("item_changed", {
  triggerKey: text, revision: text, mainSha: text, changedPaths: Type.Optional(Type.Array(text)),
  previousMainSha: Type.Optional(Type.Union([text, Type.Null()])), previousHeadSha: Type.Optional(Type.Union([text, Type.Null()])),
});
const label = items("label", { triggerKey: text, mainSha: text });
const prConflicts = items("pr_conflicts", { triggerKey: text, mainSha: text, headSha: text });
const prFeedback = items("pr_feedback", { triggerKey: text, commentRevisions: Type.Array(text) });
const lowGrade = items("low_grade", { triggerKey: text, assessmentRunId: text, grade: text });
const manual = items("manual", {});
const commit = Type.Object({
  source: Type.Literal("github_commits"), kind: Type.Literal("commit"),
  triggerKey: text, sha: text, previousSha: text, branch: text, commitCount: Type.Number(), truncated: Type.Boolean(),
});

const members = {
  item_changed: { source: "github_items", schema: itemChanged },
  label: { source: "github_items", schema: label },
  pr_conflicts: { source: "github_items", schema: prConflicts },
  pr_feedback: { source: "github_items", schema: prFeedback },
  low_grade: { source: "github_items", schema: lowGrade },
  manual: { source: "github_items", schema: manual },
  commit: { source: "github_commits", schema: commit },
} as const;

export type TriggerInput = Static<typeof itemChanged> | Static<typeof label> | Static<typeof prConflicts> | Static<typeof prFeedback>
  | Static<typeof lowGrade> | Static<typeof manual> | Static<typeof commit>;
export type KeyedTriggerInput = Extract<TriggerInput, { triggerKey: string }>;
type Kind = keyof typeof members;
type ManifestKind = Exclude<Kind, "manual">;

export const triggerKinds = Object.keys(members).filter((kind) => kind !== "manual") as ManifestKind[];
export const triggerSource = (kind: ManifestKind) => members[kind].source;

function classify(input: Record<string, unknown>): Kind {
  if (input.kind !== undefined) {
    if (typeof input.kind !== "string" || !Object.hasOwn(members, input.kind)) throw new Error(`Unknown trigger kind: ${JSON.stringify(input.kind)}`);
    return input.kind as Kind;
  }
  if (input.commentRevisions !== undefined) return "pr_feedback";
  if (input.assessmentRunId !== undefined) return "low_grade";
  if (input.mainSha !== undefined && input.headSha !== undefined) return "pr_conflicts";
  if (input.revision !== undefined) return "item_changed";
  if (input.mainSha !== undefined) return "label";
  return "manual";
}

export function parseTriggerInput(input: unknown): TriggerInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error("Trigger input must be an object");
  const record = input as Record<string, unknown>;
  const kind = classify(record);
  const { source, schema } = members[kind];
  if (record.source !== undefined && record.source !== source) throw new Error(`Unknown trigger source for ${kind}: ${JSON.stringify(record.source)}`);
  const normalized = { ...record, source, kind };
  if (!Value.Check(schema, normalized)) {
    const [error] = Value.Errors(schema, normalized);
    throw new Error(`Invalid ${source}/${kind} trigger input${error ? ` at ${error.instancePath || "/"}: ${error.message}` : ""}`);
  }
  return normalized as TriggerInput;
}

export const triggerKeyOf = (input: Record<string, unknown>) => typeof input.triggerKey === "string" ? input.triggerKey : undefined;

export const isManual = (input: Record<string, unknown>) => input.manual === true;
