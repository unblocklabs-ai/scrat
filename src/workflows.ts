import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { type Static, Type } from "typebox";
import Value from "typebox/value";
import { parse } from "yaml";
import { hostProblem } from "./bindings.ts";
import {
  browserSettings, contextFileNames, httpSettings, labelCategories, labelConfigProblems, modelSettings, scheduleProblem, startEffectNames,
  type Action, type ContextFileName, type EffectName, type LabelCategory, type Signal, type StartEffectName, type ToolName,
} from "./manifests.ts";
import { prGrades } from "./results.ts";
import { triggerKinds, triggerSource } from "./triggers.ts";

const strict = { additionalProperties: false } as const;
const list = <T extends Parameters<typeof Type.Array>[0]>(items: T) => Type.Array(items, { uniqueItems: true });
export const workflowAllowedTools = ["read", "grep", "find", "ls", "git", "read_base", "github_search"] as const;
const allWorkflowTools = ["read", "grep", "find", "ls", "git", "read_base", "bash", "edit", "write", "http", "browser", "github_search"] as const;

const githubPermissions = ["read", "comment", "issue", "label", "push", "pull_request"] as const;
const slackPermissions = ["post"] as const;
const workspacePermissions = ["read", "write"] as const;
const retrySettings = Type.Object({ initialDelaySeconds: Type.Integer({ minimum: 1 }), maxDelaySeconds: Type.Integer({ minimum: 1 }) }, strict);
const nullableRetry = Type.Optional(Type.Union([retrySettings, Type.Null()]));

export type GithubPermission = (typeof githubPermissions)[number];
export type SlackPermission = (typeof slackPermissions)[number];
export type WorkspacePermission = (typeof workspacePermissions)[number];

const permissionsSchema = Type.Object({
  github: Type.Optional(list(Type.Enum(githubPermissions))),
  slack: Type.Optional(list(Type.Enum(slackPermissions))),
  workspace: Type.Optional(list(Type.Enum(workspacePermissions))),
}, strict);

const eventTriggerSchema = Type.Object({
  source: Type.Enum(["github_items", "github_commits", "storefront", "shopify"]),
  kind: Type.Enum(triggerKinds),
  item: Type.Optional(Type.Enum(["issue", "pr"])),
  author: Type.Optional(Type.String({ minLength: 1 })),
  grades: Type.Optional(Type.Array(Type.Enum(prGrades), { minItems: 1, uniqueItems: true })),
  branch: Type.Optional(Type.String({ minLength: 1 })),
  granularity: Type.Optional(Type.Enum(["range", "commit"])),
  message: Type.Optional(Type.String({ minLength: 1 })),
}, strict);

type WorkflowEventTrigger = Static<typeof eventTriggerSchema>;

const triggerSchema = Type.Object({
  cron: Type.Optional(Type.String({ minLength: 1 })),
  window: Type.Optional(Type.String({ minLength: 1 })),
  event: Type.Optional(eventTriggerSchema),
  manual: Type.Optional(Type.Boolean()),
}, strict);

const defaultsSchema = Type.Object({
  ...modelSettings.properties,
  reviewers: Type.Optional(Type.Array(modelSettings)),
  codemode: Type.Optional(Type.Boolean()),
  tools: Type.Optional(list(Type.Enum(allWorkflowTools))),
  retry: nullableRetry,
}, strict);

const workflowYamlSchema = Type.Object({
  name: Type.String({ pattern: "^[a-z][a-z0-9_-]{0,63}$" }),
  description: Type.Optional(Type.String()),
  enabled: Type.Optional(Type.Boolean()),
  priority: Type.Optional(Type.Integer()),
  mode: Type.Optional(Type.Enum(["review", "change"])),
  on: triggerSchema,
  permissions: Type.Optional(permissionsSchema),
  http: Type.Optional(httpSettings),
  browser: Type.Optional(browserSettings),
  defaults: defaultsSchema,
  config: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
}, strict);

export const workflowSettings = Type.Object({
  enabled: Type.Optional(Type.Boolean()),
  priority: Type.Optional(Type.Integer()),
  cron: Type.Optional(Type.String({ minLength: 1 })),
  window: Type.Optional(Type.String({ minLength: 1 })),
  branch: Type.Optional(Type.String({ minLength: 1 })),
  provider: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  thinkingLevel: Type.Optional(modelSettings.properties.thinkingLevel),
  reviewers: Type.Optional(Type.Array(modelSettings)),
  codemode: Type.Optional(Type.Boolean()),
  retry: nullableRetry,
  skill: Type.Optional(Type.String({ minLength: 1 })),
  config: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
}, strict);

const itemLabelConfigSchema = Type.Object({
  targets: Type.Optional(Type.Array(Type.Enum(["issues", "prs"]), { minItems: 1, uniqueItems: true })),
  issue_labels: Type.Optional(labelCategories),
  pr_labels: Type.Optional(labelCategories),
}, strict);

export type WorkflowSettings = Static<typeof workflowSettings>;
type ParsedWorkflow = Static<typeof workflowYamlSchema>;
type RetrySettings = Static<typeof retrySettings>;
type ModelEntry = Static<typeof modelSettings>;

export type WorkflowDefinition = {
  name: string;
  description?: string;
  enabled: boolean;
  priority: number;
  mode: "review" | "change";
  on: { cron?: string; window?: string; event?: WorkflowEventTrigger; manual: boolean };
  permissions: {
    github: GithubPermission[];
    slack: SlackPermission[];
    workspace: WorkspacePermission[];
  };
  http?: Static<typeof httpSettings>;
  browser?: Static<typeof browserSettings>;
  defaults: {
    provider: string;
    model: string;
    thinkingLevel: ParsedWorkflow["defaults"]["thinkingLevel"];
    reviewers: ModelEntry[];
    codemode?: boolean;
    tools: ToolName[];
  };
  config: Record<string, unknown>;
  retry: RetrySettings | null;
  dir: string;
  file: string;
  skillPath?: string;
  scriptPath?: string;
  local: boolean;
  hash: string;
};

export type ResolvedWorkflow = Omit<WorkflowDefinition, "enabled" | "priority" | "on" | "defaults" | "config"> & {
  enabled: boolean;
  priority: number;
  on: { cron?: string; window?: string; event?: WorkflowEventTrigger; manual: boolean };
  defaults: WorkflowDefinition["defaults"];
  config: Record<string, unknown>;
};

const defaultReviewWorkflowTools: ToolName[] = ["read", "grep", "find", "ls", "git"];
const defaultChangeWorkflowTools: ToolName[] = ["read", "grep", "find", "ls", "bash", "edit", "write"];

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, canonicalize(v)]),
  );
}

export function hashJson(value: unknown) {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function hashDirectory(dir: string) {
  const hash = createHash("sha256");
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        hash.update(relative(dir, full));
        hash.update("\0");
        hash.update(readFileSync(full));
        hash.update("\0");
      }
    }
  };
  walk(dir);
  return hash.digest("hex");
}

const validContextFiles = new Set<string>(contextFileNames);
const validStartEffects = new Set<string>(startEffectNames);

export function validateWorkflowConfig(cfg: Record<string, unknown>, mode: "review" | "change", event?: WorkflowEventTrigger) {
  const problems: string[] = [];
  if (cfg.failedLabel !== undefined) {
    if (mode !== "change") problems.push("failedLabel requires mode change");
    if (cfg.failedLabel !== null && typeof cfg.failedLabel !== "string") problems.push("config.failedLabel must be string or null");
  }
  if (cfg.exhaustedLabel !== undefined && cfg.exhaustedLabel !== null && typeof cfg.exhaustedLabel !== "string") {
    problems.push("config.exhaustedLabel must be string or null");
  }
  if (cfg.maxSelfRepairs !== undefined && (!Number.isInteger(cfg.maxSelfRepairs) || (cfg.maxSelfRepairs as number) < 0)) {
    problems.push("config.maxSelfRepairs must be a non-negative integer");
  }
  for (const key of ["maxRangeCommits", "browserSteps", "browserSeconds"] as const) {
    const val = cfg[key];
    if (val !== undefined && (!Number.isInteger(val) || (val as number) < 1)) {
      problems.push(`config.${key} must be a positive integer`);
    }
  }
  if (cfg.files !== undefined) {
    if (!Array.isArray(cfg.files) || cfg.files.some((entry) => typeof entry !== "string" || !validContextFiles.has(entry))) {
      problems.push(`config.files entries must be one of: ${contextFileNames.join(", ")}`);
    }
  }
  if (cfg.start !== undefined) {
    if (!Array.isArray(cfg.start) || cfg.start.some((entry) => typeof entry !== "string" || !validStartEffects.has(entry))) {
      problems.push(`config.start entries must be one of: ${startEffectNames.join(", ")}`);
    }
  }
  if (event?.kind === "low_grade" && (!Number.isInteger(cfg.maxSelfRepairs) || (cfg.maxSelfRepairs as number) < 0)) {
    problems.push("kind low_grade requires config.maxSelfRepairs");
  }
  if (event?.source === "github_commits" && (!Number.isInteger(cfg.maxRangeCommits) || (cfg.maxRangeCommits as number) < 1)) {
    problems.push("source github_commits requires config.maxRangeCommits");
  }
  return problems;
}

function readWorkflowDir(dir: string, label: string, local: boolean): WorkflowDefinition {
  const yamlPath = join(dir, "workflow.yaml");
  if (!existsSync(yamlPath)) throw new Error(`${label}: missing workflow.yaml`);
  let document: unknown;
  try { document = parse(readFileSync(yamlPath, "utf8")); }
  catch (error) { throw new Error(`${label}: ${(error as Error).message}`); }
  if (!Value.Check(workflowYamlSchema, document)) {
    const errors = [...Value.Errors(workflowYamlSchema, document)];
    const unknown = errors.find((error) => error.keyword === "additionalProperties");
    const [first] = errors;
    throw new Error(unknown
      ? `${label}: ${unknown.instancePath}/${(unknown.params as { additionalProperties: string[] }).additionalProperties[0]}: unknown key`
      : `${label}: ${first?.instancePath || "/"}: ${first?.message ?? "invalid workflow.yaml"}`);
  }
  const parsed = document as ParsedWorkflow;
  const folder = basename(dir);
  const mode = parsed.mode ?? "review";
  const tools = parsed.defaults.tools ?? (mode === "change" ? [...defaultChangeWorkflowTools] : [...defaultReviewWorkflowTools]);
  const problems: string[] = [];
  if (parsed.name !== folder) problems.push(`name ${parsed.name} must equal folder name ${folder}`);
  if (parsed.name === "directory" || parsed.name === "trustLocalScripts") problems.push(`${parsed.name} is not a legal workflow name`);
  if (mode === "review" && tools.some((t) => t === "bash" || t === "edit" || t === "write")) {
    problems.push("mode review forbids the bash, edit and write tools");
  }
  if (mode === "change" && tools.some((t) => t === "git" || t === "read_base")) {
    problems.push("mode change forbids the git and read_base tools");
  }
  if (mode === "change" && tools.includes("github_search")) {
    problems.push("github_search requires mode review");
  }
  problems.push(...validateWorkflowConfig(parsed.config ?? {}, mode, parsed.on.event));
  if (tools.includes("github_search") && !parsed.permissions?.github?.includes("read")) {
    problems.push("defaults.tools: github_search requires permissions.github: [read]");
  }
  if (tools.includes("http") !== Boolean(parsed.http)) {
    problems.push("the http tool and the http setting require each other");
  }
  const storefrontBrowser = parsed.on.event?.source === "storefront" || parsed.on.event?.source === "shopify"
    || parsed.on.cron !== undefined || (parsed.on.event?.kind === "item_changed" && parsed.on.event.item === "pr");
  if ((tools.includes("browser") && !storefrontBrowser) && !parsed.browser) {
    problems.push("the browser tool and the browser setting require each other");
  }
  if (parsed.browser && !tools.includes("browser")) {
    problems.push("the browser tool and the browser setting require each other");
  }
  for (const host of [...parsed.browser?.navigationHosts ?? [], ...parsed.browser?.resourceHosts ?? []]) {
    const issue = hostProblem(host);
    if (issue) problems.push(`browser: ${issue}`);
  }
  if (parsed.defaults.reviewers?.length && parsed.defaults.reviewers.length !== 2) {
    problems.push("defaults.reviewers must specify exactly two reviewers");
  }
  if (!parsed.on.cron && !parsed.on.event && parsed.on.manual === false) problems.push("on must enable cron, event, or manual");
  if (parsed.on.event) {
    const ev = parsed.on.event;
    if (triggerSource(ev.kind) !== ev.source) problems.push(`on.event.kind ${ev.kind} does not belong to source ${ev.source}`);
    if (ev.source === "github_items" && ev.kind !== "item_labels" && !ev.item) problems.push("on.event.item is required for github_items except item_labels");
    if (ev.source === "github_items" && ev.author !== undefined && ev.author !== "bot") problems.push('on.event.author must be "bot" for github_items');
    if (ev.kind === "item_labels" && ev.item) problems.push("on.event.item is forbidden for item_labels");
    if (ev.kind === "label" && ev.item !== "issue") problems.push("on.event.kind label requires item: issue");
    if ((ev.kind === "low_grade" || ev.kind === "pr_feedback" || ev.kind === "pr_conflicts") && (ev.item !== "pr" || ev.author !== "bot")) {
      problems.push(`on.event.kind ${ev.kind} requires item: pr and author: bot`);
    }
    if (ev.source === "storefront" && mode !== "review") problems.push("a storefront trigger requires mode review");
    if (ev.source === "github_commits" && !ev.branch) problems.push("on.event.branch is required for github_commits");
    if (ev.source !== "github_commits" && (ev.message !== undefined || ev.granularity !== undefined)) {
      problems.push("on.event.message and on.event.granularity are only allowed with source github_commits");
    }
  }
  if (parsed.on.cron) {
    if (mode !== "review") problems.push("a schedule trigger requires mode review");
    const cronErr = scheduleProblem("cron", parsed.on.cron);
    if (cronErr) problems.push(`on.cron: ${cronErr}`);
  }
  if (parsed.on.window) {
    if (!parsed.on.cron) problems.push("on.window requires on.cron");
    else {
      const winErr = scheduleProblem("window", parsed.on.window);
      if (winErr) problems.push(`on.window: ${winErr}`);
    }
  }
  const skillPath = existsSync(join(dir, "SKILL.md")) ? join(dir, "SKILL.md") : undefined;
  const scriptPath = existsSync(join(dir, "run.ts")) ? join(dir, "run.ts") : undefined;
  if (!skillPath && !scriptPath) problems.push("workflow folder must contain SKILL.md or run.ts");
  if (problems.length) throw new Error(`${label}: ${problems.join("; ")}`);

  return {
    name: parsed.name,
    description: parsed.description,
    enabled: parsed.enabled ?? false,
    priority: parsed.priority ?? 0,
    mode,
    on: {
      cron: parsed.on.cron,
      window: parsed.on.window ?? (parsed.on.cron ? "24h" : undefined),
      event: parsed.on.event,
      manual: parsed.on.manual ?? true,
    },
    permissions: {
      github: parsed.permissions?.github ?? [],
      slack: parsed.permissions?.slack ?? [],
      workspace: parsed.permissions?.workspace ?? [],
    },
    http: parsed.http,
    browser: parsed.browser,
    defaults: {
      provider: parsed.defaults.provider,
      model: parsed.defaults.model,
      thinkingLevel: parsed.defaults.thinkingLevel,
      reviewers: parsed.defaults.reviewers ?? [],
      codemode: parsed.defaults.codemode,
      tools,
    },
    config: parsed.config ?? {},
    retry: parsed.defaults.retry ?? null,
    dir: resolve(dir),
    file: label,
    skillPath,
    scriptPath,
    local,
    hash: hashDirectory(dir),
  };
}

export function readWorkflows(root: string, directory?: string | null): WorkflowDefinition[] {
  const loaded = new Map<string, WorkflowDefinition>();
  const scan = (baseDir: string, local: boolean) => {
    if (!existsSync(baseDir)) {
      if (local) throw new Error(`Cannot read workflows in ${baseDir}: directory does not exist`);
      return;
    }
    for (const entry of readdirSync(baseDir).sort()) {
      const full = resolve(baseDir, entry);
      if (!statSync(full).isDirectory()) continue;
      if (!existsSync(join(full, "workflow.yaml"))) continue;
      const label = local ? join(full, "workflow.yaml") : `workflows/${entry}/workflow.yaml`;
      const wf = readWorkflowDir(full, label, local);
      loaded.set(wf.name, wf);
    }
  };
  scan(resolve(root, "workflows"), false);
  if (directory) scan(directory, true);
  return [...loaded.values()];
}

export function workflowDeploymentDefaults(wf: WorkflowDefinition): WorkflowSettings {
  return {
    enabled: wf.enabled,
    priority: wf.priority,
    ...(wf.on.cron ? { cron: wf.on.cron } : {}),
    ...(wf.on.window ? { window: wf.on.window } : {}),
    ...(wf.on.event?.branch ? { branch: wf.on.event.branch } : {}),
    provider: wf.defaults.provider,
    model: wf.defaults.model,
    thinkingLevel: wf.defaults.thinkingLevel,
    ...(wf.defaults.reviewers.length ? { reviewers: wf.defaults.reviewers } : {}),
    ...(wf.defaults.codemode !== undefined ? { codemode: wf.defaults.codemode } : {}),
    retry: wf.retry,
    config: wf.config,
  };
}

export function resolveWorkflow(wf: WorkflowDefinition, entry?: WorkflowSettings): ResolvedWorkflow {
  const cron = entry?.cron ?? wf.on.cron;
  const window = entry?.window ?? wf.on.window ?? (cron ? "24h" : undefined);
  const event = wf.on.event ? { ...wf.on.event, ...(entry?.branch ? { branch: entry.branch } : {}) } : undefined;
  const defaults = {
    ...wf.defaults,
    provider: entry?.provider ?? wf.defaults.provider,
    model: entry?.model ?? wf.defaults.model,
    thinkingLevel: entry?.thinkingLevel ?? wf.defaults.thinkingLevel,
    reviewers: entry?.reviewers ?? wf.defaults.reviewers,
    codemode: entry?.codemode ?? wf.defaults.codemode,
  };
  const config = { ...wf.config, ...(entry?.config ?? {}) };
  const skillPath = entry?.skill ? (isAbsolute(entry.skill) ? entry.skill : resolve(wf.dir, entry.skill)) : wf.skillPath;
  const skillHash = entry?.skill
    ? (skillPath && existsSync(skillPath) ? createHash("sha256").update(readFileSync(skillPath)).digest("hex") : entry.skill)
    : null;
  return {
    ...wf,
    enabled: entry?.enabled ?? wf.enabled,
    priority: entry?.priority ?? wf.priority,
    on: { cron, window, event, manual: wf.on.manual },
    defaults,
    config,
    retry: entry?.retry !== undefined ? entry.retry : wf.retry,
    skillPath,
    hash: hashJson({ folder: wf.hash, defaults, config, skillHash }),
  };
}

export type WorkflowPipelineSpec = {
  files?: readonly ContextFileName[];
  context?: "all" | "feedback" | "change";
  agent?: "single" | "panel";
  acceptance?: "complete" | "nonempty_diff" | "conflict_free";
  commitPrefix?: string;
  start?: readonly StartEffectName[];
  publish: readonly EffectName[];
};

const cfgString = (cfg: Record<string, unknown>, key: string) => typeof cfg[key] === "string" ? cfg[key] : undefined;
const cfgNullableString = (cfg: Record<string, unknown>, key: string) => cfg[key] === null ? null : typeof cfg[key] === "string" ? cfg[key] : undefined;
const cfgNumber = (cfg: Record<string, unknown>, key: string) => typeof cfg[key] === "number" && Number.isFinite(cfg[key]) ? cfg[key] : undefined;

export function toWorkflowSpec(wf: ResolvedWorkflow, spec: WorkflowPipelineSpec): Action {
  const trigger: Action["trigger"] = wf.on.event
    ? { ...wf.on.event, branch: wf.on.event.branch, cron: undefined, window: undefined, manual: wf.on.manual }
    : { source: "schedule", kind: "tick", branch: undefined, cron: wf.on.cron, window: wf.on.window, manual: wf.on.manual };
  const labelSettings = workflowItemLabelSettings(wf);
  const configFiles = Array.isArray(wf.config.files)
    ? wf.config.files.filter((entry): entry is ContextFileName => typeof entry === "string")
    : undefined;
  return {
    name: wf.name,
    trigger,
    mode: wf.mode,
    agent: spec.agent ?? (wf.defaults.reviewers.length ? "panel" : "single"),
    reviewers: wf.defaults.reviewers,
    context: spec.context ?? "all",
    tools: wf.defaults.tools,
    http: wf.http,
    browser: wf.browser,
    files: configFiles ?? [...(spec.files ?? [])],
    acceptance: spec.acceptance,
    commitPrefix: spec.commitPrefix,
    start: spec.start ? [...spec.start] : undefined,
    publish: [...spec.publish],
    enabled: wf.enabled,
    priority: wf.priority,
    skill: wf.skillPath ?? wf.file,
    provider: wf.defaults.provider,
    model: wf.defaults.model,
    thinkingLevel: wf.defaults.thinkingLevel,
    codemode: wf.defaults.codemode,
    retry: wf.retry,
    channel: cfgString(wf.config, "channel"),
    maxRangeCommits: cfgNumber(wf.config, "maxRangeCommits"),
    startMessage: cfgString(wf.config, "startMessage"),
    browserSteps: cfgNumber(wf.config, "browserSteps"),
    browserSeconds: cfgNumber(wf.config, "browserSeconds"),
    rootInstructions: cfgString(wf.config, "rootInstructions"),
    maxSelfRepairs: cfgNumber(wf.config, "maxSelfRepairs"),
    exhaustedLabel: cfgNullableString(wf.config, "exhaustedLabel"),
    failedLabel: cfgNullableString(wf.config, "failedLabel"),
    targets: labelSettings.targets,
    issue_labels: labelSettings.issue_labels,
    pr_labels: labelSettings.pr_labels,
    branch: wf.on.event?.branch,
    cron: wf.on.cron,
    window: wf.on.window,
    file: wf.file,
    root: wf.dir,
  };
}

export function matchesWorkflowSignal(wf: Pick<ResolvedWorkflow, "on">, signal: Signal) {
  const t = wf.on.event;
  if (!t) return false;
  return t.source === signal.source && t.kind === signal.kind
    && (t.item === undefined || t.item === signal.item)
    && (t.author === undefined || t.author === signal.author)
    && (t.grades === undefined || signal.grade === undefined || t.grades.includes(signal.grade));
}

type WorkflowItemLabelSettings = {
  targets?: ("issues" | "prs")[];
  issue_labels?: LabelCategory[];
  pr_labels?: LabelCategory[];
};

export function workflowItemLabelSettings(wf: Pick<ResolvedWorkflow, "config">): WorkflowItemLabelSettings {
  const { targets, issue_labels, pr_labels } = wf.config;
  return {
    targets: Array.isArray(targets) ? targets as ("issues" | "prs")[] : undefined,
    issue_labels: Array.isArray(issue_labels) ? issue_labels as LabelCategory[] : undefined,
    pr_labels: Array.isArray(pr_labels) ? pr_labels as LabelCategory[] : undefined,
  };
}

export function validateWorkflowItemLabels(wf: Pick<ResolvedWorkflow, "name" | "config">): string[] {
  const subset = {
    ...(wf.config.targets !== undefined ? { targets: wf.config.targets } : {}),
    ...(wf.config.issue_labels !== undefined ? { issue_labels: wf.config.issue_labels } : {}),
    ...(wf.config.pr_labels !== undefined ? { pr_labels: wf.config.pr_labels } : {}),
  };
  if (!Value.Check(itemLabelConfigSchema, subset)) {
    return [...Value.Errors(itemLabelConfigSchema, subset)].map((err) => `${wf.name}: config${err.instancePath || "/"}: ${err.message}`);
  }
  return labelConfigProblems(subset as WorkflowItemLabelSettings).map((problem) => `${wf.name}: ${problem}`);
}
