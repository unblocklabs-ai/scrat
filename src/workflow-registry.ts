import { isWorkflowEnabled, config, loadedWorkflows } from "./config.ts";
import type { Signal } from "./manifests.ts";
import { isAdvisory, matchesWorkflowSignal, resolveWorkflow } from "./workflows.ts";

export const workflows = loadedWorkflows;

export const isWorkflow = (name: string) => workflows.some((candidate) => candidate.name === name);

export function workflowOf(name: string) {
  const wf = workflows.find((candidate) => candidate.name === name);
  if (!wf) throw new Error(`Unknown workflow: ${name}`);
  return resolveWorkflow(wf, config.workflows[name]);
}

export const defaultPriorityOf = (name: string) => workflowOf(name).priority;

export const workflowsPublishing = (effect: "labels" | "pr_assessment") => workflows.filter((wf) => !isAdvisory(wf) && wf.on.event?.kind === "item_changed" && (
  effect === "labels" ? wf.on.event.item === "issue" && wf.permissions.github.includes("label") : wf.on.event.item === "pr"
)).map((wf) => wf.name);

export const matchingWorkflows = (signal: Signal) =>
  workflows.filter((wf) => matchesWorkflowSignal(workflowOf(wf.name), signal)).map((wf) => wf.name);

export const routeFor = (signal: Signal) => matchingWorkflows(signal).find((name) => !isAdvisory(workflowOf(name)) && isWorkflowEnabled(name));

export const advisoryFor = (signal: Signal) => matchingWorkflows(signal).filter((name) => isAdvisory(workflowOf(name)));
