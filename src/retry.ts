import { db } from "./db.ts";
import { logger } from "./logging.ts";
import { retryTask } from "./tasks.ts";
import { drainStatus } from "./slack-status.ts";

try {
  const [taskId, ...flags] = process.argv.slice(2);
  if (!taskId || taskId.startsWith("-") || flags.length > 1 || flags.some((flag) => flag !== "--validation-only")) {
    throw new Error("Usage: npm run retry -- <task-id> [--validation-only]");
  }
  retryTask(taskId, flags.length ? "validation" : "repair");
} catch (error) {
  logger.error({ err: error }, "Retry command failed");
  process.exitCode = 1;
} finally {
  await drainStatus();
  db.$client.close();
}
