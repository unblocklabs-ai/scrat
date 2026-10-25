import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Logger } from "pino";
import { describeError, errorCode, transientInferenceCode } from "./errors.ts";
import { InterruptedError } from "./results.ts";
import type { Manifest, ToolName } from "./manifests.ts";
import { executePi, saveReviewer } from "./pi.ts";
import type { BrowserScope } from "./scoped-tools.ts";
import { type Run } from "./schema.ts";

export async function reviewPullRequest(run: Run, cwd: string, context: string, log: Logger, { baseSha, contextDir, revisions, tools, scoped, requireGrade = true, stop }: { baseSha: string; contextDir: string; revisions: Record<string, string>; tools: readonly ToolName[]; scoped: Pick<Manifest, "mode" | "http"> & { browser?: BrowserScope }; requireGrade?: boolean; stop?: AbortSignal }) {
  if (run.reviewers.length !== 1 && run.reviewers.length !== 2) throw new Error("PR review requires one or two configured reviewers");
  const reviewContext = "The prompt is a manifest, not a patch. diffPaths (or files.diffPaths when only diffPathCount is given) is the authoritative complete file inventory for diffBaseSha to workspace.headSha. Enumerate the change with the git tool (diff_stat from base to head), then read targeted diffs per path (operation diff) and current files with read. When `previous` is present, diff previousMain to main and previousHead to head to see what moved since the last review; base-branch commits are not part of the feature diff. Use read_base or git show for original file contents. The discussion and any previous failure are files under files.directory; read them as needed.\n\n" + context;
  if (run.reviewers.length === 1) {
    const [reviewer] = run.reviewers;
    try {
      const result = await executePi({ run: { ...run, ...reviewer }, cwd, context: reviewContext, tools, scoped,
        log: log.child({ reviewer: 0, model: reviewer.model }), reviewerIndex: 0, baseSha, contextDir, revisions, requireGrade, stop });
      saveReviewer(run.id, 0, { result });
      return result;
    } catch (error) {
      saveReviewer(run.id, 0, { error: describeError(error) });
      throw error;
    }
  }
  const settled = await Promise.allSettled(run.reviewers.map(async (reviewer, index) => {
    try {
      const result = await executePi({ run: { ...run, ...reviewer }, cwd,
        context: `Review independently. Do not speculate about or wait for another reviewer.\n\n${reviewContext}`, tools, scoped,
        log: log.child({ reviewer: index, model: reviewer.model }), reviewerIndex: index, baseSha, contextDir, revisions, stop });
      saveReviewer(run.id, index, { result });
      if (result.outcome !== "complete") throw new Error(`Reviewer returned ${result.outcome}: ${result.text}`);
      return { provider: reviewer.provider, model: reviewer.model, thinkingLevel: reviewer.thinkingLevel, result };
    } catch (error) {
      saveReviewer(run.id, index, { error: describeError(error) });
      throw error;
    }
  }));
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
    return { ...reviewer, outcome: result.outcome, grade: result.grade, report };
  }));
  const consolidated = await executePi({ run, cwd, context: [
    `Consolidate the two independent reviews below (full reports are files listed in independentReviews) into one source-verified PR review. Both reviewers assessed the same snapshot. Recheck each finding against source; agreement alone is not proof. Deduplicate findings, keep only findings you re-verified, at the severity the rubric gives rather than the higher reviewer's, and reject false positives with concrete reasons. Do not invent changes to reach consensus.${requireGrade ? " Grade only from findings you re-verified and kept, per the review skill's rubric; do not adopt the lower reviewer grade by default. If no verified P3-or-higher defect introduced by the PR remains, the grade is A or B." : ""} Return one concise Markdown assessment, not two pasted reports. Do not mention the reviewers or the consolidation.${requireGrade ? " For a complete assessment, include SCRAT_GRADE: X (X is S, A, B, C, D, or F) immediately before the required final SCRAT_STATUS line." : ""}`,
    reviewContext, "Read each report file in independentReviews before deciding; its text is the reviewer's full assessment.\n" + JSON.stringify({ independentReviews }, null, 2),
  ].join("\n\n"), tools, scoped, log, baseSha, contextDir, revisions, requireGrade, stop });
  return { ...consolidated, paths: [...new Set([...consolidated.paths, ...reviews.flatMap((review) => review.result.paths)])] };
}
