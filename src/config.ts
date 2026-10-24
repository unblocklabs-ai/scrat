import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isAbsolute, resolve } from "node:path";
import settings from "../scrat.config.json" with { type: "json" };
import { buildConfig, type Json } from "./config-merge.ts";
import { configError, validateConfig } from "./config-schema.ts";
import { deploymentDefaults, findTriggerConflicts, readManifests } from "./manifests.ts";

const configUrl = new URL("../scrat.config.json", import.meta.url);
const localConfigUrl = new URL("../scrat.local.json", import.meta.url);

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

function loadOverrides(): Json {
  try { writeFileSync(localConfigUrl, "{}\n", { flag: "wx" }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(localConfigUrl, "utf8")); } catch (error) { throw new Error(`Invalid scrat.local.json: ${(error as Error).message}`); }
  if (!isObject(parsed)) throw new Error("Invalid scrat.local.json: expected a JSON object");
  return parsed;
}

const overrides = loadOverrides();
const directory = isObject(overrides.actions) ? overrides.actions.directory : undefined;
if (directory !== undefined && directory !== null && (typeof directory !== "string" || !isAbsolute(directory))) {
  throw new Error("Invalid scrat.local.json: actions.directory must be an absolute path");
}
export const loadedManifests = readManifests(fileURLToPath(new URL(".", configUrl)), directory);
const actionDefaults = { ...Object.fromEntries(loadedManifests.map((manifest) => [manifest.name, deploymentDefaults(manifest)])), directory: null };

const merged = buildConfig({ ...settings, actions: actionDefaults }, overrides);
delete (merged.actions as Json).directory;
const unknownActions = Object.keys(merged.actions as Json).filter((name) => !loadedManifests.some((manifest) => manifest.name === name));
if (unknownActions.length) throw configError(unknownActions.map((name) => `actions.${name}: unknown action`));
export const config = validateConfig(merged);

const conflicts = findTriggerConflicts(loadedManifests, (manifest) => config.actions[manifest.name]?.enabled !== false);
if (conflicts.length) throw configError(conflicts);

const unbound = loadedManifests.flatMap((manifest) => [manifest.http?.binding, manifest.browser?.binding]
  .filter((name): name is string => name !== undefined && !Object.hasOwn(config.bindings, name)).map((name) => `${manifest.file}: unknown binding ${name}; define it under bindings in scrat.local.json`));
if (unbound.length) throw configError(unbound);

export function getRepositoryPath() {
  return resolve(fileURLToPath(new URL(".", configUrl)), process.env.SCRAT_REPOSITORY_PATH ?? config.github.repositoryPath);
}

export function commitSettings(action: string) {
  const { enabled, branch, maxRangeCommits, channel, startMessage } = config.actions[action] ?? {};
  if (!branch || !maxRangeCommits) throw new Error(`${action} is not a commit action`);
  return { enabled: enabled !== false, branch, maxRangeCommits, channel: channel ?? "", startMessage: startMessage ?? "" };
}

export const isBotLogin = (login: string | null | undefined) => login?.toLowerCase() === config.github.botLogin.toLowerCase();

export const isActionEnabled = (action: string) => config.actions[action] !== undefined && config.actions[action].enabled !== false;
