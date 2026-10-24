import { isDeepStrictEqual } from "node:util";
import { and, asc, count, desc, eq, isNotNull, isNull, lte, notExists, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { type Action, getManifest, manifests } from "./actions.ts";
import { config, getActionConfig, isActionEnabled } from "./config.ts";
import { itemsInRepository, sameRepository } from "./repository.ts";
import { db } from "./db.ts";
import { describeError, type ErrorDetails, errorCode, errorMessage, transientInferenceCode } from "./errors.ts";
import { recordEvent, type JournalEvent } from "./events.ts";
import { withOperationSync } from "./logging.ts";
import { entryStage, hasPublicationSnapshot, hasValidationCheckpoint, InterruptedError } from "./results.ts";
import { getRun, latestRunOfTask } from "./run-history.ts";
import { asItem } from "./items.ts";
import { items, runs, type Run, subjects, tasks, type Task, type Subject } from "./schema.ts";
import { isBaseOnly, isManual, parseTriggerInput, type TriggerInput } from "./triggers.ts";
import { signalWork } from "./work-signal.ts";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

const queuedTaskOf = (transaction: Pick<typeof db, "select">, subjectId: string, action: Action) =>
  transaction.select().from(tasks).where(and(eq(tasks.subjectId, subjectId), eq(tasks.action, action), eq(tasks.status, "queued"))).get();

export function latestTask(subjectId: string, action: Action) {
  return db.select().from(tasks).where(and(eq(tasks.subjectId, subjectId), eq(tasks.action, action)))
    .orderBy(desc(tasks.createdAt), desc(tasks.id)).limit(1).get();
}

export function configuredReviewers(action: Action, single = false) {
  const reviewers = getActionConfig(action).reviewers.map(({ provider, model, thinkingLevel }) => ({ provider, model, thinkingLevel }));
  return single ? reviewers.slice(0, 1) : reviewers;
}

const isKnownAction = (action: string) => getManifest(action) !== undefined;

function checkClaimable({ task, subject }: { task: Task; subject: Subject }, database: Pick<typeof db, "select">) {
  if (!isActionEnabled(task.action)) return { ok: false as const, reason: `Unknown action: ${task.action}` };
  let trigger;
  try { trigger = parseTriggerInput(task.input); }
  catch (error) { return { ok: false as const, reason: `Invalid trigger input for ${task.action}: ${errorMessage(error)}` }; }
  const { repository } = subject;
  if (!repository) return { ok: false as const, reason: "Subject has no parseable repository" };
  if (!sameRepository(repository, config.github.repository)) return { ok: false as const, reason: `Subject belongs to ${repository}, not ${config.github.repository}` };
  const previousRun = latestRunOfTask(task.id, database);
  return { ok: true as const, previousRun, trigger };
}

export function enqueueTask(task: Pick<typeof tasks.$inferInsert, "subjectId" | "action" | "priority" | "reason"> & { input: TriggerInput }) {
  return withOperationSync("task.enqueue", { subjectId: task.subjectId, action: task.action }, (operation) => {
    if (!isKnownAction(task.action)) throw new Error(`Unknown action: ${task.action}`);
    const queued = db.transaction((transaction) => {
      const previous = queuedTaskOf(transaction, task.subjectId, task.action);
      const input = isManual(task.input) && previous ? { ...previous.input, manual: true }
        : previous && isManual(previous.input) ? { ...task.input, manual: true } : task.input;
      const queuedTask = transaction.insert(tasks).values({ ...task, input, priority: task.priority ?? config.actions[task.action].priority }).onConflictDoUpdate({
        target: [tasks.subjectId, tasks.action],
        targetWhere: sql`${tasks.status} = 'queued'`,
        set: {
          priority: task.priority ?? tasks.priority,
          reason: task.reason,
          input,
          retryMode: "repair",
          retryCount: null,
          availableAt: null,
        },
      }).returning().get()!;
      const references = { subjectId: queuedTask.subjectId, taskId: queuedTask.id, operationId: operation.operationId };
      recordEvent(previous ? {
        ...references,
        type: "task.coalesced",
        data: {
          action: queuedTask.action,
          previous: { priority: previous.priority, reason: previous.reason },
          current: { priority: queuedTask.priority, reason: queuedTask.reason },
          inputChanged: !isDeepStrictEqual(previous.input, queuedTask.input),
        },
      } : {
        ...references,
        type: "task.enqueued",
        data: { action: queuedTask.action, priority: queuedTask.priority, reason: queuedTask.reason },
      }, transaction);
      return queuedTask;
    }, { behavior: "immediate" });
    operation.complete({ taskId: queued.id, priority: queued.priority });
    signalWork();
    return queued;
  });
}

type ManualEnqueueResult = { target: string; number?: number; itemId?: string; taskId?: string; error?: string };

export function enqueueManualTasks(action: string, targets: string[], priority?: number): ManualEnqueueResult[] {
  const manifest = getManifest(action);
  if (!manifest) throw new Error(`Unknown action: ${action}; expected one of ${manifests().map(({ name }) => name).join(", ")}`);
  if (manifest.trigger.manual === false) throw new Error(`${action} is queued automatically by sync and cannot be enqueued by hand`);
  const needs = manifest.trigger.item;
  if (!needs) throw new Error(`${action} is not triggered by an issue or PR`);
  const candidates = itemsInRepository(config.github.repository);
  return targets.map((target): ManualEnqueueResult => {
    const item = /^\d+$/.test(target) ? candidates.find((candidate) => candidate.payload.number === Number(target))
      : candidates.find((candidate) => candidate.id === target);
    if (!item) return { target, error: `No item ${target} in ${config.github.repository}` };
    const base = { target, number: item.payload.number, itemId: item.id };
    if (item.state !== "open") return { ...base, error: "Item is closed" };
    if (item.kind !== needs) return { ...base, error: `${action} needs ${needs === "pr" ? "a PR" : "an issue"}, but ${target} is ${item.kind === "pr" ? "a PR" : "an issue"}` };
    try { return { ...base, taskId: enqueueTask({ subjectId: item.id, action, priority, reason: "Manually enqueued", input: { source: "github_items", kind: "manual", manual: true } }).id }; }
    catch (error) { return { ...base, error: errorMessage(error) }; }
  });
}

export function claimTask() {
  return db.transaction((transaction) => {
    const active = transaction.select({ count: count() }).from(tasks).where(eq(tasks.status, "running")).get()!;
    if (active.count >= config.harness.maxConcurrency) return;
    const busyTasks = alias(tasks, "busy_tasks");
    const busySubjects = alias(subjects, "busy_subjects");
    const select = () => transaction.select({ task: tasks, subject: subjects }).from(tasks)
      .innerJoin(subjects, eq(tasks.subjectId, subjects.id))
      .where(and(eq(tasks.status, "queued"), eq(subjects.state, "open"), or(isNull(tasks.availableAt), lte(tasks.availableAt, new Date().toISOString())), notExists(
        transaction.select({ id: busyTasks.id }).from(busyTasks)
          .innerJoin(busySubjects, eq(busyTasks.subjectId, busySubjects.id))
          .where(and(eq(busyTasks.status, "running"), or(
            eq(busyTasks.subjectId, tasks.subjectId),
            and(isNotNull(subjects.workspaceId), eq(busySubjects.workspaceId, subjects.workspaceId)),
          ))),
      )))
      .orderBy(desc(tasks.priority), asc(tasks.createdAt), asc(tasks.id)).limit(1).get();
    let next, claimable;
    while ((next = select())) {
      claimable = checkClaimable(next, transaction);
      if (claimable.ok) break;
      transaction.update(tasks).set({ status: "failed" }).where(eq(tasks.id, next.task.id)).run();
      recordEvent({ subjectId: next.task.subjectId, taskId: next.task.id, type: "task.rejected", data: { action: next.task.action, reason: claimable.reason } }, transaction);
    }
    if (!next || !claimable?.ok) return;
    const previousRun = claimable.previousRun;
    const retry = previousRun?.error && isDeepStrictEqual(previousRun.input, next.task.input) ? previousRun : undefined;
    const actionSettings = getActionConfig(next.task.action);
    const validationOnly = next.task.retryMode === "validation";
    const publicationResume = !validationOnly && hasPublicationSnapshot(retry) ? retry : undefined;
    const resume = validationOnly ? (hasValidationCheckpoint(retry) ? retry : undefined) : publicationResume;
    const prior = retry?.error?.name === "InterruptedError" && !resume ? undefined : retry;
    const pinned = getManifest(next.task.action)?.mode === "review" && !resume ? undefined : prior;
    const settings = pinned ?? actionSettings;
    const task = transaction.update(tasks).set({ status: "running" }).where(eq(tasks.id, next.task.id)).returning().get()!;
    const run = transaction.insert(runs).values({
      taskId: task.id,
      sequence: sql`(select coalesce(max(${runs.sequence}), 0) + 1 from ${runs})`,
      retryOfRunId: prior?.id,
      inferenceFromRunId: resume?.id,
      input: task.input,
      skill: settings.skill,
      provider: settings.provider,
      model: settings.model,
      thinkingLevel: settings.thinkingLevel,
      reviewers: resume ? resume.reviewers : pinned?.reviewers ?? configuredReviewers(task.action, isBaseOnly(claimable.trigger)),
      workspaceId: resume?.workspaceId ?? next.subject.workspaceId,
      stage: entryStage(retry, next.task.retryMode),
      ...(resume ? {
        context: resume.context, result: resume.result, mainSha: resume.mainSha, headSha: resume.headSha,
        piSessionId: resume.piSessionId, piSessionFile: resume.piSessionFile,
        agentCheckpoint: resume.agentCheckpoint,
        publication: publicationResume ? { ...resume.publication, status: "pending" } : { status: "pending" },
        verification: publicationResume?.verification,
      } : {}),
      startedAt: new Date().toISOString(),
    }).returning().get()!;
    if (!previousRun && claimable.trigger.kind === "low_grade") {
      transaction.update(items).set({ selfRepairCount: sql`${items.selfRepairCount} + 1` }).where(eq(items.id, task.subjectId)).run();
    }
    recordEvent({ subjectId: task.subjectId, taskId: task.id, runId: run.id, type: "run.started", data: {
      action: task.action, skill: run.skill, provider: run.provider, model: run.model, thinkingLevel: run.thinkingLevel,
    } }, transaction);
    const item = transaction.select().from(items).where(eq(items.id, task.subjectId)).get();
    return { task, subject: next.subject, item: item && asItem(item, next.subject), run };
  }, { behavior: "immediate" });
}

export function retryTask(taskId: string, mode: Task["retryMode"] = "repair") {
  return withOperationSync("task.retry", { taskId }, (operation) => {
    const task = db.transaction((transaction) => {
      const waiting = transaction.select().from(tasks).where(and(eq(tasks.id, taskId), eq(tasks.status, "queued"), isNotNull(tasks.availableAt))).get();
      if (waiting && mode !== "repair") throw new Error(`A delayed task can only be retried in repair mode: ${taskId}`);
      const delayed = transaction.update(tasks).set({ availableAt: null })
        .where(and(eq(tasks.id, taskId), eq(tasks.status, "queued"), isNotNull(tasks.availableAt))).returning().get();
      if (delayed) {
        recordEvent({ subjectId: delayed.subjectId, taskId, operationId: operation.operationId, type: "task.retried", data: { action: delayed.action, mode } }, transaction);
        return delayed;
      }
      const failed = transaction.select().from(tasks).where(and(eq(tasks.id, taskId), eq(tasks.status, "failed"))).get();
      if (!failed) throw new Error(`Task is not failed: ${taskId}`);
      const queued = queuedTaskOf(transaction, failed.subjectId, failed.action);
      if (queued) throw new Error(`A queued task already exists for this subject/action: ${queued.id}`);
      if (mode === "validation") {
        const previous = latestRunOfTask(taskId, transaction);
        if (getManifest(failed.action)?.mode !== "change" || !hasValidationCheckpoint(previous)
          || !isDeepStrictEqual(previous.input, failed.input)) {
          throw new Error("Validation-only retry requires an unchanged task input and a complete agent checkpoint from a failed validation; use normal retry to repair");
        }
      }
      const updated = transaction.update(tasks).set({ status: "queued", retryMode: mode, retryCount: null, availableAt: null }).where(eq(tasks.id, taskId)).returning().get()!;
      recordEvent({ subjectId: updated.subjectId, taskId, operationId: operation.operationId, type: "task.retried", data: { action: updated.action, mode } }, transaction);
      return updated;
    }, { behavior: "immediate" });
    operation.complete();
    signalWork();
    return task;
  });
}

function closeRun(transaction: Transaction, runId: string, error: ErrorDetails | null, plan: (run: Run) => { set: Partial<typeof tasks.$inferInsert>; event: JournalEvent }) {
  const run = transaction.update(runs).set({ error, finishedAt: new Date().toISOString() })
    .where(and(eq(runs.id, runId), isNull(runs.finishedAt))).returning().get();
  if (!run) throw new Error(`Run not active: ${runId}`);
  const { set, event } = plan(run);
  const task = transaction.update(tasks).set(set).where(and(eq(tasks.id, run.taskId), eq(tasks.status, "running"))).returning().get();
  if (!task) throw new Error(`Task not running: ${run.taskId}`);
  recordEvent({ subjectId: task.subjectId, taskId: task.id, runId, ...event }, transaction);
  return run;
}

export function finishRun(runId: string, outcome: { status: "completed" } | { status: "failed"; error: unknown }) {
  const error = outcome.status === "failed" ? describeError(outcome.error) : null;
  const finished = db.transaction((transaction) => closeRun(transaction, runId, error, (run) => ({
    set: { status: outcome.status, ...outcome.status === "completed" ? { retryCount: null, availableAt: null } : {} },
    event: error ? { type: "run.failed", data: { stage: run.stage, error } } : { type: "run.completed", data: { stage: run.stage } },
  })), { behavior: "immediate" });
  signalWork();
  return finished;
}

export function retryTransientFailure(runId: string, error: unknown) {
  const run = getRun(runId);
  const task = run && db.select().from(tasks).where(eq(tasks.id, run.taskId)).get();
  const retry = task && getManifest(task.action)?.mode === "review" ? config.actions[task.action]?.retry : undefined;
  if (!run || !retry || run.stage !== "agent" || errorCode(error) !== transientInferenceCode) return false;
  interruptRun(runId, error, retry);
  return true;
}

export function interruptRun(runId: string, error: unknown = new InterruptedError("Worker stopped before finishing this run"), retry?: { initialDelaySeconds: number; maxDelaySeconds: number }) {
  const details = describeError(error);
  const interrupted = db.transaction((transaction) => closeRun(transaction, runId, details, (run) => {
    const own = transaction.select().from(tasks).where(eq(tasks.id, run.taskId)).get()!;
    const superseded = queuedTaskOf(transaction, own.subjectId, own.action);
    const retryMode = hasValidationCheckpoint(run) ? "validation" : "repair";
    const attempt = (own.retryCount ?? 0) + 1;
    const delaySeconds = retry && Math.min(retry.maxDelaySeconds, retry.initialDelaySeconds * 2 ** (attempt - 1) * (1 + config.harness.retryJitter * Math.random()));
    const nextAttemptAt = delaySeconds === undefined ? undefined : new Date(Date.now() + delaySeconds * 1000).toISOString();
    return {
      set: superseded ? { status: "failed" } : { status: "queued", retryMode, ...nextAttemptAt ? { retryCount: attempt, availableAt: nextAttemptAt } : {} },
      event: superseded ? { type: "run.failed", data: { stage: run.stage, error: details } }
        : { type: "run.requeued", data: { stage: run.stage, retryMode, ...nextAttemptAt ? { attempt, nextAttemptAt } : {} } },
    };
  }), { behavior: "immediate" });
  signalWork();
  return interrupted;
}

export function cancelQueuedTasks(subjectId: string, reason: string, action?: Task["action"], keepManual = false) {
  return db.transaction((transaction) => {
    const cancelled = transaction.update(tasks).set({ status: "cancelled" }).where(and(
      eq(tasks.subjectId, subjectId), eq(tasks.status, "queued"), action ? eq(tasks.action, action) : undefined,
      keepManual ? sql`coalesce(json_extract(${tasks.input}, '$.manual'), 0) != 1` : undefined,
    )).returning().all();
    for (const task of cancelled) {
      recordEvent({ subjectId, taskId: task.id, type: "task.cancelled", data: { action: task.action, reason } }, transaction);
    }
    return cancelled;
  }, { behavior: "immediate" });
}
