import { and, eq, inArray, isNotNull, isNull, notExists } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { db } from "./db.ts";
import { logger } from "./logging.ts";
import { runs, tasks, workspaces } from "./schema.ts";
import { removeWorkspace } from "./workspaces.ts";

try {
  const active = alias(runs, "active_run");
  const pending = db.selectDistinct({ workspace: workspaces }).from(workspaces)
    .innerJoin(runs, eq(runs.workspaceId, workspaces.id)).innerJoin(tasks, eq(runs.taskId, tasks.id))
    .where(and(isNotNull(runs.finishedAt), isNull(workspaces.removedAt), inArray(tasks.action, ["review_issue", "review_pr"]),
      notExists(db.select({ id: active.id }).from(active).where(and(eq(active.workspaceId, workspaces.id), isNull(active.finishedAt)))),
    )).all();
  for (const { workspace } of pending) {
    try { await removeWorkspace(workspace.id); }
    catch { process.exitCode = 1; }
  }
} catch (error) {
  logger.error({ err: error }, "Cleanup command failed");
  process.exitCode = 1;
} finally {
  db.$client.close();
}
