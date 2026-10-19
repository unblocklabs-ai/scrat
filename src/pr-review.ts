import { eq } from "drizzle-orm";
import type { Logger } from "pino";
import { db } from "./db.ts";
import { describeError } from "./errors.ts";
import { executePi, saveReviewer } from "./pi.ts";
import { runs } from "./schema.ts";

export async function reviewPullRequest(run: typeof runs.$inferSelect, cwd: string, context: string, log: Logger, baseSha: string) {
  if (run.reviewers.length !== 2) throw new Error("PR review requires two configured reviewers");
  const reviewContext = "diffPaths is the authoritative complete file inventory for diffBaseSha to workspace.headSha. The diff is the full feature comparison. mainChanges and prChanges are incremental context and may include merged base-branch commits; do not confuse them with the feature diff. Use read_base for original file contents.\n\n" + context;
  const settled = await Promise.allSettled(run.reviewers.map(async (reviewer, index) => {
    try {
      const result = await executePi({ run: { ...run, ...reviewer }, cwd,
        context: `Review independently. Do not speculate about or wait for another reviewer.\n\n${reviewContext}`, readOnly: true,
        log: log.child({ reviewer: index, model: reviewer.model }), reviewerIndex: index, baseSha });
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
  const consolidated = await executePi({ run, cwd, context: [
    "Consolidate the two independent reviews below into one source-verified PR review. Both reviewers assessed the same snapshot. Recheck disputed findings against source; agreement alone is not proof. Deduplicate findings, preserve every defensible issue and material uncertainty, and reject false positives with concrete reasons. Do not invent changes to reach consensus. Return one concise Markdown assessment, not two pasted reports. For a complete assessment, include SCRAT_GRADE: X (X is S, A, B, C, D, or F) immediately before the required final SCRAT_STATUS line.",
    reviewContext, JSON.stringify({ independentReviews: reviews }, null, 2),
  ].join("\n\n"), readOnly: true, log, baseSha });
  if (consolidated.outcome === "complete" && !consolidated.grade) throw new Error("A complete consolidated PR review must include SCRAT_GRADE");
  return { ...consolidated, paths: [...new Set([...consolidated.paths, ...reviews.flatMap((review) => review.result.paths)])] };
}
