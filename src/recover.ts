import { db } from "./db.ts";
import { config } from "./config.ts";
import { removeRunDatabase } from "./databases.ts";
import { logger } from "./logging.ts";
import { finishRun } from "./tasks.ts";
import { drainStatus } from "./slack-status.ts";

try {
  const runId = process.argv[2];
  if (!runId) throw new Error("Usage: npm run recover -- <run-id> (stop all workers first)");
  const run = finishRun(runId, {
    status: "failed",
    error: Object.assign(new Error("Interrupted run recovered manually after stopping workers"), { code: "RUN_INTERRUPTED" }),
  });
  if (config.workspace?.database) await removeRunDatabase(run.id, { taskId: run.taskId });
  logger.info({ event: "run.recovered", runId, taskId: run.taskId });
} catch (error) {
  logger.error({ err: error }, "Run recovery failed");
  process.exitCode = 1;
} finally {
  await drainStatus();
  db.$client.close();
}
