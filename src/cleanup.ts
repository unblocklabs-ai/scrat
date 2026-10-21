import { and, eq, inArray, isNotNull, isNull, notExists } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { temporaryWorkspaceActions } from "./actions.ts";
import { config } from "./config.ts";
import { db } from "./db.ts";
import { listRunDatabases, removeRunDatabase } from "./databases.ts";
import { logger } from "./logging.ts";
import { getRun } from "./run-history.ts";
import { runs, tasks, workspaces } from "./schema.ts";
import { removeWorkspace } from "./workspaces.ts";

try {
  const active = alias(runs, "active_run");
  const pending = db.selectDistinct({ workspace: workspaces }).from(workspaces)
    .innerJoin(runs, eq(runs.workspaceId, workspaces.id)).innerJoin(tasks, eq(runs.taskId, tasks.id))
    .where(and(isNotNull(runs.finishedAt), isNull(workspaces.removedAt), inArray(tasks.action, temporaryWorkspaceActions),
      notExists(db.select({ id: active.id }).from(active).where(and(eq(active.workspaceId, workspaces.id), isNull(active.finishedAt)))),
    )).all();
  for (const { workspace } of pending) {
    try { await removeWorkspace(workspace.id); }
    catch { process.exitCode = 1; }
  }
  for (const runId of config.workspace?.database ? await listRunDatabases() : []) {
    const run = getRun(runId);
    if (run?.finishedAt) {
      try { await removeRunDatabase(runId, { taskId: run.taskId }); }
      catch { process.exitCode = 1; }
    }
  }
} catch (error) {
  logger.error({ err: error }, "Cleanup command failed");
  process.exitCode = 1;
} finally {
  db.$client.close();
}
