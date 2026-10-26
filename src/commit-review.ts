import { eq } from "drizzle-orm";
import type { evaluateContext } from "./agent-input.ts";
import { manifestOf } from "./actions.ts";
import { db } from "./db.ts";
import { changedPaths, git } from "./git.ts";
import { GitHubRepository } from "./github.ts";
import { botName } from "./identity.ts";
import { bestEffort, logger } from "./logging.ts";
import type { Ctx } from "./run-context.ts";
import type { Evaluated } from "./effects.ts";
import { slackThreads, type Run, type Subject } from "./schema.ts";
import { addReaction, escapeSlack, postMessage } from "./slack.ts";
import { reviewBlocks } from "./slack-blocks.ts";
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

const areaName = (path: string) => {
  const [, kind = "", name = ""] = /^(templates|sections|snippets|assets|locales)\/(.+?)(?:\.(?:json|liquid))?$/.exec(path) ?? [];
  if (path === "config/settings_data.json") return "theme settings";
  if (kind === "templates") return name === "index" ? "home page template" : `${name} page template`;
  if (kind === "sections") return `${name} section`;
  if (kind === "snippets") return `${name} snippet`;
  if (kind === "locales") return `${name} translations`;
  if (kind === "assets") return path.slice("assets/".length);
  return `\`${path}\``;
};

function areaList(paths: string[]) {
  const names = [...new Set(paths.map(areaName))], shown = names.slice(0, 3), more = names.length - shown.length;
  const parts = more ? [...shown, `${more} more file${more === 1 ? "" : "s"}`] : shown;
  return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts.join("");
}

async function describeChange(subject: Subject, commitCount: number) {
  const metadata = commitMetadata(subject), author = escapeSlack(metadata.author), title = escapeSlack(metadata.title);
  const others = commitCount > 1 ? ` and ${commitCount - 1} more change${commitCount === 2 ? "" : "s"}` : "";
  if (metadata.pr !== undefined) {
    const found = await bestEffort(logger, "slack.start_pr_lookup_failed", { repository: subject.repository, pr: metadata.pr }, () => new GitHubRepository(subject.repository).fetchPullRequest(metadata.pr!));
    const merger = found ? escapeSlack(found.merged_by?.login ?? metadata.author) : author;
    return `<${found?.html_url ?? metadata.url}|*${found ? escapeSlack(found.title) : title}*> (PR #${metadata.pr}, merged by ${merger})${others}.`;
  }
  if (metadata.shopify) return `<${metadata.url}|the ${escapeSlack(areaList(metadata.paths ?? []))} ${(metadata.paths?.length ?? 0) > 1 ? "were" : "was"} edited in the Shopify theme editor>${others}.`;
  return `${author} changed the theme: <${metadata.url}|"${title}">${others}.`;
}

async function threadRoot(subject: Subject, action: string, { sha, branch, commitCount }: CommitInput) {
  const existing = savedRoot(subject);
  if (existing) return existing;
  const { channel = "", startMessage = "" } = manifestOf(action);
  const metadata = commitMetadata(subject);
  const values: Record<string, string> = {
    sha, short_sha: sha.slice(0, 7), author: escapeSlack(metadata.author), title: escapeSlack(metadata.title),
    url: metadata.url, branch, count: String(commitCount), bot: botName, change: startMessage.includes("{{change}}") ? await describeChange(subject, commitCount) : "",
  };
  const text = startMessage.replaceAll(/\{\{(\w+)\}\}/g, (match, name: string) => Object.hasOwn(values, name) ? values[name]! : match);
  const ts = await postMessage({ channel, text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }] });
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

export async function postCommitReply(subject: Subject, action: string, run: Evaluated, text?: string, blocks?: unknown[]) {
  const input = commitInput(run.input);
  const thread = await threadRoot(subject, action, input);
  return postMessage({ channel: thread.channel, text: text ?? escapeSlack(run.result.text), blocks: text === undefined ? reviewBlocks(run.result.text) : blocks, threadTs: thread.ts });
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
