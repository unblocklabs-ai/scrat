import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { tasks } from "./schema.ts";

export function enqueueTask(task: Pick<typeof tasks.$inferInsert,
  "itemId" | "action" | "priority" | "reason" | "input"
>) {
  return db.insert(tasks).values(task).onConflictDoUpdate({
    target: [tasks.itemId, tasks.action],
    targetWhere: sql`${tasks.status} = 'queued'`,
    set: {
      priority: task.priority ?? tasks.priority,
      reason: task.reason,
      input: task.input,
    },
  }).returning().get()!;
}
