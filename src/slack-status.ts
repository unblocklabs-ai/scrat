import { eq } from "drizzle-orm";
import { config } from "./config.ts";
import { db } from "./db.ts";
import type { JournalEvent } from "./events.ts";
import { logger } from "./logging.ts";
import { items, slackThreads, subjects, type Subject } from "./schema.ts";
import { escapeSlack, postMessage } from "./slack.ts";

const maxErrorLength = 300;

const link = (url: string, label: string) => `<${url}|${escapeSlack(label)}>`;

function messageFor(event: JournalEvent, subject: Pick<Subject, "repository">): string | undefined {
  switch (event.type) {
    case "run.started": return `Started ${escapeSlack(event.data.action)} with ${escapeSlack(event.data.skill)}`;
    case "run.completed": return `Completed at stage ${escapeSlack(event.data.stage)}`;
    case "run.failed": return `Failed at stage ${escapeSlack(event.data.stage)}: ${escapeSlack(event.data.error.message.slice(0, maxErrorLength))}`;
    case "run.requeued": return `Requeued at stage ${escapeSlack(event.data.stage)} for a ${event.data.retryMode} round${event.data.nextAttemptAt ? `; retry ${event.data.attempt} at ${escapeSlack(event.data.nextAttemptAt)}` : ""}`;
    case "task.retried": return `Retrying ${escapeSlack(event.data.action)} for a ${event.data.mode} round`;
    case "github.comment_created": return `Posted ${link(event.data.url, "a comment")}`;
    case "github.comment_updated": return `Updated ${link(event.data.url, "a comment")}`;
    case "github.pull_request_created": return `Opened ${link(event.data.url, `pull request #${event.data.pullRequestNumber}`)}`;
    case "github.issue_created": return `Created ${link(event.data.url, `issue #${event.data.issueNumber}`)}`;
    case "github.labels_added": return `Added labels: ${escapeSlack(event.data.labels.join(", "))}`;
    case "github.label_removed": return `Removed label: ${escapeSlack(event.data.label)}`;
    case "workspace.pushed": return `Pushed ${link(`https://github.com/${subject.repository}/commit/${event.data.commitSha}`, event.data.commitSha.slice(0, 7))}`;
    default: return undefined;
  }
}

let chain: Promise<void> = Promise.resolve();
let lastPostAt = 0;

async function send(message: Parameters<typeof postMessage>[0]) {
  const wait = lastPostAt + config.slack.minimumGapMs - Date.now();
  if (wait > 0) await new Promise((done) => setTimeout(done, wait));
  try { return await postMessage(message); } finally { lastPostAt = Date.now(); }
}

async function threadFor(subjectId: string, kind: string, payload: { number: number; title: string; html_url: string }) {
  const channel = config.slack.channel;
  const existing = db.select().from(slackThreads).where(eq(slackThreads.subjectId, subjectId)).get();
  if (existing?.channel === channel) return existing;
  const text = `*${kind === "pr" ? "Pull request" : "Issue"} #${payload.number}*: ${link(payload.html_url, payload.title)}`;
  const ts = await send({ channel, text });
  return db.insert(slackThreads).values({ subjectId, channel, ts })
    .onConflictDoUpdate({ target: slackThreads.subjectId, set: { channel, ts } }).returning().get();
}

async function post(event: JournalEvent) {
  try {
    const row = db.select({ subject: subjects, item: items }).from(subjects).innerJoin(items, eq(items.id, subjects.id))
      .where(eq(subjects.id, event.subjectId!)).get();
    const text = row && messageFor(event, row.subject);
    if (!row || !text) return;
    const thread = await threadFor(row.subject.id, row.item.kind, row.item.payload);
    await send({ channel: thread.channel, text, threadTs: thread.ts });
  } catch (error) {
    logger.warn({ event: "slack.post_failed", subjectId: event.subjectId, err: error });
  }
}

export function queueStatus(event: JournalEvent) {
  chain = chain.then(() => post(event));
}

export const drainStatus = () => chain;
