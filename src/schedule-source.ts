import { config, isActionEnabled } from "./config.ts";
import { type Cron, nextTick, parseCron, parseWindow } from "./cron.ts";
import { type OperationScope } from "./logging.ts";
import type { Action } from "./manifests.ts";
import { upsertSubject } from "./items.ts";
import { enqueueOnce, pollSource, sourceCursor } from "./sources.ts";

const cursorBranch = "schedule";

type StoredCursor = { next: string; cron?: string; window?: string };

const readCursor = (value: string): StoredCursor => value.startsWith("{") ? JSON.parse(value) as StoredCursor : { next: value };

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
  const expression = { cron: trigger.cron!, window: trigger.window! };
  const cron: Cron = parseCron(expression.cron);
  const save = (next: Date) => cursor.save(JSON.stringify({ next: next.toISOString(), ...expression }));
  const stored = cursor.value ? readCursor(cursor.value) : undefined;
  if (!stored || (stored.cron ?? expression.cron) !== expression.cron || (stored.window ?? expression.window) !== expression.window) {
    const due = nextTick(cron, now);
    save(due);
    if (stored) operation.log.info({ event: "schedule.reseeded", action, from: { cron: stored.cron, window: stored.window }, to: expression, next: due.toISOString() });
    else operation.log.info({ event: "schedule.seeded", action, next: due.toISOString() });
    return 0;
  }
  let tick = new Date(stored.next);
  if (tick > now) return 0;
  let next = nextTick(cron, tick);
  while (next <= now) { tick = next; next = nextTick(cron, tick); }
  operation.stage("enqueue");
  const end = tick.toISOString(), start = new Date(tick.getTime() - parseWindow(expression.window)).toISOString();
  const subject = upsertSubject({ repository, kind: "window", key: `${action}:${end}`, metadata: { start, end } });
  const queued = enqueueOnce(subject, action, `schedule tick ${end}`, { source: "schedule", kind: "tick", triggerKey: end, start, end });
  save(next);
  return queued;
}
