import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Logger } from "pino";
import { describeError } from "./errors.ts";
import { executePi, saveReviewer } from "./pi.ts";
import { runs } from "./schema.ts";

export async function reviewPullRequest(run: typeof runs.$inferSelect, cwd: string, context: string, log: Logger, { baseSha, contextDir, revisions, requireGrade = true }: { baseSha: string; contextDir: string; revisions: Record<string, string>; requireGrade?: boolean }) {
  if (run.reviewers.length !== 2) throw new Error("PR review requires two configured reviewers");
  const reviewContext = "The prompt is a manifest, not a patch. diffPaths (or files.diffPaths when only diffPathCount is given) is the authoritative complete file inventory for diffBaseSha to workspace.headSha. Enumerate the change with the git tool (diff_stat from base to head), then read targeted diffs per path (operation diff) and current files with read. When `previous` is present, diff previousMain to main and previousHead to head to see what moved since the last review; base-branch commits are not part of the feature diff. Use read_base or git show for original file contents. The discussion and any previous failure are files under files.directory; read them as needed.\n\n" + context;
  const settled = await Promise.allSettled(run.reviewers.map(async (reviewer, index) => {
    try {
      const result = await executePi({ run: { ...run, ...reviewer }, cwd,
        context: `Review independently. Do not speculate about or wait for another reviewer.\n\n${reviewContext}`, readOnly: true,
        log: log.child({ reviewer: index, model: reviewer.model }), reviewerIndex: index, baseSha, contextDir, revisions });
      saveReviewer(run.id, index, { result });
      if (result.outcome !== "complete") throw new Error(`Reviewer returned ${result.outcome}: ${result.text}`);
      return { provider: reviewer.provider, model: reviewer.model, thinkingLevel: reviewer.thinkingLevel, result };
    } catch (error) {
      saveReviewer(run.id, index, { error: describeError(error) });
      throw error;
    }
  }));
  const failed = settled.find((entry) => entry.status === "rejected");
  if (failed?.status === "rejected") throw new Error("An independent PR reviewer did not finish", { cause: failed.reason });
  const reviews = settled.flatMap((entry) => entry.status === "fulfilled" ? [entry.value] : []);
  const independentReviews = await Promise.all(reviews.map(async ({ result, ...reviewer }, index) => {
    const report = resolve(contextDir, `reviewer-${index + 1}.md`);
    await writeFile(report, result.text + "\n");
    return { ...reviewer, outcome: result.outcome, grade: result.grade, report };
  }));
  const consolidated = await executePi({ run, cwd, context: [
    `Consolidate the two independent reviews below (full reports are files listed in independentReviews) into one source-verified PR review. Both reviewers assessed the same snapshot. Recheck disputed findings against source; agreement alone is not proof. Deduplicate findings, preserve every defensible issue and material uncertainty, and reject false positives with concrete reasons. Do not invent changes to reach consensus.${requireGrade ? " Grade only from findings you re-verified and kept, per the review skill's rubric; do not adopt the lower reviewer grade by default. If no verified P3-or-higher defect introduced by the PR remains, the grade is A or B." : ""} Return one concise Markdown assessment, not two pasted reports.${requireGrade ? " For a complete assessment, include SCRAT_GRADE: X (X is S, A, B, C, D, or F) immediately before the required final SCRAT_STATUS line." : ""}`,
    reviewContext, "Read each report file in independentReviews before deciding; its text is the reviewer's full assessment.\n" + JSON.stringify({ independentReviews }, null, 2),
  ].join("\n\n"), readOnly: true, log, baseSha, contextDir, revisions, requireGrade });
  return { ...consolidated, paths: [...new Set([...consolidated.paths, ...reviews.flatMap((review) => review.result.paths)])] };
}
