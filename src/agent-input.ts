import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { actionContracts } from "./actions.ts";
import { db } from "./db.ts";
import type { ErrorDetails } from "./errors.ts";
import { git } from "./git.ts";
import { commentKey, parseCommentKey } from "./markers.ts";
import type { ItemObservation } from "./observation.ts";
import { priorReviewTexts } from "./pr-assessment.ts";
import { runs, tasks } from "./schema.ts";

const inlineDiffPaths = 200;

type Run = typeof runs.$inferSelect;
type Task = typeof tasks.$inferSelect;

export async function readDiffScope(repositoryPath: string, mainSha: string, preparedHead: string, isPullRequest: boolean) {
  const [diffBaseSha, diffPaths] = await Promise.all([
    isPullRequest ? git(repositoryPath, ["merge-base", mainSha, preparedHead]) : mainSha,
    isPullRequest ? git(repositoryPath, ["diff", "--name-only", "--no-renames", "-z", `${mainSha}...${preparedHead}`]).then((output) => output.split("\0").filter(Boolean)) : [],
  ]);
  return { diffBaseSha, diffPaths };
}

export function evaluateContext(run: Run, task: Task, observation: ItemObservation) {
  const requested = run.input.commentRevisions;
  const ids = new Set(Array.isArray(requested)
    ? requested.filter((entry: unknown): entry is string => typeof entry === "string").map(parseCommentKey) : []);
  const comments = actionContracts[task.action].context === "feedback" && ids.size
    ? observation.external.filter((comment) => ids.has(comment.id)) : observation.external;
  return {
    revision: observation.revision, baseBranch: observation.baseBranch, headSha: "head" in observation.item ? observation.item.head.sha : undefined,
    item: { number: observation.item.number, title: observation.item.title, body: observation.item.body, url: observation.item.html_url },
    comments,
    commentRevisions: comments.map((comment) => commentKey(comment)),
  };
}

export async function buildAgentInput(options: {
  run: Run; task: Task; evaluated: ReturnType<typeof evaluateContext>; diffBaseSha: string; diffPaths: string[];
  mainSha: string; headSha: string; baseRef: string; mergeInProgress: boolean;
  workspace: { path: string; branch: string | null };
  database?: Record<string, unknown>;
  validationFailure?: ErrorDetails;
  scratAuthored?: boolean;
}) {
  const { run, task, evaluated, diffBaseSha, diffPaths, mainSha, headSha } = options;
  const input = { ...run.input };
  delete input.manual;
  const changedPaths = Array.isArray(input.changedPaths) ? input.changedPaths.filter((path: unknown) => typeof path === "string") : [];
  if (changedPaths.length > inlineDiffPaths) { delete input.changedPaths; input.changedPathCount = changedPaths.length; }
  const contextDir = resolve("data/runs", run.id);
  await mkdir(contextDir, { recursive: true });
  const files: Record<string, string> = { directory: contextDir };
  const writeContext = async (key: string, name: string, content: string) => {
    files[key] = resolve(contextDir, name);
    await writeFile(files[key], content);
  };
  const report = task.action === "address_review" ? db.select().from(runs).where(eq(runs.id, String(task.input.assessmentRunId))).get()?.result?.text : undefined;
  if (task.action === "address_review" && !report) throw new Error("Missing review report for self-repair");
  const failure = run.retryOfRunId ? db.select().from(runs).where(eq(runs.id, run.retryOfRunId)).get()?.error : undefined;
  const prior = task.action === "review_pr" && options.scratAuthored ? priorReviewTexts(task.itemId) : undefined;
  await Promise.all([
    writeContext("discussion", "discussion.json", JSON.stringify(evaluated.comments, null, 2)),
    report && writeContext("review", "review.md", report),
    prior && writeContext("previous_assessment", "previous-assessment.md", prior.assessment),
    prior?.repair && writeContext("previous_repair", "previous-repair.md", prior.repair),
    failure && writeContext("previousFailure", "previous-failure.json", JSON.stringify(failure, null, 2)),
    options.validationFailure && writeContext("validationFailure", "validation-failure.json", JSON.stringify(options.validationFailure, null, 2)),
    diffPaths.length > inlineDiffPaths && writeContext("diffPaths", "diff-paths.txt", diffPaths.join("\n") + "\n"),
    changedPaths.length > inlineDiffPaths && writeContext("changedPaths", "changed-paths.txt", changedPaths.join("\n") + "\n"),
  ]);
  const previousMainSha = typeof task.input.previousMainSha === "string" ? task.input.previousMainSha : undefined;
  const previousHeadSha = evaluated.headSha && typeof task.input.previousHeadSha === "string" ? task.input.previousHeadSha : undefined;
  const revisions = { head: headSha, base: diffBaseSha, main: mainSha, ...(previousMainSha && { previousMain: previousMainSha }), ...(previousHeadSha && { previousHead: previousHeadSha }) };
  const prompt = JSON.stringify({
    action: task.action,
    reason: task.reason,
    revision: evaluated.revision, baseBranch: evaluated.baseBranch, headSha: evaluated.headSha, item: evaluated.item, commentRevisions: evaluated.commentRevisions,
    input,
    workspace: { path: options.workspace.path, branch: options.workspace.branch, baseRef: options.baseRef, baseBranch: evaluated.baseBranch, mainSha, headSha, mergeInProgress: options.mergeInProgress },
    diffBaseSha, previous: previousMainSha || previousHeadSha ? { mainSha: previousMainSha, headSha: previousHeadSha } : undefined,
    ...(diffPaths.length > inlineDiffPaths ? { diffPathCount: diffPaths.length } : { diffPaths }),
    files,
    database: options.database,
  }, null, 2);
  return { prompt, contextDir, revisions };
}
