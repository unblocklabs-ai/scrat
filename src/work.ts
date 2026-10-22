import { config } from "./config.ts";
import { db } from "./db.ts";
import { logger } from "./logging.ts";
import { runNextTask } from "./runner.ts";
import { prepareService } from "./startup.ts";
import { drainStatus } from "./slack-status.ts";

try {
  await prepareService();
  const workers = Array.from({ length: config.harness.maxConcurrency }, async () => {
    while (true) {
      const run = await runNextTask();
      if (!run) return;
      if (run.error) process.exitCode = 1;
    }
  });
  const outcomes = await Promise.allSettled(workers);
  for (const outcome of outcomes) {
    if (outcome.status === "rejected") {
      logger.error({ err: outcome.reason }, "Worker failed");
      process.exitCode = 1;
    }
  }
} catch (error) {
  logger.error({ err: error, event: "work.failed" }, "Work failed");
  process.exitCode = 1;
} finally {
  await drainStatus();
  db.$client.close();
}
