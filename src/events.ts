import { db } from "./db.ts";
import type { ErrorDetails } from "./errors.ts";
import { events, type tasks } from "./schema.ts";

type TaskDetails = Pick<typeof tasks.$inferSelect, "action" | "priority" | "reason">;
export type EventReferences = { subjectId?: string; taskId?: string; runId?: string };

export type JournalEvent = (
  | { type: "database.created"; data: { container: string; image: string } }
  | { type: "database.removed"; data: { container: string } }
  | { type: "run.started"; data: { action: TaskDetails["action"]; skill: string; provider: string; model: string; thinkingLevel: string } }
  | { type: "run.completed"; data: { stage: string } }
  | { type: "run.failed"; data: { stage: string; error: ErrorDetails } }
  | { type: "task.cancelled"; data: { action: TaskDetails["action"]; reason: string } }
  | { type: "task.rejected"; data: { action: string; reason: string } }
  | { type: "task.retried"; data: { action: TaskDetails["action"]; mode: "repair" | "validation" } }
  | { type: "workspace.committed" | "workspace.pushed"; data: { workspaceId: string; commitSha: string } }
  | { type: "task.enqueued"; data: TaskDetails }
  | { type: "task.coalesced"; data: {
      action: TaskDetails["action"];
      previous: Omit<TaskDetails, "action">;
      current: Omit<TaskDetails, "action">;
      inputChanged: boolean;
    } }
  | { type: "github.comment_created"; data: { repository: string; issueNumber: number; commentId: number; url: string } }
  | { type: "github.comment_updated"; data: { repository: string; commentId: number; url: string } }
  | { type: "github.labels_added"; data: { repository: string; issueNumber: number; labels: string[] } }
  | { type: "github.label_removed"; data: { repository: string; issueNumber: number; label: string } }
  | { type: "github.pull_request_created"; data: {
      repository: string;
      pullRequestNumber: number;
      url: string;
      head: string;
      base: string;
    } }
  | { type: "workspace.created" | "workspace.removed"; data: {
      workspaceId: string;
      repositoryPath: string;
      path: string;
      branch: string;
    } }
) & EventReferences & { operationId?: string };

export function recordEvent(event: JournalEvent, database: Pick<typeof db, "insert"> = db) {
  return database.insert(events).values(event).returning().get()!;
}
