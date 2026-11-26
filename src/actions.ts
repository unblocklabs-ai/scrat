import { isWorkflowEnabled, config, loadedWorkflows } from "./config.ts";
import type { EffectName, Signal } from "./manifests.ts";
import { matchesWorkflowSignal, resolveWorkflow } from "./workflows.ts";

export const workflows = loadedWorkflows;

export const isWorkflow = (name: string) => workflows.some((candidate) => candidate.name === name);

export function workflowOf(name: string) {
  const wf = workflows.find((candidate) => candidate.name === name);
  if (!wf) throw new Error(`Unknown workflow: ${name}`);
  return resolveWorkflow(wf, config.workflows[name]);
}

export const defaultPriorityOf = (name: string) => workflowOf(name).priority;

export const actionsPublishing = (effect: EffectName) => (
  effect === "labels"
    ? workflows.filter((wf) => wf.on.event?.kind === "item_changed" && wf.on.event.item === "issue" && wf.permissions.github.includes("label")).map((wf) => wf.name)
    : effect === "pr_assessment"
      ? workflows.filter((wf) => wf.on.event?.kind === "item_changed" && wf.on.event.item === "pr").map((wf) => wf.name)
      : effect === "pull_request"
        ? workflows.filter((wf) => wf.mode === "change" && wf.on.event?.kind === "label" && wf.permissions.github.includes("pull_request")).map((wf) => wf.name)
        : []
);

export const matchingActions = (signal: Signal) =>
  workflows.filter((wf) => matchesWorkflowSignal(workflowOf(wf.name), signal)).map((wf) => wf.name);

export const routeFor = (signal: Signal) => matchingActions(signal).find((name) => isWorkflowEnabled(name));
