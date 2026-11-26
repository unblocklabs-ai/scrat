import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { runCommand } from "./cli.ts";
import { activeWorkflowsCheckout, config } from "./config.ts";
import { logger } from "./logging.ts";
import { pollSources } from "./poll-sources.ts";
import { readOptionalText } from "./process-status.ts";
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
  const pidFile = resolve("data/serve.pid");
  const checkoutFile = resolve("data/serve.workflows-checkout");
  mkdirSync(resolve("data"), { recursive: true });
  if (activeWorkflowsCheckout) writeFileSync(checkoutFile, `${activeWorkflowsCheckout}\n`);
  else rmSync(checkoutFile, { force: true });
  writeFileSync(pidFile, `${process.pid}\n`);
  try {
    await validateStaticConfig();
    logger.info({ event: "worker.started", concurrency: config.harness.maxConcurrency });
    await pollSources();
    await Promise.all([poll(), ...Array.from({ length: config.harness.maxConcurrency }, worker)]);
  } finally {
    if (Number(readOptionalText(pidFile)) === process.pid) {
      rmSync(pidFile, { force: true });
      rmSync(checkoutFile, { force: true });
    }
  }
}, { event: "serve.failed" });
