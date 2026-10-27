import { db } from "./db.ts";
import { isNull } from "drizzle-orm";
import { config } from "./config.ts";
import { removeRunDatabase } from "./databases.ts";
import { logger } from "./logging.ts";
import { runs } from "./schema.ts";
import { interruptRun } from "./tasks.ts";
import { runCommand } from "./cli.ts";

await runCommand("Run recovery failed", async () => {
  for (const run of db.select().from(runs).where(isNull(runs.finishedAt)).all()) {
    try {
      interruptRun(run.id);
      if (config.workspace.database) await removeRunDatabase(run.id, { taskId: run.taskId });
      logger.info({ event: "run.recovered", runId: run.id, taskId: run.taskId, requeued: true });
    } catch (error) {
      logger.error({ err: error, event: "run.recovery_failed", runId: run.id, taskId: run.taskId }, "Run recovery failed");
    }
  }
});
