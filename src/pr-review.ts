import { eq } from "drizzle-orm";
import type { Logger } from "pino";
import { db } from "./db.ts";
import { describeError } from "./errors.ts";
import { executePi, saveReviewer } from "./pi.ts";
import { runs } from "./schema.ts";

export async function reviewPullRequest(run: typeof runs.$inferSelect, cwd: string, context: string, log: Logger) {
  if (run.reviewers.length !== 2) throw new Error("PR review requires two configured reviewers");
  const settled = await Promise.allSettled(run.reviewers.map(async (reviewer, index) => {
    try {
      const result = await executePi({ ...run, ...reviewer }, cwd,
        `Review independently. Do not speculate about or wait for another reviewer.\n\n${context}`, true,
        log.child({ reviewer: index, model: reviewer.model }), undefined, {}, index);
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
  const consolidated = await executePi(run, cwd, [
    "Consolidate the two independent reviews below into one source-verified PR review. Both reviewers assessed the same snapshot. Recheck disputed findings against source; agreement alone is not proof. Deduplicate findings, preserve every defensible issue and material uncertainty, and reject false positives with concrete reasons. Do not invent changes to reach consensus. Return one concise Markdown assessment, not two pasted reports, and follow the required SCRAT_STATUS output contract.",
    context, JSON.stringify({ independentReviews: reviews }, null, 2),
  ].join("\n\n"), true, log);
  return { ...consolidated, paths: [...new Set([...consolidated.paths, ...reviews.flatMap((review) => review.result.paths)])] };
}
