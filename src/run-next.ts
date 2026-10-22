import { db } from "./db.ts";
import { logger } from "./logging.ts";
import { runNextTask } from "./runner.ts";
import { prepareService } from "./startup.ts";
import { drainStatus } from "./slack-status.ts";

try {
  await prepareService();
  const run = await runNextTask();
  if (run?.error) process.exitCode = 1;
} catch (error) {
  logger.error({ err: error }, "Run command failed");
  process.exitCode = 1;
} finally {
  await drainStatus();
  db.$client.close();
}
