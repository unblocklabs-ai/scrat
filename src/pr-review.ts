import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describeError, errorCode, SupersededError, transientInferenceCode } from "./errors.ts";
import { InterruptedError, type Reviewer } from "./results.ts";
import { executePi, type PiOptions, saveReviewer } from "./pi.ts";
import { getRun, updateRun } from "./run-history.ts";

type ConfiguredReviewer = Pick<Reviewer, "provider" | "model" | "thinkingLevel">;

export async function reviewPullRequest(options: PiOptions & { contextDir: string }, context: string, requireGrade = true, configuredReviewers?: readonly ConfiguredReviewer[]) {
  const { log, contextDir, storefront } = options;
  let { run } = options;
  if (run.reviewers.length !== 1 && run.reviewers.length !== 2) throw new Error("PR review requires one or two configured reviewers");
  const reviewContext = "The prompt is a manifest, not a patch. diffPaths (or files.diffPaths when only diffPathCount is given) is the authoritative complete file inventory for diffBaseSha to workspace.headSha. When diffStat (or files.diffStat) is already provided, use it directly instead of calling git diff_stat; otherwise enumerate the change with the git tool (diff_stat from base to head). Then read targeted diffs per path (operation diff) and current files with read. When `previous` is present, use previousMainDiffStat / previousHeadDiffStat (or files.previousMainDiffStat / files.previousHeadDiffStat) when provided and diff previousMain to main and previousHead to head to see what moved since the last review; base-branch commits are not part of the feature diff. Use read_base or git show for original file contents. The discussion and any previous failure are files under files.directory; read them as needed.\n\n" + context;
  let panel = run.reviewers.length > 1;
  const review = async (index: number, context: string, requireGrade?: boolean) => {
    const reviewer = run.reviewers[index];
    if (panel && !reviewer.error && reviewer.result?.outcome === "complete" && Boolean(reviewer.result.storefront) === Boolean(storefront)) return reviewer.result;
    if (panel && (reviewer.result || reviewer.error)) saveReviewer(run.id, index, { result: undefined, error: undefined });
    try {
      const result = await executePi({ ...options, run: { ...run, ...reviewer }, log: log.child({ reviewer: index, model: reviewer.model }) }, { context, reviewerIndex: index, requireGrade });
      saveReviewer(run.id, index, { result, error: undefined });
      if (panel && result.outcome !== "complete") throw new Error(`Reviewer returned ${result.outcome}: ${result.text}`);
      return result;
    } catch (error) {
      if (!(error instanceof SupersededError)) saveReviewer(run.id, index, { error: describeError(error) });
      throw error;
    }
  };
  if (!panel) {
    const first = await review(0, reviewContext, requireGrade);
    const second = configuredReviewers?.length === 2 && first.obsolete ? configuredReviewers[1] : undefined;
    if (!second) return first;
    const { provider, model, thinkingLevel } = second;
    updateRun(run.id, { reviewers: [...getRun(run.id)!.reviewers, { provider, model, thinkingLevel }] });
    run = getRun(run.id)!;
    panel = true;
    log.info({ event: "review.obsolete_escalated", runId: run.id, model });
  }
  const settled = await Promise.allSettled(run.reviewers.map(async ({ provider, model, thinkingLevel }, index) => ({ provider, model, thinkingLevel, result: await review(index, `Review independently. Do not speculate about or wait for another reviewer.\n\n${reviewContext}`) })));
  const failed = settled.find((entry) => entry.status === "rejected");
  const superseded = settled.find((entry) => entry.status === "rejected" && entry.reason instanceof SupersededError);
  if (superseded?.status === "rejected") throw superseded.reason;
  const interrupted = settled.find((entry) => entry.status === "rejected" && entry.reason instanceof InterruptedError);
  if (interrupted?.status === "rejected") throw interrupted.reason;
  if (failed?.status === "rejected") {
    const transient = settled.every((entry) => entry.status === "fulfilled" || errorCode(entry.reason) === transientInferenceCode);
    throw Object.assign(new Error("An independent PR reviewer did not finish", { cause: failed.reason }), transient ? { code: transientInferenceCode } : {});
  }
  const reviews = settled.flatMap((entry) => entry.status === "fulfilled" ? [entry.value] : []);
  const independentReviews = await Promise.all(reviews.map(async ({ result, ...reviewer }, index) => {
    const report = resolve(contextDir, `reviewer-${index + 1}.md`);
    await writeFile(report, result.text + "\n");
    return { ...reviewer, outcome: result.outcome, grade: result.grade, ...storefront && { storefront: result.storefront }, obsolete: Boolean(result.obsolete), report };
  }));
  const consolidated = await executePi(options, { context: [
    `Consolidate the two independent reviews below (full reports are files listed in independentReviews) into one source-verified PR review. Both reviewers assessed the same snapshot. Recheck each finding against source; agreement alone is not proof. Deduplicate findings, keep only findings you re-verified, at the severity the rubric gives rather than the higher reviewer's, and reject false positives with concrete reasons. Do not invent changes to reach consensus.${requireGrade ? " Grade only from findings you re-verified and kept, per the review skill's rubric; do not adopt the lower reviewer grade by default. If no verified P3-or-higher defect introduced by the PR remains, the grade is A or B." : ""}${storefront ? " Each review's storefront result is listed with its grade: re-run in the browser, after reset, only the storefront regressions and fix claims the reviewers report or disagree on, and decide SCRAT_STOREFRONT from what you confirm." : ""}${reviews.some(({ result }) => result.obsolete) ? " A review with obsolete: true reported SCRAT_OBSOLETE: true. Re-verify against the base branch with git show at revision=main whether every material change in the PR is already resolved there outside this PR; only when you confirm it, lead the assessment with the base-branch path:line proof and include SCRAT_OBSOLETE: true immediately before the SCRAT_GRADE line." : ""} Return one concise Markdown assessment, not two pasted reports. Do not mention the reviewers or the consolidation.${requireGrade ? " For a complete assessment, include SCRAT_GRADE: X (X is S, A, B, C, D, or F) immediately before the required final SCRAT_STATUS line." : ""}`,
    reviewContext, "Read each report file in independentReviews before deciding; its text is the reviewer's full assessment.\n" + JSON.stringify({ independentReviews }, null, 2),
  ].join("\n\n"), requireGrade });
  return { ...consolidated, paths: [...new Set([...consolidated.paths, ...reviews.flatMap((review) => review.result.paths)])] };
}
