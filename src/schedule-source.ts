import { and, eq } from "drizzle-orm";
import { manifests } from "./actions.ts";
import { config, isActionEnabled } from "./config.ts";
import { type Cron, nextTick, parseCron, parseWindow } from "./cron.ts";
import { db } from "./db.ts";
import { type OperationScope, withOperation } from "./logging.ts";
import type { Manifest } from "./manifests.ts";
import { assertConfiguredRepository } from "./repository.ts";
import { sourceCursors, subjects } from "./schema.ts";
import { enqueueTask, latestTask } from "./tasks.ts";

const cursorBranch = "schedule";

export async function pollSchedules(repository = config.github.repository, now = new Date()) {
  return withOperation("schedule.poll", { repository }, async (operation) => {
    assertConfiguredRepository(repository);
    let queued = 0;
    for (const manifest of manifests()) {
      if (manifest.trigger.source === "schedule") queued += pollAction(manifest, repository, now, operation);
    }
    operation.complete({ queued });
    return queued;
  });
}

function pollAction(manifest: Manifest, repository: string, now: Date, operation: OperationScope) {
  const { name: action, trigger } = manifest;
  const key = and(eq(sourceCursors.repository, repository), eq(sourceCursors.action, action), eq(sourceCursors.branch, cursorBranch));
  if (!isActionEnabled(action)) {
    db.delete(sourceCursors).where(key).run();
    return 0;
  }
  const cron: Cron = parseCron(trigger.cron!);
  const saveCursor = (due: Date) => db.insert(sourceCursors).values({ repository, action, branch: cursorBranch, sha: due.toISOString(), updatedAt: new Date().toISOString() })
    .onConflictDoUpdate({ target: [sourceCursors.repository, sourceCursors.action, sourceCursors.branch], set: { sha: due.toISOString(), updatedAt: new Date().toISOString() } }).run();
  const cursor = db.select().from(sourceCursors).where(key).get();
  if (!cursor) {
    const due = nextTick(cron, now);
    saveCursor(due);
    operation.log.info({ event: "schedule.seeded", action, next: due.toISOString() });
    return 0;
  }
  let tick = new Date(cursor.sha);
  if (tick > now) return 0;
  let next = nextTick(cron, tick);
  while (next <= now) { tick = next; next = nextTick(cron, tick); }
  operation.stage("enqueue");
  const end = tick.toISOString(), start = new Date(tick.getTime() - parseWindow(trigger.window!)).toISOString();
  const subject = db.insert(subjects).values({ repository, kind: "window", key: `${action}:${end}`, metadata: { start, end } })
    .onConflictDoUpdate({ target: [subjects.repository, subjects.kind, subjects.key], set: { state: "open" } }).returning().get()!;
  const existing = latestTask(subject.id, action);
  if (!existing) {
    enqueueTask({ subjectId: subject.id, action, reason: `schedule tick ${end}`, input: { source: "schedule", kind: "tick", triggerKey: end, start, end } });
  }
  saveCursor(next);
  return existing ? 0 : 1;
}
