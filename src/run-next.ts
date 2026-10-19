import { db } from "./db.ts";
import { logger } from "./logging.ts";
import { runNextTask } from "./runner.ts";

try {
  const run = await runNextTask();
  if (run?.error) process.exitCode = 1;
} catch (error) {
  logger.error({ err: error }, "Run command failed");
  process.exitCode = 1;
} finally {
  db.$client.close();
}
