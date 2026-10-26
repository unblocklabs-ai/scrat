import { config, isActionEnabled } from "./config.ts";
import { type Cron, nextTick, parseCron, parseWindow } from "./cron.ts";
import { type OperationScope } from "./logging.ts";
import type { Action } from "./manifests.ts";
import { upsertSubject } from "./items.ts";
import { enqueueOnce, pollSource, sourceCursor } from "./sources.ts";

const cursorBranch = "schedule";

export function pollSchedules(repository = config.github.repository, now = new Date()) {
  return pollSource("schedule.poll", "schedule", repository, (manifest, operation) => pollAction(manifest, repository, now, operation));
}

function pollAction(manifest: Action, repository: string, now: Date, operation: OperationScope) {
  const { name: action, trigger } = manifest;
  const cursor = sourceCursor(repository, action, cursorBranch);
  if (!isActionEnabled(action)) {
    cursor.clear();
    return 0;
  }
  const cron: Cron = parseCron(trigger.cron!);
  if (!cursor.value) {
    const due = nextTick(cron, now);
    cursor.save(due.toISOString());
    operation.log.info({ event: "schedule.seeded", action, next: due.toISOString() });
    return 0;
  }
  let tick = new Date(cursor.value);
  if (tick > now) return 0;
  let next = nextTick(cron, tick);
  while (next <= now) { tick = next; next = nextTick(cron, tick); }
  operation.stage("enqueue");
  const end = tick.toISOString(), start = new Date(tick.getTime() - parseWindow(trigger.window!)).toISOString();
  const subject = upsertSubject({ repository, kind: "window", key: `${action}:${end}`, metadata: { start, end } });
  const queued = enqueueOnce(subject, action, `schedule tick ${end}`, { source: "schedule", kind: "tick", triggerKey: end, start, end });
  cursor.save(next.toISOString());
  return queued;
}
