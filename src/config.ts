import { fileURLToPath } from "node:url";
import settings from "../scrat.config.json" with { type: "json" };

const configUrl = new URL("../scrat.config.json", import.meta.url);

export const config = settings;

export function getActionConfig(action: keyof typeof config.actions) {
  const actionConfig = config.actions[action];
  return {
    ...actionConfig,
    skill: fileURLToPath(new URL(actionConfig.skill, configUrl)),
  };
}
