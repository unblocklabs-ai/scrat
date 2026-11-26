import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { desc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-sqlite";
import { config, getRepositoryPath } from "./config.ts";
import { isObject } from "./config-merge.ts";
import type { db } from "./db.ts";
import { SupersededError } from "./errors.ts";
import { items, runs, steps, subjects, tasks } from "./schema.ts";
import { isWorkflow, workflowOf } from "./workflow-registry.ts";

type Database = Pick<typeof db, "select">;
const isEffect = (name: string) => name.startsWith("__effect:");

function readJournal(database: Database, id: string) {
  const requestedRun = database.select().from(runs).where(eq(runs.id, id)).get();
  const task = database.select().from(tasks).where(eq(tasks.id, requestedRun?.taskId ?? id)).get();
  if (!task) throw new Error(`Unknown run or task: ${id}`);
  const latest = database.select().from(runs).where(eq(runs.taskId, task.id)).orderBy(desc(runs.sequence)).limit(1).get();
  if (!latest) throw new Error(`Task ${task.id} has no runs`);
  const run = requestedRun ?? latest;
  const subject = database.select().from(subjects).where(eq(subjects.id, task.subjectId)).get()!;
  const journal = database.select().from(steps).where(eq(steps.taskId, task.id)).orderBy(steps.startedAt, sql`rowid`).all();
  const warning = run.id !== latest.id ? `Run ${run.id} is not the latest run of task ${task.id}; the journal reflects run ${latest.id}` : undefined;
  return { run, task, subject, journal, warning, latestRunId: latest.id };
}

function readOnly<T>(reader: (database: Database) => T): T {
  const client = new DatabaseSync("data/scrat.sqlite", { readOnly: true, timeout: config.harness.sqliteBusyTimeoutMs });
  try {
    client.exec("BEGIN");
    return reader(drizzle({ client }));
  }
  finally { client.close(); }
}

export function inspectWorkflow(id: string, name?: string, json = false) {
  const { run, task, subject, journal, warning, latestRunId } = readOnly((database) => readJournal(database, id));
  if (warning) console.error(`WARN\t${warning}`);
  const currentHash = isWorkflow(task.action) ? workflowOf(task.action).hash : null;
  const entries = journal.map(({ taskId: _taskId, output, ...step }) => ({
    ...step,
    durationMs: step.finishedAt ? Date.parse(step.finishedAt) - Date.parse(step.startedAt) : null,
    drift: currentHash === null ? null : step.workflowHash !== currentHash,
    outputBytes: output === null ? 0 : Buffer.byteLength(JSON.stringify(output)),
  }));
  const selected = name === undefined ? undefined : entries.find((step) => step.name === name);
  if (name !== undefined && !selected) throw new Error(`Unknown step ${name}; available: ${entries.map((step) => step.name).join(", ") || "(none)"}`);
  const step = selected && { ...selected, output: journal.find((row) => row.name === selected.name)!.output };
  const inspection = {
    workflow: task.action, runId: run.id, taskId: task.id, subject: { id: subject.id, kind: subject.kind, key: subject.key, repository: subject.repository },
    triggerKind: run.input.kind ?? task.input.kind ?? null,
    status: warning ? run.error?.name === "SupersededError" ? "cancelled" : run.error ? "failed" : run.finishedAt ? "completed" : "running" : task.status,
    latestRunId, warning, currentWorkflowHash: currentHash,
    steps: entries.filter((entry) => !isEffect(entry.name)), effects: entries.filter((entry) => isEffect(entry.name)), step,
  };
  if (json || step) {
    console.log(JSON.stringify(json ? inspection : step?.output, null, 2));
    return;
  }
  console.log(`WORKFLOW\t${inspection.workflow}\nRUN\t${run.id}\nTASK\t${task.id}\nSUBJECT\t${subject.kind}:${subject.key}\nTRIGGER\t${inspection.triggerKind}\nSTATUS\t${inspection.status}`);
  const print = (label: string, rows: typeof entries) => {
    console.log(label);
    for (const row of rows) console.log([row.name, row.status, row.durationMs === null ? "-" : `${row.durationMs}ms`,
      row.inputHash.slice(0, 8), row.workflowHash.slice(0, 8), row.drift ? "DRIFT" : "-", `${row.outputBytes}B`].join("\t"));
  };
  print("STEPS", inspection.steps);
  print("EFFECTS", inspection.effects);
}

function planReplay(database: Database, id: string, from?: string) {
  const original = readJournal(database, id);
  const journal = original.journal.filter((step) => !isEffect(step.name));
  if (!journal.length) throw new Error("managed-pipeline workflows are not replayable");
  const start = from === undefined ? journal.length : journal.findIndex((step) => step.name === from);
  if (start < 0) throw new Error(`Unknown step ${from}; available: ${journal.map((step) => step.name).join(", ")}`);
  const frozen = journal.slice(0, start).filter((step) => step.status === "completed");
  const names = new Set(frozen.map((step) => step.name));
  return { ...original, frozen, names, fresh: journal.filter((step) => !names.has(step.name)) };
}

export function printReplayPlan(id: string, from?: string) {
  const plan = readOnly((database) => planReplay(database, id, from));
  if (plan.warning) console.error(`WARN\t${plan.warning}`);
  console.log(`FROZEN\t${plan.frozen.map((step) => step.name).join(", ") || "(none)"}`);
  console.log(`FRESH\t${plan.fresh.map((step) => step.name).join(", ") || "(none)"}`);
}

function replayItem(database: Database, original: ReturnType<typeof readJournal>) {
  let { run, subject } = original;
  const seen = new Set<string>();
  while (subject.kind === "workflow" && typeof run.input.replayOf === "string" && !seen.has(run.id)) {
    seen.add(run.id);
    const parent = database.select({ run: runs, subject: subjects }).from(runs)
      .innerJoin(tasks, eq(tasks.id, runs.taskId)).innerJoin(subjects, eq(subjects.id, tasks.subjectId))
      .where(eq(runs.id, run.input.replayOf)).get();
    if (!parent) break;
    ({ run, subject } = parent);
  }
  return { subject, item: database.select().from(items).where(eq(items.id, subject.id)).get() };
}

export async function replayWorkflow(id: string, from?: string, overrides?: Record<string, unknown>) {
  const { db } = await import("./db.ts");
  const { recordEvent } = await import("./events.ts");
  const { asItem, upsertSubject } = await import("./items.ts");
  const { startOperation } = await import("./logging.ts");
  const { finishRun } = await import("./tasks.ts");
  const { runWorkflow } = await import("./workflow-runner.ts");
  const taskId = randomUUID();
  const pidDirectory = resolve("data/cli-tasks");
  const pidFile = resolve(pidDirectory, `${taskId}.pid`);
  const stop = new AbortController();
  const onSignal = (signal: NodeJS.Signals) => stop.abort(new SupersededError(`Cancelled by user (${signal})`));
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  let pidWritten = false;
  try {
    const { original, workflow, task, run, subject, item } = db.transaction((transaction) => {
      const original = planReplay(transaction, id, from);
      const workflow = workflowOf(original.task.action);
      const baseline = original.run.input;
      const patch = baseline.kind === "workflow_manual" && overrides !== undefined
        ? { payload: { ...(isObject(baseline.payload) ? baseline.payload : {}), ...overrides } }
        : overrides;
      const input = { ...baseline, ...patch, replayOf: original.run.id };
      const prior = replayItem(transaction, original);
      const subject = upsertSubject({ kind: "workflow", key: `${workflow.name}:replay:${randomUUID()}`, repository: original.subject.repository }, "open", transaction);
      const task = transaction.insert(tasks).values({ id: taskId, subjectId: subject.id, action: workflow.name,
        priority: workflow.priority, reason: `Replay of ${original.run.id}`, input, status: "running" }).returning().get()!;
      const { provider, model, thinkingLevel } = workflow.defaults;
      const skill = workflow.skillPath ?? workflow.scriptPath ?? workflow.file;
      const run = transaction.insert(runs).values({ taskId, input, skill, provider, model, thinkingLevel,
        headSha: original.run.headSha, startedAt: new Date().toISOString(),
        sequence: sql`(select coalesce(max(${runs.sequence}), 0) + 1 from ${runs})`,
      }).returning().get()!;
      for (const step of original.frozen) transaction.insert(steps).values({ ...step, taskId }).run();
      recordEvent({ subjectId: subject.id, taskId, runId: run.id, type: "run.started", data: { action: task.action, skill, provider, model, thinkingLevel } }, transaction);
      mkdirSync(pidDirectory, { recursive: true });
      writeFileSync(pidFile, `${process.pid}\n`, { flag: "wx" });
      pidWritten = true;
      return { original, workflow, task, run, subject, item: prior.item && asItem(prior.item, prior.subject) };
    }, { behavior: "immediate" });
    if (original.warning) console.error(`WARN\t${original.warning}`);
    const references = { subjectId: subject.id, taskId, runId: run.id };
    const operation = startOperation("workflow.replay", { ...references, action: workflow.name });
    try {
      stop.signal.throwIfAborted();
      await runWorkflow({ workflow, task, run, subject, item, references, repositoryPath: getRepositoryPath(), operation, stop: stop.signal,
        cleanup: {}, replay: { frozen: original.names, baseSha: original.run.headSha ?? undefined } });
      stop.signal.throwIfAborted();
    } catch (error) {
      const superseded = error instanceof SupersededError ? error : stop.signal.reason instanceof SupersededError ? stop.signal.reason : undefined;
      const status = superseded ? "cancelled" : "failed";
      const failed = finishRun(run.id, { status, error: superseded ?? error });
      return { status, run: failed } as const;
    }
    const completed = finishRun(run.id, { status: "completed" });
    operation.complete();
    return { status: "completed", run: completed, preview: resolve("data/workflow-dry-runs", `${workflow.name}-${run.id.slice(0, 8)}`) } as const;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    if (pidWritten) rmSync(pidFile, { force: true });
  }
}
