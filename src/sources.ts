import { and, eq } from "drizzle-orm";
import { workflowOf, workflows } from "./workflow-registry.ts";
import { db } from "./db.ts";
import { type OperationScope, withOperation } from "./logging.ts";
import type { Action } from "./manifests.ts";
import { assertConfiguredRepository } from "./repository.ts";
import { sourceCursors, type Subject } from "./schema.ts";
import { enqueueTask, latestTask } from "./tasks.ts";
import type { TriggerInput } from "./triggers.ts";
import { toWorkflowSpec } from "./workflows.ts";

export function sourceCursor(repository: string, action: string, scope: string) {
  const key = and(eq(sourceCursors.repository, repository), eq(sourceCursors.action, action), eq(sourceCursors.branch, scope));
  return {
    value: db.select().from(sourceCursors).where(key).get()?.sha,
    save: (sha: string) => { const updatedAt = new Date().toISOString(); return db.insert(sourceCursors).values({ repository, action, branch: scope, sha, updatedAt })
      .onConflictDoUpdate({ target: [sourceCursors.repository, sourceCursors.action, sourceCursors.branch], set: { sha, updatedAt } }).run(); },
    clear: () => db.delete(sourceCursors).where(key).run(),
  };
}

export function pollSource(operationName: string, source: string, repository: string, perAction: (manifest: Action, operation: OperationScope, repository: string) => number | Promise<number>) {
  return withOperation(operationName, { repository }, async (operation) => {
    assertConfiguredRepository(repository);
    let queued = 0;
    for (const wf of workflows) {
      const resolved = workflowOf(wf.name);
      if (resolved.on.event?.source === source) {
        queued += await perAction(toWorkflowSpec(resolved, { publish: [] }), operation, repository);
      }
    }
    operation.complete({ queued });
    return queued;
  });
}

export function enqueueOnce(subject: Subject, action: string, reason: string, input: TriggerInput) {
  if (latestTask(subject.id, action)) return 0;
  enqueueTask({ subjectId: subject.id, action, reason, input });
  return 1;
}
