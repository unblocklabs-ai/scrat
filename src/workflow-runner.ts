import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Logger } from "pino";
import { trustLocalWorkflowScripts } from "./config.ts";
import type { EventReferences } from "./events.ts";
import { git } from "./git.ts";
import { updateRun } from "./run-history.ts";
import type { Run, Subject, Task } from "./schema.ts";
import { parseTriggerInput } from "./triggers.ts";
import { createWorkflowContext, type WorkflowContext } from "./workflow-ctx.ts";
import type { ResolvedWorkflow } from "./workflows.ts";

type WorkflowFn = (ctx: WorkflowContext) => Promise<unknown>;
const loadedModules = new Map<string, WorkflowFn>();

export async function loadWorkflowScript(scriptPath: string): Promise<WorkflowFn> {
  const cached = loadedModules.get(scriptPath);
  if (cached) return cached;
  const mod = await import(pathToFileURL(scriptPath).href) as { default?: unknown };
  if (typeof mod.default !== "function") {
    throw new Error(`Workflow script ${scriptPath} must export a default async function(ctx)`);
  }
  const fn = mod.default as WorkflowFn;
  loadedModules.set(scriptPath, fn);
  return fn;
}

export async function runWorkflow({
  workflow,
  task,
  run,
  subject,
  references,
  repositoryPath,
  operation,
  stop,
  cleanup,
}: {
  workflow: ResolvedWorkflow;
  task: Task;
  run: Run;
  subject: Subject;
  references: EventReferences;
  repositoryPath: string;
  operation: { log: Logger };
  stop: AbortSignal;
  cleanup: { reviewWorkspace?: { id: string } };
}) {
  if (workflow.local && workflow.scriptPath && !trustLocalWorkflowScripts) {
    throw new Error(`Refusing to execute local workflow script ${workflow.scriptPath}: it runs in-process as operator-trusted code; set workflows.trustLocalScripts: true in scrat.local.json to allow it`);
  }
  const parsed = parseTriggerInput(task.input);
  const dryRun = parsed.kind === "workflow_manual" && parsed.dryRun === true;
  const trigger: WorkflowContext["trigger"] = parsed.kind === "tick"
    ? { kind: "cron", input: { start: parsed.start, end: parsed.end }, start: parsed.start, end: parsed.end }
    : { kind: "manual", input: parsed.kind === "workflow_manual" ? (parsed.payload ?? {}) : {} };

  const { ctx, hasPublishedEffects } = createWorkflowContext({
    workflow,
    task,
    run,
    subject,
    references,
    repositoryPath,
    log: operation.log,
    signal: stop,
    dryRun,
    trigger,
    onWorkspaceAcquired: (ws) => { cleanup.reviewWorkspace = ws; },
    onWorkspaceReleased: () => { cleanup.reviewWorkspace = undefined; },
  });

  updateRun(run.id, { stage: "agent" });

  let output: unknown;
  if (workflow.scriptPath) {
    const fn = await loadWorkflowScript(workflow.scriptPath);
    output = await fn(ctx);
  } else {
    const runAgent = (cwd: string, baseSha?: string) => ctx.step("agent", { trigger: trigger.input, baseSha }, async () => {
      const res = await ctx.agent.run({ cwd, input: trigger.input });
      if (res.outcome !== "complete") {
        updateRun(run.id, { result: { outcome: res.outcome, text: res.text, paths: res.paths, ready: false } });
        throw new Error(`Workflow ${workflow.name} agent finished ${res.outcome}`);
      }
      return res;
    });
    if (workflow.permissions.workspace.includes("read")) {
      output = await ctx.workspace.withCheckout(ctx.workspace.baseBranch, (ws) => runAgent(ws.path, ws.baseSha));
    } else {
      const isolated = await mkdtemp(join(tmpdir(), `scrat-wf-${workflow.name}-cwd-`));
      try {
        await git(isolated, ["init", "-q"]);
        output = await runAgent(isolated);
      } finally {
        await rm(isolated, { recursive: true, force: true });
      }
    }
  }

  const summary = typeof output === "string"
    ? output
    : output && typeof output === "object" && "text" in output && typeof (output as { text?: unknown }).text === "string"
      ? (output as { text: string }).text
      : JSON.stringify(output ?? { ok: true }, null, 2);

  updateRun(run.id, {
    result: { outcome: "complete", text: summary, paths: [], ready: false },
    publication: { status: hasPublishedEffects() ? "published" : "not_needed" },
  });
  return output;
}
