import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isAbsolute, resolve } from "node:path";
import settings from "../scrat.config.json" with { type: "json" };
import { buildConfig, type Json } from "./config-merge.ts";
import type { Binding } from "./bindings.ts";
import { deploymentDefaults, findTriggerConflicts, readManifests, skillPath, thinkingLevels, type ThinkingLevel } from "./manifests.ts";

const configUrl = new URL("../scrat.config.json", import.meta.url);
const localConfigUrl = new URL("../scrat.local.json", import.meta.url);
export { thinkingLevels, type ThinkingLevel };

type WorkspaceConfig = {
  environment?: Record<string, string>;
  prepare?: string[][];
  database?: { image: string; environment: string[]; migrate: string[] } | null;
  validate?: string[][];
  heavyCommands?: string[];
};

type ModelEntry = { provider: string; model: string; thinkingLevel: string };
export type ActionSettings = ModelEntry & {
  enabled?: boolean; priority: number; skill: string; agent: string; reviewers?: ModelEntry[]; branch?: string; channel?: string;
  maxRangeCommits?: number; startMessage?: string; maxSelfRepairs?: number; exhaustedLabel?: string | null;
};

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
export const config: Omit<typeof settings, "workspace" | "bindings"> & { workspace?: WorkspaceConfig; bindings: Record<string, Binding>; actions: Record<string, ActionSettings> } = merged as never;

const conflicts = findTriggerConflicts(loadedManifests, (manifest) => config.actions[manifest.name]?.enabled !== false);
if (conflicts.length) throw new Error(`Invalid Scrat configuration:\n${conflicts.map((conflict) => `- ${conflict}`).join("\n")}`);

const unbound = loadedManifests.flatMap((manifest) => [manifest.http?.binding, manifest.browser?.binding]
  .filter((name): name is string => name !== undefined && !Object.hasOwn(config.bindings, name)).map((name) => `${manifest.file}: unknown binding ${name}; define it under bindings in scrat.local.json`));
if (unbound.length) throw new Error(`Invalid Scrat configuration:\n${unbound.map((problem) => `- ${problem}`).join("\n")}`);

export function getRepositoryPath() {
  return resolve(fileURLToPath(new URL(".", configUrl)), process.env.SCRAT_REPOSITORY_PATH ?? config.github.repositoryPath);
}

export function commitSettings(action: string) {
  const { enabled, branch, maxRangeCommits, channel, startMessage } = config.actions[action] ?? {};
  if (!branch || !maxRangeCommits) throw new Error(`${action} is not a commit action`);
  return { enabled: enabled !== false, branch, maxRangeCommits, channel: channel ?? "", startMessage: startMessage ?? "" };
}

export function getActionConfig(action: string) {
  const manifest = loadedManifests.find((candidate) => candidate.name === action), actionConfig = config.actions[action];
  if (!manifest || !actionConfig) throw new Error(`Unknown action: ${action}`);
  return {
    ...actionConfig,
    thinkingLevel: actionConfig.thinkingLevel as ThinkingLevel,
    skill: skillPath(manifest, actionConfig.skill),
    reviewers: (actionConfig.reviewers ?? []).map((reviewer) => ({ ...reviewer, thinkingLevel: reviewer.thinkingLevel as ThinkingLevel })),
  };
}

export const isBotLogin = (login: string | null | undefined) => login?.toLowerCase() === config.github.botLogin.toLowerCase();

export const isActionEnabled = (action: string) => config.actions[action] !== undefined && config.actions[action].enabled !== false;
