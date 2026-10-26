import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describeError, errorCode, transientInferenceCode } from "./errors.ts";
import { InterruptedError } from "./results.ts";
import { executePi, type PiOptions, saveReviewer } from "./pi.ts";

export async function reviewPullRequest(options: PiOptions & { contextDir: string }, context: string, requireGrade = true) {
  const { run, log, contextDir, storefront } = options;
  if (run.reviewers.length !== 1 && run.reviewers.length !== 2) throw new Error("PR review requires one or two configured reviewers");
  const reviewContext = "The prompt is a manifest, not a patch. diffPaths (or files.diffPaths when only diffPathCount is given) is the authoritative complete file inventory for diffBaseSha to workspace.headSha. Enumerate the change with the git tool (diff_stat from base to head), then read targeted diffs per path (operation diff) and current files with read. When `previous` is present, diff previousMain to main and previousHead to head to see what moved since the last review; base-branch commits are not part of the feature diff. Use read_base or git show for original file contents. The discussion and any previous failure are files under files.directory; read them as needed.\n\n" + context;
  const panel = run.reviewers.length > 1;
  const review = async (index: number, context: string, requireGrade?: boolean) => {
    const reviewer = run.reviewers[index];
    try {
      const result = await executePi({ ...options, run: { ...run, ...reviewer }, log: log.child({ reviewer: index, model: reviewer.model }) }, { context, reviewerIndex: index, requireGrade });
      saveReviewer(run.id, index, { result });
      if (panel && result.outcome !== "complete") throw new Error(`Reviewer returned ${result.outcome}: ${result.text}`);
      return result;
    } catch (error) {
      saveReviewer(run.id, index, { error: describeError(error) });
      throw error;
    }
  };
  if (!panel) return review(0, reviewContext, requireGrade);
  const settled = await Promise.allSettled(run.reviewers.map(async ({ provider, model, thinkingLevel }, index) => ({ provider, model, thinkingLevel, result: await review(index, `Review independently. Do not speculate about or wait for another reviewer.\n\n${reviewContext}`) })));
  const failed = settled.find((entry) => entry.status === "rejected");
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
    return { ...reviewer, outcome: result.outcome, grade: result.grade, ...storefront && { storefront: result.storefront }, report };
  }));
  const consolidated = await executePi(options, { context: [
    `Consolidate the two independent reviews below (full reports are files listed in independentReviews) into one source-verified PR review. Both reviewers assessed the same snapshot. Recheck each finding against source; agreement alone is not proof. Deduplicate findings, keep only findings you re-verified, at the severity the rubric gives rather than the higher reviewer's, and reject false positives with concrete reasons. Do not invent changes to reach consensus.${requireGrade ? " Grade only from findings you re-verified and kept, per the review skill's rubric; do not adopt the lower reviewer grade by default. If no verified P3-or-higher defect introduced by the PR remains, the grade is A or B." : ""}${storefront ? " Each review's storefront result is listed with its grade: re-run in the browser, after reset, only the storefront regressions and fix claims the reviewers report or disagree on, and decide SCRAT_STOREFRONT from what you confirm." : ""} Return one concise Markdown assessment, not two pasted reports. Do not mention the reviewers or the consolidation.${requireGrade ? " For a complete assessment, include SCRAT_GRADE: X (X is S, A, B, C, D, or F) immediately before the required final SCRAT_STATUS line." : ""}`,
    reviewContext, "Read each report file in independentReviews before deciding; its text is the reviewer's full assessment.\n" + JSON.stringify({ independentReviews }, null, 2),
  ].join("\n\n"), requireGrade });
  return { ...consolidated, paths: [...new Set([...consolidated.paths, ...reviews.flatMap((review) => review.result.paths)])] };
}
