import { isNull } from "drizzle-orm";
import { config } from "./config.ts";
import { removeRunDatabase } from "./databases.ts";
import { db } from "./db.ts";
import { logger } from "./logging.ts";
import { runs } from "./schema.ts";
import { finishRun } from "./tasks.ts";

try {
  for (const run of db.select().from(runs).where(isNull(runs.finishedAt)).all()) {
    try {
      finishRun(run.id, { status: "failed", error: Object.assign(new Error("Worker stopped before finishing this run"), { code: "RUN_INTERRUPTED" }) });
      if (config.workspace?.database) await removeRunDatabase(run.id, { taskId: run.taskId });
      logger.info({ event: "run.recovered", runId: run.id, taskId: run.taskId });
    } catch (error) {
      logger.error({ err: error, event: "run.recovery_failed", runId: run.id, taskId: run.taskId }, "Run recovery failed");
    }
  }
} finally { db.$client.close(); }
