import { isDeepStrictEqual } from "node:util";
import { and, asc, count, desc, eq, isNotNull, isNull, notExists, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { type Action, actionContracts, actionIds } from "./actions.ts";
import { config, getActionConfig, isActionEnabled, thinkingLevels } from "./config.ts";
import { itemsInRepository, sameRepository } from "./repository.ts";
import { db } from "./db.ts";
import { describeError } from "./errors.ts";
import { recordEvent } from "./events.ts";
import { withOperationSync } from "./logging.ts";
import { entryStage, hasPublicationSnapshot, hasValidationCheckpoint } from "./results.ts";
import { latestRunOfTask } from "./run-history.ts";
import { asItem } from "./items.ts";
import { items, runs, subjects, tasks, type Task, type Subject } from "./schema.ts";
import { isManual, parseTriggerInput, type TriggerInput } from "./triggers.ts";
import { signalWork } from "./work-signal.ts";

export function latestTask(subjectId: string, action: Action) {
  return db.select().from(tasks).where(and(eq(tasks.subjectId, subjectId), eq(tasks.action, action)))
    .orderBy(desc(tasks.createdAt), desc(tasks.id)).limit(1).get();
}

const isKnownAction = (action: string): action is Action => (actionIds as readonly string[]).includes(action);

function checkClaimable({ task, subject }: { task: Task; subject: Subject }, database: Pick<typeof db, "select">) {
  if (!isKnownAction(task.action)) return { ok: false as const, reason: `Unknown action: ${task.action}` };
  if (!isActionEnabled(task.action)) return { ok: false as const, reason: `Unknown action: ${task.action}` };
  const actionConfig = config.actions[task.action];
  const invalid = [actionConfig, ...("reviewers" in actionConfig ? actionConfig.reviewers : [])]
    .find(({ thinkingLevel }) => !(thinkingLevels as readonly string[]).includes(thinkingLevel));
  if (invalid) return { ok: false as const, reason: `Invalid thinking level for ${task.action}: ${invalid.thinkingLevel}` };
  let trigger;
  try { trigger = parseTriggerInput(task.input); }
  catch (error) { return { ok: false as const, reason: `Invalid trigger input for ${task.action}: ${error instanceof Error ? error.message : String(error)}` }; }
  const { repository } = subject;
  if (!repository) return { ok: false as const, reason: "Subject has no parseable repository" };
  if (!sameRepository(repository, config.github.repository)) return { ok: false as const, reason: `Subject belongs to ${repository}, not ${config.github.repository}` };
  const previousRun = latestRunOfTask(task.id, database);
  if (previousRun && previousRun.sequence === null) return { ok: false as const, reason: `Missing run sequence: ${previousRun.id}` };
  return { ok: true as const, previousRun, trigger };
}

export function enqueueTask(task: Pick<typeof tasks.$inferInsert, "subjectId" | "action" | "priority" | "reason"> & { input: TriggerInput }) {
  return withOperationSync("task.enqueue", { subjectId: task.subjectId, action: task.action }, (operation) => {
    const queued = db.transaction((transaction) => {
      const previous = transaction.select().from(tasks).where(and(
        eq(tasks.subjectId, task.subjectId), eq(tasks.action, task.action), eq(tasks.status, "queued"),
      )).get();
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

const issueActions: ReadonlySet<string> = new Set(["review_issue", "implement"]);

type ManualEnqueueResult = { target: string; number?: number; itemId?: string; taskId?: string; error?: string };

export function enqueueManualTasks(action: string, targets: string[], priority?: number): ManualEnqueueResult[] {
  if (!isKnownAction(action)) throw new Error(`Unknown action: ${action}; expected one of ${actionIds.join(", ")}`);
  if (action === "address_review") throw new Error("address_review needs a review assessment and is queued automatically by sync");
  const candidates = itemsInRepository(config.github.repository);
  return targets.map((target): ManualEnqueueResult => {
    const item = /^\d+$/.test(target) ? candidates.find((candidate) => candidate.payload.number === Number(target))
      : candidates.find((candidate) => candidate.id === target);
    if (!item) return { target, error: `No item ${target} in ${config.github.repository}` };
    const base = { target, number: item.payload.number, itemId: item.id };
    if (item.state !== "open") return { ...base, error: "Item is closed" };
    const needs = issueActions.has(action) ? "issue" : "pr";
    if (item.kind !== needs) return { ...base, error: `${action} needs ${needs === "pr" ? "a PR" : "an issue"}, but ${target} is ${item.kind === "pr" ? "a PR" : "an issue"}` };
    try { return { ...base, taskId: enqueueTask({ subjectId: item.id, action, priority, reason: "Manually enqueued", input: { source: "github_items", kind: "manual", manual: true } }).id }; }
    catch (error) { return { ...base, error: error instanceof Error ? error.message : String(error) }; }
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
      .where(and(eq(tasks.status, "queued"), eq(subjects.state, "open"), notExists(
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
    const settings = retry ?? actionSettings;
    const validationOnly = next.task.retryMode === "validation";
    const publicationResume = !validationOnly && hasPublicationSnapshot(retry) ? retry : undefined;
    const resume = validationOnly ? (hasValidationCheckpoint(retry) ? retry : undefined) : publicationResume;
    const task = transaction.update(tasks).set({ status: "running" }).where(eq(tasks.id, next.task.id)).returning().get()!;
    const run = transaction.insert(runs).values({
      taskId: task.id,
      sequence: sql`(select coalesce(max(${runs.sequence}), 0) + 1 from ${runs})`,
      retryOfRunId: retry?.id,
      inferenceFromRunId: resume?.id,
      input: task.input,
      skill: settings.skill,
      provider: settings.provider,
      model: settings.model,
      thinkingLevel: settings.thinkingLevel,
      reviewers: resume ? resume.reviewers : (retry?.reviewers ?? actionSettings.reviewers)
        .map(({ provider, model, thinkingLevel }) => ({ provider, model, thinkingLevel })),
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
      const failed = transaction.select().from(tasks).where(and(eq(tasks.id, taskId), eq(tasks.status, "failed"))).get();
      if (!failed) throw new Error(`Task is not failed: ${taskId}`);
      const queued = transaction.select().from(tasks).where(and(
        eq(tasks.subjectId, failed.subjectId), eq(tasks.action, failed.action), eq(tasks.status, "queued"),
      )).get();
      if (queued) throw new Error(`A queued task already exists for this subject/action: ${queued.id}`);
      if (mode === "validation") {
        const previous = latestRunOfTask(taskId, transaction);
        if (!isKnownAction(failed.action) || actionContracts[failed.action].mode !== "change" || !hasValidationCheckpoint(previous)
          || !isDeepStrictEqual(previous.input, failed.input)) {
          throw new Error("Validation-only retry requires an unchanged task input and a complete agent checkpoint from a failed validation; use normal retry to repair");
        }
      }
      const updated = transaction.update(tasks).set({ status: "queued", retryMode: mode }).where(eq(tasks.id, taskId)).returning().get()!;
      recordEvent({ subjectId: updated.subjectId, taskId, operationId: operation.operationId, type: "task.retried", data: { action: updated.action, mode } }, transaction);
      return updated;
    }, { behavior: "immediate" });
    operation.complete();
    signalWork();
    return task;
  });
}

export function finishRun(runId: string, outcome: { status: "completed" } | { status: "failed"; error: unknown }) {
  const error = outcome.status === "failed" ? describeError(outcome.error) : null;
  const finished = db.transaction((transaction) => {
    const run = transaction.update(runs).set({ error, finishedAt: new Date().toISOString() })
      .where(and(eq(runs.id, runId), isNull(runs.finishedAt))).returning().get();
    if (!run) throw new Error(`Run not active: ${runId}`);
    const task = transaction.update(tasks).set({ status: outcome.status })
      .where(and(eq(tasks.id, run.taskId), eq(tasks.status, "running"))).returning().get();
    if (!task) throw new Error(`Task not running: ${run.taskId}`);
    const references = { subjectId: task.subjectId, taskId: task.id, runId };
    recordEvent(error ? {
      ...references, type: "run.failed", data: { stage: run.stage, error },
    } : {
      ...references, type: "run.completed", data: { stage: run.stage },
    }, transaction);
    return run;
  }, { behavior: "immediate" });
  signalWork();
  return finished;
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
