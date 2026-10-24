import { isActionEnabled, loadedManifests } from "./config.ts";
import { type EffectName, type Manifest, matches, type Signal } from "./manifests.ts";

export type Action = string;

export const manifests = () => loadedManifests;
export const getManifest = (action: string) => loadedManifests.find((manifest) => manifest.name === action);
export function manifestOf(action: string) {
  const manifest = getManifest(action);
  if (!manifest) throw new Error(`Unknown action: ${action}`);
  return manifest;
}
export const temporaryWorkspaceActions = () => loadedManifests.filter((manifest) => manifest.mode === "review").map((manifest) => manifest.name);

export const actionsPublishing = (effect: EffectName) => loadedManifests.filter((manifest) => manifest.publish.includes(effect)).map((manifest) => manifest.name);
export const actionsTriggeredBy = (kind: Manifest["trigger"]["kind"]) => loadedManifests.filter((manifest) => manifest.trigger.kind === kind).map((manifest) => manifest.name);

export const matchingActions = (signal: Signal) => loadedManifests.filter((manifest) => matches(manifest, signal)).map((manifest) => manifest.name);
export const routeFor = (signal: Signal) => matchingActions(signal).find(isActionEnabled);
