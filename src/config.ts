import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import settings from "../scrat.config.json" with { type: "json" };
import type { Action } from "./actions.ts";

export const configUrl = new URL("../scrat.config.json", import.meta.url);
const localConfigUrl = new URL("../scrat.local.json", import.meta.url);
export const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

type WorkspaceConfig = {
  environment?: Record<string, string>;
  prepare?: string[][];
  database?: { image: string; environment: string[]; migrate: string[] } | null;
  validate?: string[][];
  heavyCommands?: string[];
};

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
// Objects merge recursively; arrays and primitives replace, and null clears a workspace setting. Every override key must exist in the defaults so a typo fails startup,
// except below the open maps (environment variable names; Pi supports provider fields the defaults do not show).
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
  // Created empty so operators have a place for deployment settings; an existing file is never touched.
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
  const thinkingLevel = thinkingLevels.find((level) => level === actionConfig.thinkingLevel);
  if (!thinkingLevel) throw new Error(`Invalid thinking level for ${action}: ${actionConfig.thinkingLevel}`);
  return {
    ...actionConfig,
    thinkingLevel,
    skill: fileURLToPath(new URL(actionConfig.skill, configUrl)),
    reviewers: "reviewers" in actionConfig ? actionConfig.reviewers.map((reviewer) => {
      const thinkingLevel = thinkingLevels.find((level) => level === reviewer.thinkingLevel);
      if (!thinkingLevel) throw new Error(`Invalid reviewer thinking level: ${reviewer.thinkingLevel}`);
      return { ...reviewer, thinkingLevel };
    }) : [],
  };
}
