import { fileURLToPath } from "node:url";
import settings from "../scrat.config.json" with { type: "json" };

const configUrl = new URL("../scrat.config.json", import.meta.url);
const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

export const config = settings;

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
