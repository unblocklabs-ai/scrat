import { eq } from "drizzle-orm";
import type { evaluateContext } from "./agent-input.ts";
import { config } from "./config.ts";
import { db } from "./db.ts";
import { git } from "./git.ts";
import { botName } from "./identity.ts";
import type { startOperation } from "./logging.ts";
import { items, runs, slackThreads } from "./schema.ts";
import { escapeSlack, postMessage } from "./slack.ts";

type CommitInput = { sha: string; previousSha: string; branch: string; commitCount: number };

function commitInput({ sha, previousSha, branch, commitCount }: Record<string, unknown>): CommitInput {
  if (typeof sha !== "string" || typeof previousSha !== "string" || typeof branch !== "string" || typeof commitCount !== "number") {
    throw new Error("Commit task input is incomplete");
  }
  return { sha, previousSha, branch, commitCount };
}

async function threadRoot(item: typeof items.$inferSelect, { sha, branch, commitCount }: CommitInput) {
  const existing = db.select().from(slackThreads).where(eq(slackThreads.itemId, item.id)).get();
  if (existing) return existing;
  const { channel, startMessage } = config.actions.review_base_change;
  const values: Record<string, string> = {
    sha, short_sha: sha.slice(0, 7), author: escapeSlack(item.payload.user?.login ?? ""), title: escapeSlack(item.payload.title),
    url: item.payload.html_url, branch, count: String(commitCount), bot: botName,
  };
  const text = startMessage.replaceAll(/\{\{(\w+)\}\}/g, (match, name: string) => Object.hasOwn(values, name) ? values[name]! : match);
  const ts = await postMessage({ channel, text });
  return db.insert(slackThreads).values({ itemId: item.id, channel, ts }).returning().get();
}

export async function startCommitThread(item: typeof items.$inferSelect, rawInput: Record<string, unknown>, log: ReturnType<typeof startOperation>["log"]) {
  const input = commitInput(rawInput);
  await threadRoot(item, input).catch((error: unknown) => { log.warn({ event: "slack.post_failed", err: error }); });
  return input;
}

export async function describeCommit(repositoryPath: string, item: typeof items.$inferSelect, rawInput: Record<string, unknown>) {
  const { sha, previousSha, branch } = commitInput(rawInput);
  const [subject = "", body = ""] = (await git(repositoryPath, ["log", "-1", "--format=%s%x00%b", sha])).split("\0");
  const diffPaths = (await git(repositoryPath, ["diff", "--name-only", "--no-renames", "-z", `${previousSha}..${sha}`])).split("\0").filter(Boolean);
  const evaluated: ReturnType<typeof evaluateContext> = {
    revision: sha, baseBranch: branch, headSha: undefined,
    item: { number: 0, title: subject, body, url: item.payload.html_url }, comments: [], commentRevisions: [],
  };
  return { evaluated, diffPaths, diffBaseSha: previousSha };
}

export async function publishCommit(item: typeof items.$inferSelect, run: typeof runs.$inferSelect) {
  const input = commitInput(run.input);
  const saved = db.select().from(runs).where(eq(runs.id, run.id)).get()!;
  if (!saved.result) throw new Error("Run has no saved result to publish");
  const { text } = saved.result;
  const slackReplyTs = saved.publication.slackReplyTs ?? await threadRoot(item, input).then((thread) => postMessage({ channel: thread.channel, text: escapeSlack(text), threadTs: thread.ts }));
  db.update(runs).set({ publication: { ...saved.publication, slackReplyTs, status: "published" } }).where(eq(runs.id, run.id)).run();
}
