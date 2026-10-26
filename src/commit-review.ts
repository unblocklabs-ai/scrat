import { eq } from "drizzle-orm";
import type { evaluateContext } from "./agent-input.ts";
import { manifestOf } from "./actions.ts";
import { db } from "./db.ts";
import { changedPaths, git } from "./git.ts";
import { botName } from "./identity.ts";
import { bestEffort } from "./logging.ts";
import type { Ctx } from "./run-context.ts";
import type { Evaluated } from "./effects.ts";
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

const savedRoot = (subject: Subject) => db.select().from(slackThreads).where(eq(slackThreads.subjectId, subject.id)).get();

async function threadRoot(subject: Subject, action: string, { sha, branch, commitCount }: CommitInput) {
  const existing = savedRoot(subject);
  if (existing) return existing;
  const { channel = "", startMessage = "" } = manifestOf(action);
  const metadata = commitMetadata(subject);
  const values: Record<string, string> = {
    sha, short_sha: sha.slice(0, 7), author: escapeSlack(metadata.author), title: escapeSlack(metadata.title),
    url: metadata.url, branch, count: String(commitCount), bot: botName,
  };
  const text = startMessage.replaceAll(/\{\{(\w+)\}\}/g, (match, name: string) => Object.hasOwn(values, name) ? values[name]! : match);
  const ts = await postMessage({ channel, text });
  return db.insert(slackThreads).values({ subjectId: subject.id, channel, ts }).returning().get();
}

export async function describeCommit({ subject, run, task, manifest, operation, repositoryPath }: Ctx) {
  const input = commitInput(run.input), { sha, previousSha, branch } = input;
  if (manifest.start?.includes("slack_post")) await bestEffort(operation.log, "slack.post_failed", {}, () => threadRoot(subject, task.action, input));
  const [commitSubject = "", body = ""] = (await git(repositoryPath, ["log", "-1", "--format=%s%x00%b", sha])).split("\0");
  const diffPaths = await changedPaths(repositoryPath, `${previousSha}..${sha}`);
  const evaluated: ReturnType<typeof evaluateContext> = {
    revision: sha, baseBranch: branch, headSha: undefined,
    item: { number: 0, title: commitSubject, body, url: commitMetadata(subject).url }, comments: [], commentRevisions: [],
  };
  return { mainSha: sha, headSha: sha, evaluated, diffPaths, diffBaseSha: previousSha };
}

export async function postCommitReply(subject: Subject, action: string, run: Evaluated, text?: string) {
  const input = commitInput(run.input);
  const thread = await threadRoot(subject, action, input);
  return postMessage({ channel: thread.channel, text: text ?? escapeSlack(run.result.text), threadTs: thread.ts });
}

const verdictReactions = { clean: "white_check_mark", concerns: "large_orange_square", breaking: "large_red_square" } as const;

export function verdictReaction({ result }: Run) {
  return result?.verdict ? verdictReactions[result.verdict] : undefined;
}

export async function reactToCommitRoot(subject: Subject, name: string) {
  const thread = savedRoot(subject);
  if (!thread) throw new Error("Commit review has no Slack thread root to react to");
  await addReaction({ channel: thread.channel, timestamp: thread.ts, name });
}
