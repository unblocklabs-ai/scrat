import { isActionEnabled, config, loadedManifests, loadedWorkflows } from "./config.ts";
import { matches, resolveAction, type EffectName, type Signal } from "./manifests.ts";
import { resolveWorkflow } from "./workflows.ts";

export const manifests = loadedManifests;
export const workflows = loadedWorkflows;

export const isWorkflow = (name: string) => workflows.some((candidate) => candidate.name === name);

export function workflowOf(name: string) {
  const wf = workflows.find((candidate) => candidate.name === name);
  if (!wf) throw new Error(`Unknown workflow: ${name}`);
  return resolveWorkflow(wf, config.workflows?.[name]);
}

export function manifestOf(action: string) {
  const manifest = manifests.find((candidate) => candidate.name === action);
  if (!manifest) throw new Error(`Unknown action: ${action}`);
  return resolveAction(manifest, config.actions[action]!);
}

export const defaultPriorityOf = (name: string) => isWorkflow(name) ? workflowOf(name).priority : config.actions[name]!.priority;

export const actionsPublishing = (effect: EffectName) => manifests.filter((manifest) => manifest.publish.includes(effect)).map((manifest) => manifest.name);

export const matchingActions = (signal: Signal) => manifests.filter((manifest) => matches(manifest, signal)).map((manifest) => manifest.name);
export const routeFor = (signal: Signal) => matchingActions(signal).find(isActionEnabled);
