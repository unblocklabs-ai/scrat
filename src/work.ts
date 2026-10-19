import { config } from "./config.ts";
import { db } from "./db.ts";
import { logger } from "./logging.ts";
import { runNextTask } from "./runner.ts";
import { validateStaticConfig } from "./startup.ts";

try {
  await validateStaticConfig();
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
} finally {
  db.$client.close();
}
