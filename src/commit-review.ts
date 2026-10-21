import { eq } from "drizzle-orm";
import { buildAgentInput } from "./agent-input.ts";
import { config, getRepositoryPath } from "./config.ts";
import { db } from "./db.ts";
import type { EventReferences } from "./events.ts";
import { git } from "./git.ts";
import { botName } from "./identity.ts";
import type { startOperation } from "./logging.ts";
import { executePi } from "./pi.ts";
import { reviewPullRequest } from "./pr-review.ts";
import { assertComplete } from "./results.ts";
import { items, runs, slackThreads, tasks } from "./schema.ts";
import { escapeSlack, postMessage } from "./slack.ts";
import { finishRun } from "./tasks.ts";
import { createWorkspace, removeWorkspace } from "./workspaces.ts";

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

export async function runCommitTask(
  { task, run, item }: { task: typeof tasks.$inferSelect; run: typeof runs.$inferSelect; item: typeof items.$inferSelect },
  references: EventReferences, operation: ReturnType<typeof startOperation>,
) {
  let workspace: Awaited<ReturnType<typeof createWorkspace>> | undefined;
  try {
    const input = commitInput(run.input);
    const { sha, previousSha } = input;
    if (run.stage !== "publishing") {
      const repositoryPath = getRepositoryPath();
      await threadRoot(item, input).catch((error: unknown) => { operation.log.warn({ event: "slack.post_failed", err: error }); });
      workspace = await createWorkspace({ repositoryPath, baseRef: sha }, references);
      const [subject = "", body = ""] = (await git(repositoryPath, ["log", "-1", "--format=%s%x00%b", sha])).split("\0");
      const diffPaths = (await git(repositoryPath, ["diff", "--name-only", "--no-renames", "-z", `${previousSha}..${sha}`])).split("\0").filter(Boolean);
      const evaluated = {
        revision: sha, baseBranch: input.branch, headSha: undefined,
        item: { number: 0, title: subject, body, url: item.payload.html_url }, comments: [], commentRevisions: [],
      };
      db.update(runs).set({ context: evaluated, workspaceId: workspace.id, mainSha: sha, headSha: sha, stage: "agent" }).where(eq(runs.id, run.id)).run();
      const { prompt, contextDir, revisions } = await buildAgentInput({
        run, task, evaluated, diffBaseSha: previousSha, diffPaths, mainSha: sha, headSha: sha, baseRef: sha, mergeInProgress: false, workspace,
      });
      const agentResult = config.actions.review_base_change.agent === "panel"
        ? await reviewPullRequest(run, workspace.path, prompt, operation.log, { baseSha: previousSha, contextDir, revisions, requireGrade: false })
        : await executePi({ run, cwd: workspace.path, context: prompt, readOnly: true, log: operation.log, contextDir, revisions, baseSha: previousSha });
      const result = { ...agentResult, paths: [...new Set([...diffPaths, ...agentResult.paths])] };
      db.update(runs).set({ result }).where(eq(runs.id, run.id)).run();
      assertComplete(result);
      db.update(runs).set({ stage: "publishing" }).where(eq(runs.id, run.id)).run();
    }
    const saved = db.select().from(runs).where(eq(runs.id, run.id)).get()!;
    if (!saved.result) throw new Error("Run has no saved result to publish");
    const { text } = saved.result;
    const slackReplyTs = saved.publication.slackReplyTs ?? await threadRoot(item, input).then((thread) => postMessage({ channel: thread.channel, text: escapeSlack(text), threadTs: thread.ts }));
    db.update(runs).set({ publication: { ...saved.publication, slackReplyTs, status: "published" } }).where(eq(runs.id, run.id)).run();
    finishRun(run.id, { status: "completed" });
    operation.complete();
    return db.select().from(runs).where(eq(runs.id, run.id)).get()!;
  } catch (error) {
    const failed = finishRun(run.id, { status: "failed", error });
    operation.fail(error);
    return failed;
  } finally {
    if (workspace) {
      try { await removeWorkspace(workspace.id, references); }
      catch { operation.log.warn({ event: "run.cleanup_pending", workspaceId: workspace.id }); }
    }
  }
}
