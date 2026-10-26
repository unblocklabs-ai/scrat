import { setTimeout } from "node:timers/promises";
import { runCommand } from "./cli.ts";
import { config } from "./config.ts";
import { logger } from "./logging.ts";
import { pollSources } from "./poll-sources.ts";
import { runNextTask } from "./runner.ts";
import { validateStaticConfig } from "./startup.ts";
import { waitForWork, workGeneration } from "./work-signal.ts";

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
    await pollSources();
  }
}
async function worker() {
  while (!shutdown.signal.aborted) {
    const seen = workGeneration();
    try { if (!await runNextTask(shutdown.signal)) await waitForWork(seen, config.harness.idlePollSeconds * 1000, shutdown.signal); }
    catch (error) {
      logger.error({ err: error }, "Worker failed");
      await wait(config.harness.workerErrorDelaySeconds * 1000);
    }
  }
}
await runCommand("Serve failed", async () => {
  await validateStaticConfig();
  logger.info({ event: "worker.started", concurrency: config.harness.maxConcurrency });
  await pollSources();
  await Promise.all([poll(), ...Array.from({ length: config.harness.maxConcurrency }, worker)]);
}, { event: "serve.failed" });
