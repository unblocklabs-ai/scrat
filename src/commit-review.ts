import { eq } from "drizzle-orm";
import type { evaluateContext } from "./agent-input.ts";
import { commitSettings } from "./config.ts";
import { db } from "./db.ts";
import { changedPaths, git } from "./git.ts";
import { botName } from "./identity.ts";
import type { startOperation } from "./logging.ts";
import { getRun } from "./run-history.ts";
import { slackThreads, type Run, type Subject } from "./schema.ts";
import { addReaction, escapeSlack, postMessage } from "./slack.ts";
import { parseTriggerInput } from "./triggers.ts";

type CommitInput = { sha: string; previousSha: string; branch: string; commitCount: number };

export function commitInput(raw: Record<string, unknown>): CommitInput {
  const trigger = parseTriggerInput(raw);
  if (trigger.kind !== "commit") throw new Error("Commit task input is incomplete");
  const { sha, previousSha, branch, commitCount } = trigger;
  return { sha, previousSha, branch, commitCount };
}

function commitMetadata({ metadata }: Subject) {
  if (!metadata || !("title" in metadata)) throw new Error("Commit subject has no metadata");
  return metadata;
}

async function threadRoot(subject: Subject, action: string, { sha, branch, commitCount }: CommitInput) {
  const existing = db.select().from(slackThreads).where(eq(slackThreads.subjectId, subject.id)).get();
  if (existing) return existing;
  const { channel, startMessage } = commitSettings(action);
  const metadata = commitMetadata(subject);
  const values: Record<string, string> = {
    sha, short_sha: sha.slice(0, 7), author: escapeSlack(metadata.author), title: escapeSlack(metadata.title),
    url: metadata.url, branch, count: String(commitCount), bot: botName,
  };
  const text = startMessage.replaceAll(/\{\{(\w+)\}\}/g, (match, name: string) => Object.hasOwn(values, name) ? values[name]! : match);
  const ts = await postMessage({ channel, text });
  return db.insert(slackThreads).values({ subjectId: subject.id, channel, ts }).returning().get();
}

export async function startCommitThread(subject: Subject, action: string, input: CommitInput, log: ReturnType<typeof startOperation>["log"]) {
  await threadRoot(subject, action, input).catch((error: unknown) => { log.warn({ event: "slack.post_failed", err: error }); });
}

export async function describeCommit(repositoryPath: string, subject: Subject, rawInput: Record<string, unknown>) {
  const { sha, previousSha, branch } = commitInput(rawInput);
  const [commitSubject = "", body = ""] = (await git(repositoryPath, ["log", "-1", "--format=%s%x00%b", sha])).split("\0");
  const diffPaths = await changedPaths(repositoryPath, `${previousSha}..${sha}`);
  const evaluated: ReturnType<typeof evaluateContext> = {
    revision: sha, baseBranch: branch, headSha: undefined,
    item: { number: 0, title: commitSubject, body, url: commitMetadata(subject).url }, comments: [], commentRevisions: [],
  };
  return { evaluated, diffPaths, diffBaseSha: previousSha };
}

export async function postCommitReply(subject: Subject, action: string, run: Run) {
  const input = commitInput(run.input);
  const saved = getRun(run.id)!;
  if (!saved.result) throw new Error("Run has no saved result to publish");
  const thread = await threadRoot(subject, action, input);
  return postMessage({ channel: thread.channel, text: escapeSlack(saved.result.text), threadTs: thread.ts });
}

const verdictReactions = { clean: "white_check_mark", concerns: "large_orange_square", breaking: "large_red_square" } as const;

export function verdictReaction(run: Run) {
  const result = getRun(run.id)?.result;
  return result?.outcome === "complete" && result.verdict ? verdictReactions[result.verdict] : undefined;
}

export async function reactToCommitRoot(subject: Subject, name: string) {
  const thread = db.select().from(slackThreads).where(eq(slackThreads.subjectId, subject.id)).get();
  if (!thread) throw new Error("Commit review has no Slack thread root to react to");
  await addReaction({ channel: thread.channel, timestamp: thread.ts, name });
}
