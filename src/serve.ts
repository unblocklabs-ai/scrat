import { setTimeout } from "node:timers/promises";
import { pollCommits } from "./commit-source.ts";
import { config } from "./config.ts";
import { db } from "./db.ts";
import { syncGitHub } from "./github-sync.ts";
import { logger } from "./logging.ts";
import { runNextTask } from "./runner.ts";
import { pollSchedules } from "./schedule-source.ts";
import { prepareService } from "./startup.ts";
import { signalWork, waitForWork, workGeneration } from "./work-signal.ts";
import { drainStatus } from "./slack-status.ts";

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
    catch { }
    try { if (await pollCommits()) signalWork(); }
    catch { }
    try { if (await pollSchedules()) signalWork(); }
    catch { }
  }
}
async function worker() {
  while (!shutdown.signal.aborted) {
    const seen = workGeneration();
    try { if (!await runNextTask(shutdown.signal)) await waitForWork(seen, idleWorkerFallbackMs, shutdown.signal); }
    catch (error) {
      logger.error({ err: error }, "Worker failed");
      await wait(1000);
    }
  }
}
try {
  await prepareService();
  logger.info({ event: "worker.started", concurrency: config.harness.maxConcurrency });
  try { await syncGitHub(); }
  catch { }
  try { if (await pollCommits()) signalWork(); }
  catch { }
  try { if (await pollSchedules()) signalWork(); }
  catch { }
  await Promise.all([poll(), ...Array.from({ length: config.harness.maxConcurrency }, worker)]);
} catch (error) {
  logger.error({ err: error, event: "serve.failed" }, "Serve failed");
  process.exitCode = 1;
} finally {
  await drainStatus();
  db.$client.close();
}
