import { setTimeout } from "node:timers/promises";
import { config } from "./config.ts";
import { db } from "./db.ts";
import { syncGitHub } from "./github-sync.ts";
import { logger } from "./logging.ts";
import { runNextTask } from "./runner.ts";
import { validateStaticConfig } from "./startup.ts";

const shutdown = new AbortController();
const wait = (ms: number) => setTimeout(ms, undefined, { signal: shutdown.signal }).catch((error: unknown) => {
  if (!(error instanceof Error) || error.name !== "AbortError") throw error;
});
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => {
  logger.info({ event: "worker.draining", signal });
  shutdown.abort();
});
async function poll() {
  while (!shutdown.signal.aborted) {
    await wait(config.github.fetchIntervalSeconds * 1000);
    if (shutdown.signal.aborted) break;
    try { await syncGitHub(); }
    catch { /* sync owns its failure log; the next poll can recover. */ }
  }
}
async function worker() {
  while (!shutdown.signal.aborted) {
    try { if (!await runNextTask()) await wait(1000); }
    catch (error) {
      logger.error({ err: error }, "Worker failed");
      await wait(1000);
    }
  }
}
try {
  await validateStaticConfig();
  logger.info({ event: "worker.started", concurrency: config.harness.maxConcurrency });
  // Discover all priorities before the first claims, rather than starting with a partial queue.
  try { await syncGitHub(); }
  catch { /* Keep the worker available for persisted tasks and the next poll. */ }
  await Promise.all([poll(), ...Array.from({ length: config.harness.maxConcurrency }, worker)]);
} finally { db.$client.close(); }
