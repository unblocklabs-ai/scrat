import { config } from "./config.ts";
import { removeRunDatabase } from "./databases.ts";
import { logger } from "./logging.ts";
import { finishRun } from "./tasks.ts";
import { runCommand } from "./cli.ts";

await runCommand("Run recovery failed", async () => {
  const runId = process.argv[2];
  if (!runId) throw new Error("Usage: npm run recover -- <run-id> (stop all workers first)");
  const run = finishRun(runId, {
    status: "failed",
    error: Object.assign(new Error("Interrupted run recovered manually after stopping workers"), { code: "RUN_INTERRUPTED" }),
  });
  if (config.workspace?.database) await removeRunDatabase(run.id, { taskId: run.taskId });
  logger.info({ event: "run.recovered", runId, taskId: run.taskId });
});
