import { db } from "./db.ts";
import { logger } from "./logging.ts";
import { enqueueManualTasks } from "./tasks.ts";

try {
  const args = process.argv.slice(2);
  const flag = args.indexOf("--priority");
  const priority = flag < 0 ? undefined : Number(args.splice(flag, 2)[1]);
  const [action, ...targets] = args;
  if (!action || !targets.length) throw new Error("Usage: npm run enqueue -- <action> <number|item-id>... [--priority N]");
  if (priority !== undefined && !Number.isSafeInteger(priority)) throw new Error("Priority must be an integer");
  for (const { target, number, itemId, taskId, error } of enqueueManualTasks(action, targets, priority)) {
    console.log([target, number ?? "-", itemId ?? "-", error ? `error: ${error}` : taskId].join("\t"));
    if (error) process.exitCode = 1;
  }
} catch (error) {
  logger.error({ err: error }, "Task enqueue failed");
  process.exitCode = 1;
} finally {
  db.$client.close();
}
