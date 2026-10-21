import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import settings from "../scrat.config.json" with { type: "json" };
import type { Action } from "./actions.ts";

export const configUrl = new URL("../scrat.config.json", import.meta.url);
const localConfigUrl = new URL("../scrat.local.json", import.meta.url);
export const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof thinkingLevels)[number];

type WorkspaceConfig = {
  environment?: Record<string, string>;
  prepare?: string[][];
  database?: { image: string; environment: string[]; migrate: string[] } | null;
  validate?: string[][];
  heavyCommands?: string[];
};

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
function merge(defaults: Json, overrides: Json, path = ""): Json {
  const merged: Json = { ...defaults }, open = path === "workspace.environment." || path.startsWith("providers.");
  for (const [key, value] of Object.entries(overrides)) {
    const where = path + key, base = defaults[key];
    if (key === "__proto__" || (!open && !Object.hasOwn(defaults, key))) throw new Error(`Unknown setting in scrat.local.json: ${where}`);
    if (!isObject(base) || (value === null && where.startsWith("workspace"))) merged[key] = value;
    else if (isObject(value)) merged[key] = merge(base, value, where + ".");
    else throw new Error(`Setting in scrat.local.json must be an object${where.startsWith("workspace") ? " or null" : ""}: ${where}`);
  }
  return merged;
}

function loadOverrides(): Json {
  try { writeFileSync(localConfigUrl, "{}\n", { flag: "wx" }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(localConfigUrl, "utf8")); } catch (error) { throw new Error(`Invalid scrat.local.json: ${(error as Error).message}`); }
  if (!isObject(parsed)) throw new Error("Invalid scrat.local.json: expected a JSON object");
  return parsed;
}

export const config: Omit<typeof settings, "workspace"> & { workspace?: WorkspaceConfig } = merge(settings, loadOverrides()) as typeof settings;

export function getRepositoryPath() {
  return resolve(fileURLToPath(new URL(".", configUrl)), process.env.SCRAT_REPOSITORY_PATH ?? config.github.repositoryPath);
}

export function getActionConfig(action: Action) {
  const actionConfig = config.actions[action];
  return {
    ...actionConfig,
    thinkingLevel: actionConfig.thinkingLevel as ThinkingLevel,
    skill: fileURLToPath(new URL(actionConfig.skill, configUrl)),
    reviewers: "reviewers" in actionConfig ? actionConfig.reviewers.map((reviewer) => ({ ...reviewer, thinkingLevel: reviewer.thinkingLevel as ThinkingLevel })) : [],
  };
}

export const isBotLogin = (login: string | null | undefined) => login?.toLowerCase() === config.github.botLogin.toLowerCase();

export const isActionEnabled = (action: Action) => (config.actions[action] as { enabled?: boolean }).enabled !== false;
