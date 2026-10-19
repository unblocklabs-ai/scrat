import { db } from "./db.ts";
import { events, type tasks } from "./schema.ts";

type TaskDetails = Pick<typeof tasks.$inferSelect, "action" | "priority" | "reason">;
export type EventReferences = { itemId?: string; taskId?: string; runId?: string };

export type JournalEvent = (
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
