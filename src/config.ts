import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isAbsolute, resolve } from "node:path";
import settings from "../scrat.config.json" with { type: "json" };
import { buildConfig, isObject, type Json } from "./config-merge.ts";
import { configError, validateConfig } from "./config-schema.ts";
import { findTriggerConflicts } from "./manifests.ts";
import { readWorkflows, resolveWorkflow, workflowDeploymentDefaults } from "./workflows.ts";

const configUrl = new URL("../scrat.config.json", import.meta.url);
const localConfigUrl = new URL("../scrat.local.json", import.meta.url);

function loadOverrides(): Json {
  try { writeFileSync(localConfigUrl, "{}\n", { flag: "wx" }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(localConfigUrl, "utf8")); } catch (error) { throw new Error(`Invalid scrat.local.json: ${(error as Error).message}`); }
  if (!isObject(parsed)) throw new Error("Invalid scrat.local.json: expected a JSON object");
  return parsed;
}

const overrides = loadOverrides();
if (isObject(overrides.actions) && overrides.actions.directory !== undefined && overrides.actions.directory !== null) {
  throw new Error("Invalid scrat.local.json: actions.directory is no longer supported; use workflows.directory instead");
}
const workflowOverrides = isObject(overrides.workflows) ? overrides.workflows : undefined;
const workflowDirectory = workflowOverrides?.directory;
if (workflowDirectory !== undefined && workflowDirectory !== null && (typeof workflowDirectory !== "string" || !isAbsolute(workflowDirectory))) {
  throw new Error("Invalid scrat.local.json: workflows.directory must be an absolute path");
}
const trustLocalScripts = workflowOverrides?.trustLocalScripts;
if (trustLocalScripts !== undefined && typeof trustLocalScripts !== "boolean") {
  throw new Error("Invalid scrat.local.json: workflows.trustLocalScripts must be a boolean");
}
export const trustLocalWorkflowScripts = trustLocalScripts === true;
const repoRoot = fileURLToPath(new URL(".", configUrl));
export const loadedWorkflows = readWorkflows(repoRoot, workflowDirectory);

const migratedWorkflowTopKeys = new Set(["enabled", "priority", "cron", "window", "branch", "provider", "model", "thinkingLevel", "reviewers", "codemode", "retry", "skill"]);
const migratedWorkflowConfigKeys = new Set(["targets", "issue_labels", "pr_labels", "channel", "browserSteps", "browserSeconds", "maxRangeCommits", "startMessage", "rootInstructions", "maxSelfRepairs", "exhaustedLabel", "failedLabel"]);

function normalizeMigratedOverrides(raw: Json): Json {
  if (!isObject(raw.actions)) return raw;
  const workflowNames = new Set(loadedWorkflows.map((wf) => wf.name));
  const unknownActions = Object.keys(raw.actions).filter((name) => name !== "directory" && !workflowNames.has(name));
  if (unknownActions.length) throw configError(unknownActions.map((name) => `actions.${name}: unknown action`));
  const nextWorkflows: Json = isObject(raw.workflows) ? { ...raw.workflows } : {};
  for (const [name, legacy] of Object.entries(raw.actions)) {
    if (name === "directory" || !isObject(legacy)) continue;
    const translated: Json = {};
    const translatedConfig: Json = {};
    for (const [key, value] of Object.entries(legacy)) {
      if (key === "skill" && typeof value === "string") translated[key] = isAbsolute(value) ? value : resolve(repoRoot, value);
      else if (migratedWorkflowTopKeys.has(key)) translated[key] = value;
      else if (migratedWorkflowConfigKeys.has(key)) translatedConfig[key] = value;
      else if (key === "config" && isObject(value)) Object.assign(translatedConfig, value);
      else translated[key] = value;
    }
    if (Object.keys(translatedConfig).length) translated.config = translatedConfig;
    const existing = isObject(nextWorkflows[name]) ? nextWorkflows[name] : {};
    nextWorkflows[name] = {
      ...translated,
      ...existing,
      ...(isObject(translated.config) || isObject(existing.config)
        ? { config: { ...(isObject(translated.config) ? translated.config : {}), ...(isObject(existing.config) ? existing.config : {}) } }
        : {}),
    };
  }
  const rest = { ...raw };
  delete rest.actions;
  return { ...rest, workflows: nextWorkflows };
}

const normalizedOverrides = normalizeMigratedOverrides(overrides);
const workflowDefaults = { ...Object.fromEntries(loadedWorkflows.map((wf) => [wf.name, workflowDeploymentDefaults(wf)])), directory: null, trustLocalScripts: false };

const merged = buildConfig({ ...settings, workflows: workflowDefaults }, normalizedOverrides);
if (isObject(merged.workflows)) {
  delete merged.workflows.directory;
  delete merged.workflows.trustLocalScripts;
}
const unknownWorkflows = isObject(merged.workflows)
  ? Object.keys(merged.workflows as Json).filter((name) => !loadedWorkflows.some((wf) => wf.name === name))
  : [];
if (unknownWorkflows.length) throw configError(unknownWorkflows.map((name) => `workflows.${name}: unknown workflow`));
export const config = validateConfig(merged);

const conflicts = findTriggerConflicts(
  loadedWorkflows.flatMap((wf) => {
    const resolved = resolveWorkflow(wf, config.workflows[wf.name]);
    return resolved.on.event ? [{ file: resolved.file, trigger: resolved.on.event, enabled: resolved.enabled }] : [];
  }),
  (entry) => entry.enabled,
);
if (conflicts.length) throw configError(conflicts);

const unbound = loadedWorkflows.flatMap((wf) => [wf.http?.binding, wf.browser?.binding]
  .filter((name): name is string => name !== undefined && !Object.hasOwn(config.bindings, name))
  .map((name) => `${wf.file}: unknown binding ${name}; define it under bindings in scrat.local.json`));
if (unbound.length) throw configError(unbound);

export function getRepositoryPath() {
  return resolve(fileURLToPath(new URL(".", configUrl)), process.env.SCRAT_REPOSITORY_PATH ?? config.github.repositoryPath);
}

export const isBotLogin = (login: string | null | undefined) => login?.toLowerCase() === config.github.botLogin.toLowerCase();
export const isWorkflowEnabled = (name: string) => config.workflows[name] !== undefined && config.workflows[name].enabled !== false;
