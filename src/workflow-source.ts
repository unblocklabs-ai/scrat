import { and, asc, eq, gt, like, lte, max, sql } from "drizzle-orm";
import { config } from "./config.ts";
import { db } from "./db.ts";
import { upsertSubject } from "./items.ts";
import type { OperationScope } from "./logging.ts";
import type { Action } from "./manifests.ts";
import { workflowOf, workflows } from "./workflow-registry.ts";
import { events, items, runs, sourceCursors, subjects, tasks } from "./schema.ts";
import { enqueueOnce, pollSource, sourceCursor } from "./sources.ts";

export function pollWorkflowCompletions(repository = config.github.repository) {
  pruneOrphanedCursors(repository);
  return pollSource("workflow.poll", "workflow", repository, pollFollower);
}

function pruneOrphanedCursors(repository: string) {
  const subscribed = new Set(workflows.flatMap(({ name }) => {
    const event = workflowOf(name).on.event;
    return event?.source === "workflow" && event.workflow ? [`${name}\0workflow:${event.workflow}`] : [];
  }));
  const scope = and(eq(sourceCursors.repository, repository), like(sourceCursors.branch, "workflow:%"));
  for (const { action, branch } of db.select({ action: sourceCursors.action, branch: sourceCursors.branch }).from(sourceCursors).where(scope).all()) {
    if (!subscribed.has(`${action}\0${branch}`)) db.delete(sourceCursors).where(and(scope, eq(sourceCursors.action, action), eq(sourceCursors.branch, branch))).run();
  }
}

function pollFollower({ name: follower, trigger, enabled }: Action, operation: OperationScope, repository: string) {
  const parent = trigger.workflow!;
  const cursor = sourceCursor(repository, follower, `workflow:${parent}`);
  if (enabled === false) {
    cursor.clear();
    return 0;
  }
  const high = db.select({ id: max(events.id) }).from(events).get()?.id ?? 0;
  if (cursor.value === undefined) {
    cursor.save(String(high));
    operation.log.info({ event: "workflow_source.seeded", action: follower, parent, eventId: high });
    return 0;
  }
  const low = Number(cursor.value);
  if (high <= low) return 0;
  const completed = db.select({ run: runs, task: tasks, subject: subjects, item: items }).from(events)
    .innerJoin(runs, eq(events.runId, runs.id)).innerJoin(tasks, eq(runs.taskId, tasks.id))
    .innerJoin(subjects, eq(tasks.subjectId, subjects.id)).leftJoin(items, eq(items.id, subjects.id))
    .where(and(eq(events.type, "run.completed"), gt(events.id, low), lte(events.id, high), eq(tasks.action, parent), sql`lower(${subjects.repository}) = lower(${repository})`))
    .orderBy(asc(events.id)).all();
  let queued = 0;
  for (const { run, task, subject, item } of completed) {
    if (run.input.dryRun === true || "replayOf" in run.input) continue;
    const followerSubject = upsertSubject({ repository, kind: "workflow", key: `${follower}:${run.id}` });
    queued += enqueueOnce(followerSubject, follower, `${parent} run ${run.id} completed`, {
      source: "workflow", kind: "workflow_completed", triggerKey: run.id, workflow: parent, runId: run.id, taskId: task.id,
      subject: { kind: subject.kind, key: subject.key },
      ...item ? { item: { kind: item.kind, number: item.payload.number } } : {},
      outcome: run.result?.outcome ?? "complete", publication: run.publication.status,
    });
  }
  cursor.save(String(high));
  return queued;
}
