import { isActionEnabled, config, loadedManifests } from "./config.ts";
import { matches, skillPath, type EffectName, type Signal } from "./manifests.ts";

export const manifests = loadedManifests;
export function manifestOf(action: string) {
  const manifest = manifests.find((candidate) => candidate.name === action);
  if (!manifest) throw new Error(`Unknown action: ${action}`);
  return manifest;
}

export function getActionConfig(action: string) {
  const actionConfig = config.actions[action];
  if (!actionConfig) throw new Error(`Unknown action: ${action}`);
  return { ...actionConfig, skill: skillPath(manifestOf(action), actionConfig.skill) };
}

export const actionsPublishing = (effect: EffectName) => manifests.filter((manifest) => manifest.publish.includes(effect)).map((manifest) => manifest.name);

export const matchingActions = (signal: Signal) => manifests.filter((manifest) => matches(manifest, signal)).map((manifest) => manifest.name);
export const routeFor = (signal: Signal) => matchingActions(signal).find(isActionEnabled);
