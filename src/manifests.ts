import { readdirSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { type Static, type TSchema, Type } from "typebox";
import Value from "typebox/value";
import { parse } from "yaml";
import { triggerKinds, triggerSource } from "./triggers.ts";

export const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const toolNames = ["read", "grep", "find", "ls", "git", "read_base", "bash", "edit", "write"] as const;
const contextFileNames = ["discussion", "review", "previous_assessment", "previous_repair", "history"] as const;
const effectNames = ["push", "pull_request", "comment", "labels", "pr_assessment", "issue", "slack_reply"] as const;
const startEffectNames = ["slack_post"] as const;
export type ThinkingLevel = (typeof thinkingLevels)[number];
export type ToolName = (typeof toolNames)[number];
export type EffectName = (typeof effectNames)[number];

const strict = { additionalProperties: false } as const;
const list = <T extends TSchema>(items: T, minItems = 0) => Type.Array(items, { minItems, uniqueItems: true });
const model = Type.Object({ provider: Type.String(), model: Type.String(), thinkingLevel: Type.Enum(thinkingLevels) }, strict);
const trigger = Type.Object({
  source: Type.Enum(["github_items", "github_commits"]), kind: Type.Enum(triggerKinds),
  item: Type.Optional(Type.Enum(["issue", "pr"])), author: Type.Optional(Type.Literal("bot")),
  grades: Type.Optional(list(Type.Enum(["S", "A", "B", "C", "D", "F"]), 1)),
  manual: Type.Optional(Type.Boolean()), branch: Type.Optional(Type.String()),
}, strict);
const schema = Type.Object({
  name: Type.String({ pattern: "^[a-z][a-z0-9_]{0,63}$" }), enabled: Type.Optional(Type.Boolean()),
  trigger, mode: Type.Enum(["review", "change"]), agent: Type.Enum(["single", "panel"]), reviewers: Type.Optional(Type.Array(model)),
  context: Type.Enum(["all", "feedback", "change"]),
  tools: Type.Optional(list(Type.Enum(toolNames), 1)), files: Type.Optional(list(Type.Enum(contextFileNames))),
  acceptance: Type.Optional(Type.Enum(["complete", "nonempty_diff", "conflict_free"])),
  start: Type.Optional(list(Type.Enum(startEffectNames))), publish: list(Type.Enum(effectNames), 1),
  skill: Type.String(), model, priority: Type.Integer(),
  maxSelfRepairs: Type.Optional(Type.Integer({ minimum: 0 })), exhaustedLabel: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  channel: Type.Optional(Type.String()), maxRangeCommits: Type.Optional(Type.Integer({ minimum: 1 })), startMessage: Type.Optional(Type.String()),
}, strict);

type Parsed = Static<typeof schema>;
export type Manifest = Parsed & Required<Pick<Parsed, "tools" | "files" | "reviewers">> & { file: string; root: string };

const defaultTools = ({ mode, agent, context }: Parsed): ToolName[] => mode === "change" ? ["read", "grep", "find", "ls", "bash", "edit", "write"]
  : ["read", "grep", "find", "ls", "git", ...agent === "panel" || context === "change" ? ["read_base" as const] : []];

function crossChecks(m: Parsed) {
  const { trigger: t, mode, agent, publish } = m, tools: readonly string[] = m.tools ?? defaultTools(m), files: readonly string[] = m.files ?? [];
  const problems: string[] = [];
  const need = (ok: boolean, message: string) => { if (!ok) problems.push(message); };
  const any = (list: readonly string[], names: readonly string[]) => names.some((name) => list.includes(name));
  const items = t.source === "github_items", commits = t.source === "github_commits", slack = [...m.start ?? [], ...publish];
  need(triggerSource(t.kind) === t.source, `trigger.kind ${t.kind} does not belong to source ${t.source}`);
  need(items === (t.item !== undefined), "trigger.item is required for github_items and forbidden for github_commits");
  need(!["pr_conflicts", "pr_feedback", "low_grade"].includes(t.kind) || (t.item === "pr" && t.author === "bot"), `trigger.kind ${t.kind} requires item: pr and author: bot`);
  need(t.kind !== "label" || t.item === "issue", "trigger.kind label requires item: issue");
  need(t.kind !== "item_changed" || t.item !== "pr" || publish.includes("pr_assessment"), "an item_changed trigger on prs must publish pr_assessment");
  need(commits === (t.branch !== undefined), "trigger.branch is required for github_commits and forbidden for github_items");
  need(t.grades === undefined || t.kind === "low_grade", "trigger.grades is only allowed with kind low_grade");
  need((m.maxSelfRepairs === undefined && m.exhaustedLabel === undefined) || t.kind === "low_grade", "maxSelfRepairs and exhaustedLabel are only allowed with kind low_grade");
  need((m.channel === undefined && m.startMessage === undefined && m.maxRangeCommits === undefined) || commits, "channel, startMessage and maxRangeCommits are only allowed with source github_commits");
  need(!any(slack, ["slack_post", "slack_reply"]) || commits, "slack effects require source github_commits");
  need(!any(publish, ["labels", "comment"]) || items, "labels and comment effects require a github_items trigger");
  need(!publish.includes("pr_assessment") || (t.item === "pr" && agent === "panel"), "pr_assessment requires item: pr and agent: panel");
  need(agent !== "panel" || m.reviewers?.length === 2, "agent: panel requires exactly two reviewers");
  need(tools.includes("read"), "tools must include read");
  need(!tools.includes("read_base") || (mode === "review" && (agent === "panel" || m.context === "change")), "read_base requires a review with agent: panel or context: change");
  if (mode === "change") {
    need(m.acceptance !== undefined, "mode change requires acceptance");
    need(publish[0] === "push", "mode change must publish push first");
    need(m.context !== "change", "mode change requires context all or feedback");
    need(!any(tools, ["git", "read_base"]), "mode change forbids the git and read_base tools");
  } else {
    need(m.acceptance === undefined, "mode review forbids acceptance");
    need(!any(publish, ["push", "pull_request"]), "mode review forbids the push and pull_request effects");
    need(!any(tools, ["bash", "edit", "write"]), "mode review forbids the bash, edit and write tools");
  }
  need(!files.includes("review") || t.kind === "low_grade", "files: review requires trigger.kind low_grade");
  need(!any(files, ["previous_assessment", "previous_repair"]) || publish.includes("pr_assessment"), "files: previous_assessment and previous_repair require the pr_assessment effect");
  need(!files.includes("history") || !publish.includes("pr_assessment"), "files: history is not allowed with the pr_assessment effect");
  return problems;
}

function readManifest(root: string, file: string, label: string): Manifest {
  let document: unknown;
  try { document = parse(readFileSync(resolve(root, file), "utf8")); } catch (error) { throw new Error(`${label}: ${(error as Error).message}`); }
  if (!Value.Check(schema, document)) {
    const errors = [...Value.Errors(schema, document)], unknown = errors.find((error) => error.keyword === "additionalProperties");
    const [error] = errors;
    throw new Error(unknown
      ? `${label}: ${unknown.instancePath}/${(unknown.params as { additionalProperties: string[] }).additionalProperties[0]}: unknown key`
      : `${label}: ${error?.instancePath || "/"}: ${error?.message ?? "invalid manifest"}`);
  }
  const parsed = document as Parsed;
  const problems = crossChecks(parsed);
  if (basename(file, ".yaml") !== parsed.name) problems.unshift(`name ${parsed.name} must equal the file name`);
  if (parsed.name === "directory") problems.unshift("directory is not a legal action name");
  if (problems.length) throw new Error(`${label}: ${problems.join("; ")}`);
  return { ...parsed, tools: parsed.tools ?? defaultTools(parsed), files: parsed.files ?? [], reviewers: parsed.reviewers ?? [], file: label, root };
}

export function readManifests(root: string) {
  return readdirSync(resolve(root, "actions")).filter((file) => file.endsWith(".yaml")).sort()
    .map((file) => readManifest(root, `actions/${file}`, `actions/${file}`));
}

export const skillPath = (manifest: Manifest, skill = manifest.skill) => resolve(manifest.root, skill);

export function deploymentDefaults(m: Manifest) {
  const optional = { enabled: m.enabled, branch: m.trigger.branch, channel: m.channel, maxRangeCommits: m.maxRangeCommits, startMessage: m.startMessage, maxSelfRepairs: m.maxSelfRepairs, exhaustedLabel: m.exhaustedLabel };
  return {
    priority: m.priority, skill: m.skill, ...m.model, agent: m.agent, reviewers: m.reviewers,
    ...Object.fromEntries(Object.entries(optional).filter(([, value]) => value !== undefined)),
  };
}
