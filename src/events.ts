import { db } from "./db.ts";
import type { ErrorDetails } from "./errors.ts";
import { logger } from "./logging.ts";
import { events, type tasks } from "./schema.ts";

type TaskDetails = Pick<typeof tasks.$inferSelect, "action" | "priority" | "reason">;
type FetchDetails = { repository: string; durationMs: number };
export type EventReferences = { itemId?: string; taskId?: string; runId?: string; operationId?: string };

export type JournalEvent = (
  | { type: "task.enqueued"; data: TaskDetails }
  | { type: "task.coalesced"; data: {
      action: TaskDetails["action"];
      previous: Omit<TaskDetails, "action">;
      current: Omit<TaskDetails, "action">;
      inputChanged: boolean;
    } }
  | { type: "github.fetch_completed"; data: FetchDetails & { issues: number; pullRequests: number } }
  | { type: "github.fetch_failed"; data: FetchDetails & {
      error: ErrorDetails;
    } }
  | { type: "github.comment_created"; data: { repository: string; issueNumber: number; commentId: number; url: string } }
  | { type: "github.comment_updated"; data: { repository: string; commentId: number; url: string } }
  | { type: "github.labels_added"; data: { repository: string; issueNumber: number; labels: string[] } }
  | { type: "github.label_removed"; data: { repository: string; issueNumber: number; label: string } }
  | { type: "github.write_failed"; data: {
      repository: string;
      operation: "postComment" | "updateComment" | "addLabels" | "removeLabels";
      issueNumber?: number;
      commentId?: number;
      labels?: string[];
      error: ErrorDetails;
    } }
) & EventReferences;

export function recordEvent(event: JournalEvent, database: Pick<typeof db, "insert"> = db) {
  try {
    return database.insert(events).values(event).returning().get()!;
  } catch (err) {
    logger.error({
      event: "journal.failed", journalEventType: event.type, operationId: event.operationId,
      itemId: event.itemId, taskId: event.taskId, runId: event.runId, err,
    });
    throw err;
  }
}
