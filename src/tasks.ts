import { isDeepStrictEqual } from "node:util";
import { and, asc, count, desc, eq, isNotNull, isNull, notExists, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { config, getActionConfig } from "./config.ts";
import { db } from "./db.ts";
import { describeError } from "./errors.ts";
import { recordEvent } from "./events.ts";
import { startOperation } from "./logging.ts";
import { hasPublicationSnapshot } from "./results.ts";
import { events, items, runs, tasks } from "./schema.ts";

export function enqueueTask(task: Pick<typeof tasks.$inferInsert,
  "itemId" | "action" | "priority" | "reason" | "input"
>) {
  const operation = startOperation("task.enqueue", { itemId: task.itemId, action: task.action });
  try {
    const queued = db.transaction((transaction) => {
      const previous = transaction.select().from(tasks).where(and(
        eq(tasks.itemId, task.itemId), eq(tasks.action, task.action), eq(tasks.status, "queued"),
      )).get();
      const queuedTask = transaction.insert(tasks).values({ ...task, priority: task.priority ?? config.actions[task.action].priority }).onConflictDoUpdate({
        target: [tasks.itemId, tasks.action],
        targetWhere: sql`${tasks.status} = 'queued'`,
        set: {
          priority: task.priority ?? tasks.priority,
          reason: task.reason,
          input: task.input,
        },
      }).returning().get()!;
      const references = { itemId: queuedTask.itemId, taskId: queuedTask.id, operationId: operation.operationId };
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
    return queued;
  } catch (err) {
    operation.fail(err);
    throw err;
  }
}

export function claimTask() {
  return db.transaction((transaction) => {
    const active = transaction.select({ count: count() }).from(tasks).where(eq(tasks.status, "running")).get()!;
    if (active.count >= config.harness.maxConcurrency) return;
    const busyTasks = alias(tasks, "busy_tasks");
    const busyItems = alias(items, "busy_items");
    const next = transaction.select({ task: tasks, item: items }).from(tasks)
      .innerJoin(items, eq(tasks.itemId, items.id))
      .where(and(eq(tasks.status, "queued"), eq(items.state, "open"), notExists(
        transaction.select({ id: busyTasks.id }).from(busyTasks)
          .innerJoin(busyItems, eq(busyTasks.itemId, busyItems.id))
          .where(and(eq(busyTasks.status, "running"), or(
            eq(busyTasks.itemId, tasks.itemId),
            and(isNotNull(items.workspaceId), eq(busyItems.workspaceId, items.workspaceId)),
          ))),
      )))
      .orderBy(desc(tasks.priority), asc(tasks.createdAt), asc(tasks.id)).limit(1).get();
    if (!next) return;
    const previous = transaction.select({ run: runs, sequence: events.id }).from(runs)
      .leftJoin(events, and(eq(events.runId, runs.id), eq(events.type, "run.started")))
      .where(eq(runs.taskId, next.task.id)).orderBy(desc(events.id)).limit(1).get();
    if (previous && previous.sequence === null) throw new Error(`Missing run.started event: ${previous.run.id}`);
    const previousRun = previous?.run;
    const retry = previousRun?.error && isDeepStrictEqual(previousRun.input, next.task.input) ? previousRun : undefined;
    const actionSettings = getActionConfig(next.task.action);
    const settings = retry ?? actionSettings;
    const resume = hasPublicationSnapshot(retry) ? retry : undefined;
    const task = transaction.update(tasks).set({ status: "running" }).where(eq(tasks.id, next.task.id)).returning().get()!;
    const run = transaction.insert(runs).values({
      taskId: task.id,
      retryOfRunId: retry?.id,
      input: task.input,
      skill: settings.skill,
      provider: settings.provider,
      model: settings.model,
      thinkingLevel: settings.thinkingLevel,
      reviewers: resume ? resume.reviewers : (retry?.reviewers ?? actionSettings.reviewers)
        .map(({ provider, model, thinkingLevel }) => ({ provider, model, thinkingLevel })),
      workspaceId: resume?.workspaceId ?? next.item.workspaceId,
      ...(resume ? {
        context: resume.context, result: resume.result, mainSha: resume.mainSha, headSha: resume.headSha,
        piSessionId: resume.piSessionId, piSessionFile: resume.piSessionFile,
        stage: "publishing", publication: { ...resume.publication, status: "pending" },
        verification: resume.verification,
      } : {}),
      startedAt: new Date().toISOString(),
    }).returning().get()!;
    recordEvent({ itemId: task.itemId, taskId: task.id, runId: run.id, type: "run.started", data: {
      action: task.action, skill: run.skill, provider: run.provider, model: run.model, thinkingLevel: run.thinkingLevel,
    } }, transaction);
    return { task, item: next.item, run };
  }, { behavior: "immediate" });
}

export function retryTask(taskId: string) {
  const operation = startOperation("task.retry", { taskId });
  try {
    const task = db.transaction((transaction) => {
      const failed = transaction.select().from(tasks).where(and(eq(tasks.id, taskId), eq(tasks.status, "failed"))).get();
      if (!failed) throw new Error(`Task is not failed: ${taskId}`);
      const queued = transaction.select().from(tasks).where(and(
        eq(tasks.itemId, failed.itemId), eq(tasks.action, failed.action), eq(tasks.status, "queued"),
      )).get();
      if (queued) throw new Error(`A queued task already exists for this item/action: ${queued.id}`);
      const updated = transaction.update(tasks).set({ status: "queued" }).where(eq(tasks.id, taskId)).returning().get()!;
      recordEvent({ itemId: updated.itemId, taskId, operationId: operation.operationId, type: "task.retried", data: { action: updated.action } }, transaction);
      return updated;
    }, { behavior: "immediate" });
    operation.complete();
    return task;
  } catch (error) {
    operation.fail(error);
    throw error;
  }
}

export function finishRun(runId: string, outcome: { status: "completed" } | { status: "failed"; error: unknown }) {
  const error = outcome.status === "failed" ? describeError(outcome.error) : null;
  return db.transaction((transaction) => {
    const run = transaction.update(runs).set({ error, finishedAt: new Date().toISOString() })
      .where(and(eq(runs.id, runId), isNull(runs.finishedAt))).returning().get();
    if (!run) throw new Error(`Run not active: ${runId}`);
    const task = transaction.update(tasks).set({ status: outcome.status })
      .where(and(eq(tasks.id, run.taskId), eq(tasks.status, "running"))).returning().get();
    if (!task) throw new Error(`Task not running: ${run.taskId}`);
    const references = { itemId: task.itemId, taskId: task.id, runId };
    recordEvent(error ? {
      ...references, type: "run.failed", data: { stage: run.stage, error },
    } : {
      ...references, type: "run.completed", data: { stage: run.stage },
    }, transaction);
    return run;
  }, { behavior: "immediate" });
}

export function cancelQueuedTasks(itemId: string, reason: string, action?: typeof tasks.$inferSelect.action) {
  return db.transaction((transaction) => {
    const cancelled = transaction.update(tasks).set({ status: "cancelled" }).where(and(
      eq(tasks.itemId, itemId), eq(tasks.status, "queued"), action ? eq(tasks.action, action) : undefined,
    )).returning().all();
    for (const task of cancelled) {
      recordEvent({ itemId, taskId: task.id, type: "task.cancelled", data: { action: task.action, reason } }, transaction);
    }
    return cancelled;
  }, { behavior: "immediate" });
}
