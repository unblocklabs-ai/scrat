import { and, eq, sql } from "drizzle-orm";
import { db } from "./db.ts";
import { recordEvent } from "./events.ts";
import { tasks } from "./schema.ts";

export function enqueueTask(task: Pick<typeof tasks.$inferInsert,
  "itemId" | "action" | "priority" | "reason" | "input"
>) {
  return db.transaction((transaction) => {
    const previous = transaction.select().from(tasks).where(and(
      eq(tasks.itemId, task.itemId), eq(tasks.action, task.action), eq(tasks.status, "queued"),
    )).get();
    const queued = transaction.insert(tasks).values(task).onConflictDoUpdate({
      target: [tasks.itemId, tasks.action],
      targetWhere: sql`${tasks.status} = 'queued'`,
      set: {
        priority: task.priority ?? tasks.priority,
        reason: task.reason,
        input: task.input,
      },
    }).returning().get()!;
    const references = { itemId: queued.itemId, taskId: queued.id };
    recordEvent(previous ? {
      ...references,
      type: "task.coalesced",
      data: {
        action: queued.action,
        previous: { priority: previous.priority, reason: previous.reason },
        current: { priority: queued.priority, reason: queued.reason },
        inputChanged: JSON.stringify(previous.input) !== JSON.stringify(queued.input),
      },
    } : {
      ...references,
      type: "task.enqueued",
      data: { action: queued.action, priority: queued.priority, reason: queued.reason },
    }, transaction);
    return queued;
  }, { behavior: "immediate" });
}
