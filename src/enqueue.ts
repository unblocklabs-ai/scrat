import { db } from "./db.ts";
import { logger } from "./logging.ts";
import { tasks } from "./schema.ts";
import { enqueueTask } from "./tasks.ts";

try {
  const [itemId, requestedAction, requestedPriority = "0"] = process.argv.slice(2);
  const action = tasks.action.enumValues.find((candidate) => candidate === requestedAction);
  if (!itemId || !action) throw new Error("Usage: npm run enqueue -- <item-id> <action> [priority]");
  const priority = Number(requestedPriority);
  if (!Number.isSafeInteger(priority)) throw new Error("Priority must be an integer");
  enqueueTask({ itemId, action, priority, reason: "Manually enqueued", input: {} });
} catch (error) {
  logger.error({ err: error }, "Task enqueue failed");
  process.exitCode = 1;
} finally {
  db.$client.close();
}
