import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import settings from "../scrat.config.json" with { type: "json" };

const configUrl = new URL("../scrat.config.json", import.meta.url);
export const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

type WorkspaceConfig = {
  prepare?: string[][];
  database?: { image: string; environment: string[]; migrate: string[] } | null;
  validate?: string[][];
};

export const config: Omit<typeof settings, "workspace"> & { workspace?: WorkspaceConfig } = settings;

export function getRepositoryPath() {
  return resolve(fileURLToPath(new URL(".", configUrl)), config.github.repositoryPath);
}

export function getActionConfig(action: keyof typeof config.actions) {
  const actionConfig = config.actions[action];
  const thinkingLevel = thinkingLevels.find((level) => level === actionConfig.thinkingLevel);
  if (!thinkingLevel) throw new Error(`Invalid thinking level for ${action}: ${actionConfig.thinkingLevel}`);
  return {
    ...actionConfig,
    thinkingLevel,
    skill: fileURLToPath(new URL(actionConfig.skill, configUrl)),
  };
}
