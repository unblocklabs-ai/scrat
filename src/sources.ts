import { and, eq } from "drizzle-orm";
import { manifests } from "./actions.ts";
import { db } from "./db.ts";
import { type OperationScope, withOperation } from "./logging.ts";
import type { Manifest } from "./manifests.ts";
import { assertConfiguredRepository } from "./repository.ts";
import { sourceCursors, type Subject } from "./schema.ts";
import { enqueueTask, latestTask } from "./tasks.ts";
import type { TriggerInput } from "./triggers.ts";

export function sourceCursor(repository: string, action: string, scope: string) {
  const key = and(eq(sourceCursors.repository, repository), eq(sourceCursors.action, action), eq(sourceCursors.branch, scope));
  return {
    value: db.select().from(sourceCursors).where(key).get()?.sha,
    save: (sha: string) => db.insert(sourceCursors).values({ repository, action, branch: scope, sha, updatedAt: new Date().toISOString() })
      .onConflictDoUpdate({ target: [sourceCursors.repository, sourceCursors.action, sourceCursors.branch], set: { sha, updatedAt: new Date().toISOString() } }).run(),
    clear: () => db.delete(sourceCursors).where(key).run(),
  };
}

export function pollSource(operationName: string, source: string, perAction: (manifest: Manifest, operation: OperationScope) => number | Promise<number>, repository: string) {
  return withOperation(operationName, { repository }, async (operation) => {
    assertConfiguredRepository(repository);
    let queued = 0;
    for (const manifest of manifests()) {
      if (manifest.trigger.source === source) queued += await perAction(manifest, operation);
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
