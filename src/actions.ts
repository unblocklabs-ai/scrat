import { loadedManifests } from "./config.ts";

export type Action = string;

export const manifests = () => loadedManifests;
export const getManifest = (action: string) => loadedManifests.find((manifest) => manifest.name === action);
export function manifestOf(action: string) {
  const manifest = getManifest(action);
  if (!manifest) throw new Error(`Unknown action: ${action}`);
  return manifest;
}
export const temporaryWorkspaceActions = () => loadedManifests.filter((manifest) => manifest.mode === "review").map((manifest) => manifest.name);
