import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, isAbsolute, resolve } from "node:path";
import settings from "../scrat.config.json" with { type: "json" };
import { buildConfig, isObject, type Json } from "./config-merge.ts";
import { configError, validateConfig } from "./config-schema.ts";
import { findTriggerConflicts } from "./manifests.ts";
import { findCompletionCycles, readWorkflowRepo, readWorkflows, resolveWorkflow, workflowDeploymentDefaults } from "./workflows.ts";

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
if (overrides.actions !== undefined) {
  throw configError(["actions: unknown setting; use workflows instead"]);
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
const workflowRepo = readWorkflowRepo(workflowOverrides?.repo);
const layers = [];
if (workflowRepo) {
  let checkout = process.env.SCRAT_WORKFLOWS_CHECKOUT;
  if (checkout === undefined) {
    const instruction = 'run "npm run workflow -- sync"';
    try { checkout = realpathSync(resolve("data/workflows-repo/current")); }
    catch (error) { throw new Error(`Cannot resolve the active workflows checkout; ${instruction}`, { cause: error }); }
    if (basename(checkout) !== workflowRepo.ref) throw new Error(`Active workflows checkout is ${basename(checkout)}, expected ${workflowRepo.ref}; ${instruction}`);
  } else {
    checkout = realpathSync(checkout);
  }
  for (const layer of workflowRepo.layers) layers.push({ dir: resolve(checkout, layer), origin: `repo:${layer}`, strict: true, local: true });
}
if (workflowDirectory) layers.push({ dir: workflowDirectory, origin: "directory", strict: false, local: true });
export const loadedWorkflows = readWorkflows(repoRoot, layers);

const workflowDefaults = { ...Object.fromEntries(loadedWorkflows.map((wf) => [wf.name, workflowDeploymentDefaults(wf)])), directory: null, trustLocalScripts: false, repo: null };

const merged = buildConfig({ ...settings, workflows: workflowDefaults }, overrides);
if (isObject(merged.workflows)) {
  delete merged.workflows.directory;
  delete merged.workflows.trustLocalScripts;
  delete merged.workflows.repo;
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

const cycles = findCompletionCycles(loadedWorkflows);
if (cycles.length) throw configError(cycles);

const unbound = loadedWorkflows.flatMap((wf) => [wf.http?.binding, wf.browser?.binding]
  .filter((name): name is string => name !== undefined && !Object.hasOwn(config.bindings, name))
  .map((name) => `${wf.file}: unknown binding ${name}; define it under bindings in scrat.local.json`));
if (unbound.length) throw configError(unbound);

export function getRepositoryPath() {
  return resolve(fileURLToPath(new URL(".", configUrl)), process.env.SCRAT_REPOSITORY_PATH ?? config.github.repositoryPath);
}

export const isBotLogin = (login: string | null | undefined) => login?.toLowerCase() === config.github.botLogin.toLowerCase();
export const isWorkflowEnabled = (name: string) => config.workflows[name] !== undefined && config.workflows[name].enabled !== false;
