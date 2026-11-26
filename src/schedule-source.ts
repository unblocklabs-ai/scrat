import { workflowOf, workflows } from "./actions.ts";
import { config, isActionEnabled, isWorkflowEnabled } from "./config.ts";
import { type Cron, nextTick, parseCron, parseWindow } from "./cron.ts";
import { type OperationScope, withOperationSync } from "./logging.ts";
import { upsertSubject } from "./items.ts";
import { assertConfiguredRepository } from "./repository.ts";
import { enqueueOnce, pollSource, sourceCursor } from "./sources.ts";

const cursorBranch = "schedule";

type StoredCursor = { next: string; cron?: string; window?: string };

const readCursor = (value: string): StoredCursor => value.startsWith("{") ? JSON.parse(value) as StoredCursor : { next: value };

export async function pollSchedules(repository = config.github.repository, now = new Date()) {
  const actionQueued = await pollSource("schedule.poll", "schedule", repository, (manifest, operation) =>
    pollScheduled(manifest.name, { cron: manifest.trigger.cron!, window: manifest.trigger.window! }, isActionEnabled(manifest.name), repository, now, operation));
  const scheduledWorkflows = workflows.map((wf) => workflowOf(wf.name)).filter((wf) => wf.on.cron);
  if (!scheduledWorkflows.length) return actionQueued;
  const workflowQueued = withOperationSync("workflow_schedule.poll", { repository }, (operation) => {
    assertConfiguredRepository(repository);
    let queued = 0;
    for (const wf of scheduledWorkflows) {
      queued += pollScheduled(wf.name, { cron: wf.on.cron!, window: wf.on.window ?? "24h" }, isWorkflowEnabled(wf.name), repository, now, operation);
    }
    operation.complete({ queued });
    return queued;
  });
  return actionQueued + workflowQueued;
}

function pollScheduled(action: string, expression: { cron: string; window: string }, enabled: boolean, repository: string, now: Date, operation: OperationScope) {
  const cursor = sourceCursor(repository, action, cursorBranch);
  if (!enabled) {
    cursor.clear();
    return 0;
  }
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
