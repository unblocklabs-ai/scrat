import { isDeepStrictEqual } from "node:util";
import { and, eq, sql } from "drizzle-orm";
import { db } from "./db.ts";
import { recordEvent } from "./events.ts";
import { startOperation } from "./logging.ts";
import { tasks } from "./schema.ts";

export function enqueueTask(task: Pick<typeof tasks.$inferInsert,
  "itemId" | "action" | "priority" | "reason" | "input"
>) {
  const operation = startOperation("task.enqueue", { itemId: task.itemId, action: task.action });
  try {
    const queued = db.transaction((transaction) => {
      const previous = transaction.select().from(tasks).where(and(
        eq(tasks.itemId, task.itemId), eq(tasks.action, task.action), eq(tasks.status, "queued"),
      )).get();
      const queuedTask = transaction.insert(tasks).values(task).onConflictDoUpdate({
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
