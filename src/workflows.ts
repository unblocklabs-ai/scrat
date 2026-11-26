import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { type Static, Type } from "typebox";
import Value from "typebox/value";
import { parse } from "yaml";
import { modelSettings, scheduleProblem, type ToolName } from "./manifests.ts";

const strict = { additionalProperties: false } as const;
const list = <T extends Parameters<typeof Type.Array>[0]>(items: T) => Type.Array(items, { uniqueItems: true });
export const workflowAllowedTools = ["read", "grep", "find", "ls", "git", "github_search"] as const;

const githubPermissions = ["read", "comment", "issue"] as const;
const slackPermissions = ["post"] as const;
const workspacePermissions = ["read"] as const;
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

const triggerSchema = Type.Object({
  cron: Type.Optional(Type.String({ minLength: 1 })),
  window: Type.Optional(Type.String({ minLength: 1 })),
  manual: Type.Optional(Type.Boolean()),
}, strict);

const defaultsSchema = Type.Object({
  ...modelSettings.properties,
  codemode: Type.Optional(Type.Boolean()),
  tools: Type.Optional(list(Type.Enum(workflowAllowedTools))),
  retry: nullableRetry,
}, strict);

const workflowYamlSchema = Type.Object({
  name: Type.String({ pattern: "^[a-z][a-z0-9_-]{0,63}$" }),
  description: Type.Optional(Type.String()),
  enabled: Type.Optional(Type.Boolean()),
  priority: Type.Optional(Type.Integer()),
  on: triggerSchema,
  permissions: Type.Optional(permissionsSchema),
  defaults: defaultsSchema,
  config: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
}, strict);

export const workflowSettings = Type.Object({
  enabled: Type.Optional(Type.Boolean()),
  priority: Type.Optional(Type.Integer()),
  cron: Type.Optional(Type.String({ minLength: 1 })),
  window: Type.Optional(Type.String({ minLength: 1 })),
  provider: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  thinkingLevel: Type.Optional(modelSettings.properties.thinkingLevel),
  codemode: Type.Optional(Type.Boolean()),
  retry: nullableRetry,
  config: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
}, strict);

export type WorkflowSettings = Static<typeof workflowSettings>;
type ParsedWorkflow = Static<typeof workflowYamlSchema>;
type RetrySettings = Static<typeof retrySettings>;

export type WorkflowDefinition = {
  name: string;
  description?: string;
  enabled: boolean;
  priority: number;
  on: { cron?: string; window?: string; manual: boolean };
  permissions: {
    github: GithubPermission[];
    slack: SlackPermission[];
    workspace: WorkspacePermission[];
  };
  defaults: {
    provider: string;
    model: string;
    thinkingLevel: ParsedWorkflow["defaults"]["thinkingLevel"];
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
  on: { cron?: string; window?: string; manual: boolean };
  defaults: WorkflowDefinition["defaults"];
  config: Record<string, unknown>;
};

const defaultWorkflowTools: ToolName[] = ["read", "grep", "find", "ls", "git"];

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
  const problems: string[] = [];
  if (parsed.name !== folder) problems.push(`name ${parsed.name} must equal folder name ${folder}`);
  if (parsed.name === "directory" || parsed.name === "trustLocalScripts") problems.push(`${parsed.name} is not a legal workflow name`);
  if (parsed.defaults.tools?.includes("github_search") && !parsed.permissions?.github?.includes("read")) {
    problems.push("defaults.tools: github_search requires permissions.github: [read]");
  }
  if (!parsed.on.cron && parsed.on.manual === false) problems.push("on must enable cron or manual");
  if (parsed.on.cron) {
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
    on: {
      cron: parsed.on.cron,
      window: parsed.on.window ?? (parsed.on.cron ? "24h" : undefined),
      manual: parsed.on.manual ?? true,
    },
    permissions: {
      github: parsed.permissions?.github ?? [],
      slack: parsed.permissions?.slack ?? [],
      workspace: parsed.permissions?.workspace ?? [],
    },
    defaults: {
      provider: parsed.defaults.provider,
      model: parsed.defaults.model,
      thinkingLevel: parsed.defaults.thinkingLevel,
      codemode: parsed.defaults.codemode,
      tools: parsed.defaults.tools ?? [...defaultWorkflowTools],
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
    provider: wf.defaults.provider,
    model: wf.defaults.model,
    thinkingLevel: wf.defaults.thinkingLevel,
    ...(wf.defaults.codemode !== undefined ? { codemode: wf.defaults.codemode } : {}),
    retry: wf.retry,
    config: wf.config,
  };
}

export function resolveWorkflow(wf: WorkflowDefinition, entry?: WorkflowSettings): ResolvedWorkflow {
  const cron = entry?.cron ?? wf.on.cron;
  const window = entry?.window ?? wf.on.window ?? (cron ? "24h" : undefined);
  const defaults = {
    ...wf.defaults,
    provider: entry?.provider ?? wf.defaults.provider,
    model: entry?.model ?? wf.defaults.model,
    thinkingLevel: entry?.thinkingLevel ?? wf.defaults.thinkingLevel,
    codemode: entry?.codemode ?? wf.defaults.codemode,
  };
  const config = { ...wf.config, ...(entry?.config ?? {}) };
  return {
    ...wf,
    enabled: entry?.enabled ?? wf.enabled,
    priority: entry?.priority ?? wf.priority,
    on: { cron, window, manual: wf.on.manual },
    defaults,
    config,
    retry: entry?.retry !== undefined ? entry.retry : wf.retry,
    hash: hashJson({ folder: wf.hash, defaults, config }),
  };
}
