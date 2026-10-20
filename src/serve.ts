import { setTimeout } from "node:timers/promises";
import { config } from "./config.ts";
import { db } from "./db.ts";
import { syncGitHub } from "./github-sync.ts";
import { logger } from "./logging.ts";
import { runNextTask } from "./runner.ts";
import { prepareService } from "./startup.ts";
import { signalWork, waitForWork, workGeneration } from "./work-signal.ts";

// Other processes (enqueue, retry) cannot signal this one, so idle workers also re-check periodically.
const idleWorkerFallbackMs = 30_000;
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
    try { await syncGitHub(); signalWork(); }
    catch { /* sync owns its failure log; the next poll can recover. */ }
  }
}
async function worker() {
  while (!shutdown.signal.aborted) {
    const seen = workGeneration();
    try { if (!await runNextTask()) await waitForWork(seen, idleWorkerFallbackMs, shutdown.signal); }
    catch (error) {
      logger.error({ err: error }, "Worker failed");
      await wait(1000);
    }
  }
}
try {
  await prepareService();
  logger.info({ event: "worker.started", concurrency: config.harness.maxConcurrency });
  // Discover all priorities before the first claims, rather than starting with a partial queue.
  try { await syncGitHub(); }
  catch { /* Keep the worker available for persisted tasks and the next poll. */ }
  await Promise.all([poll(), ...Array.from({ length: config.harness.maxConcurrency }, worker)]);
} catch (error) {
  logger.error({ err: error, event: "serve.failed" }, "Serve failed");
  process.exitCode = 1;
} finally { db.$client.close(); }
