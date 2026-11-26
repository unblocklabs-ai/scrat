import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { db } from "./db.ts";
import { desc, eq, isNull } from "drizzle-orm";
import { config } from "./config.ts";
import { removeRunDatabase } from "./databases.ts";
import { logger } from "./logging.ts";
import { InterruptedError, workerStoppedMessage } from "./results.ts";
import { runs, tasks } from "./schema.ts";
import { finishRun, interruptRun } from "./tasks.ts";
import { runCommand } from "./cli.ts";

const consecutiveCrashes = (taskId: string) => {
  let count = 0;
  for (const run of db.select().from(runs).where(eq(runs.taskId, taskId)).orderBy(desc(runs.startedAt)).all()) {
    if (!run.finishedAt) continue;
    if (run.error?.message !== workerStoppedMessage) break;
    count++;
  }
  return count;
};

function hasLiveCliOwner(taskId: string) {
  const pidFile = resolve("data/cli-tasks", `${taskId}.pid`);
  if (!existsSync(pidFile)) return false;
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    rmSync(pidFile, { force: true });
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
    rmSync(pidFile, { force: true });
    return false;
  }
}

await runCommand("Run recovery failed", async () => {
  for (const run of db.select().from(runs).where(isNull(runs.finishedAt)).all()) {
    try {
      if (hasLiveCliOwner(run.taskId)) {
        logger.info({ event: "run.recovery_skipped_live_cli", runId: run.id, taskId: run.taskId });
        continue;
      }
      const crashes = consecutiveCrashes(run.taskId) + 1;
      if (crashes > config.harness.crashRequeues) finishRun(run.id, { status: "failed", error: new InterruptedError(workerStoppedMessage) });
      else interruptRun(run.id);
      if (config.workspace.database) await removeRunDatabase(run.id, { taskId: run.taskId });
      logger.info({ event: "run.recovered", runId: run.id, taskId: run.taskId, crashes, requeued: db.select().from(tasks).where(eq(tasks.id, run.taskId)).get()?.status === "queued" });
    } catch (error) {
      logger.error({ err: error, event: "run.recovery_failed", runId: run.id, taskId: run.taskId }, "Run recovery failed");
    }
  }
});
