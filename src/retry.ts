import { db } from "./db.ts";
import { logger } from "./logging.ts";
import { retryTask } from "./tasks.ts";

try {
  const taskId = process.argv[2];
  if (!taskId) throw new Error("Usage: npm run retry -- <task-id>");
  retryTask(taskId);
} catch (error) {
  logger.error({ err: error }, "Retry command failed");
  process.exitCode = 1;
} finally {
  db.$client.close();
}
