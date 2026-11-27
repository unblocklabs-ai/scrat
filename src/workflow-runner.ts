import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Logger } from "pino";
import { trustLocalWorkflowScripts } from "./config.ts";
import { db } from "./db.ts";
import { eq } from "drizzle-orm";
import type { EventReferences } from "./events.ts";
import { git } from "./git.ts";
import type { Item } from "./items.ts";
import { getRun, updateRun } from "./run-history.ts";
import { items, type Run, type Subject, type Task, tasks } from "./schema.ts";
import { isManual, parseTriggerInput, type TriggerInput } from "./triggers.ts";
import { createWorkflowContext, type WorkflowContext, type WorkflowPipelineRunner } from "./workflow-ctx.ts";
import type { ResolvedWorkflow } from "./workflows.ts";

type WorkflowFn = (ctx: WorkflowContext) => Promise<unknown>;
function completedItem(parsed: TriggerInput) {
  if (parsed.kind !== "workflow_completed") return {};
  const found = parsed.subjectId && parsed.item?.title !== undefined ? undefined
    : db.select({ id: items.id, kind: items.kind, payload: items.payload }).from(tasks).innerJoin(items, eq(items.id, tasks.subjectId)).where(eq(tasks.id, parsed.taskId)).get();
  const item = found ? { id: found.id, kind: found.kind, number: found.payload.number, title: found.payload.title } : parsed.item && parsed.subjectId && parsed.item.title !== undefined ? { id: parsed.subjectId, kind: parsed.item.kind, number: parsed.item.number, title: parsed.item.title } : undefined;
  return item ? { item } : {};
}

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
  item,
  references,
  repositoryPath,
  operation,
  stop,
  cleanup,
  onTargetObserved,
  runPipeline,
  replay,
}: {
  workflow: ResolvedWorkflow;
  task: Task;
  run: Run;
  subject: Subject;
  item?: Item;
  references: EventReferences;
  repositoryPath: string;
  operation: { log: Logger };
  stop: AbortSignal;
  cleanup: { reviewWorkspace?: { id: string } };
  onTargetObserved?: (target: string) => void;
  runPipeline?: WorkflowPipelineRunner;
  replay?: { frozen: ReadonlySet<string>; baseSha?: string };
}) {
  if (workflow.local && workflow.scriptPath && !trustLocalWorkflowScripts) {
    throw new Error(`Refusing to execute local workflow script ${workflow.scriptPath}: it runs in-process as operator-trusted code; set workflows.trustLocalScripts: true in scrat.local.json to allow it`);
  }
  const parsed = parseTriggerInput(task.input);
  const dryRun = replay !== undefined || ("replayOf" in task.input && task.input.replayOf !== undefined)
    || (parsed.kind === "workflow_manual" && parsed.dryRun === true);
  const trigger: WorkflowContext["trigger"] = parsed.kind === "tick"
    ? { kind: "cron", manual: false, input: { start: parsed.start, end: parsed.end }, start: parsed.start, end: parsed.end }
    : parsed.kind === "workflow_manual"
      ? { kind: "manual", manual: true, input: parsed.payload ?? {} }
      : {
          kind: "event",
          manual: isManual(parsed),
          input: parsed as Record<string, unknown>,
          ...(item ? { item: { id: item.id, kind: item.kind, number: item.payload.number, title: item.payload.title } } : completedItem(parsed)),
        };

  const { ctx, hasPublishedEffects, usedManagedPipeline } = createWorkflowContext({
    workflow,
    task,
    run,
    subject,
    item,
    references,
    repositoryPath,
    log: operation.log,
    signal: stop,
    dryRun,
    trigger,
    onWorkspaceAcquired: (ws) => { cleanup.reviewWorkspace = ws; },
    onWorkspaceReleased: () => { cleanup.reviewWorkspace = undefined; },
    onTargetObserved,
    runPipeline,
    replay,
  });

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

  if (usedManagedPipeline()) {
    if (dryRun) {
      const latest = getRun(run.id);
      if (latest && latest.publication.status === "pending") {
        updateRun(run.id, { publication: { ...latest.publication, status: "not_needed" } });
      }
    }
    return output;
  }

  const latest = getRun(run.id);
  const summary = typeof output === "string"
    ? output
    : output && typeof output === "object" && "text" in output && typeof (output as { text?: unknown }).text === "string"
      ? (output as { text: string }).text
      : JSON.stringify(output ?? { ok: true }, null, 2);

  updateRun(run.id, {
    result: latest?.result ?? { outcome: "complete", text: summary, paths: [], ready: false },
    publication: { ...(latest?.publication ?? {}), status: hasPublishedEffects() ? "published" : "not_needed" },
  });
  return output;
}
