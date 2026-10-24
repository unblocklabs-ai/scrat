import { db } from "./db.ts";
import { logger } from "./logging.ts";
import { drainStatus } from "./slack-status.ts";

export async function runCommand(failureMessage: string, body: () => Promise<void> | void, fields: { event?: string } = {}) {
  try {
    await body();
  } catch (error) {
    logger.error({ err: error, ...fields }, failureMessage);
    process.exitCode = 1;
  } finally {
    await drainStatus();
    db.$client.close();
  }
}

export async function attempt(fn: () => Promise<unknown> | unknown) {
  try { await fn(); }
  catch { }
}
