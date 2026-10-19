import { and, desc, eq } from "drizzle-orm";
import { config, getRepositoryPath } from "./config.ts";
import { db } from "./db.ts";
import { evaluateGithubContext } from "./github-context.ts";
import type { GithubContext } from "./github-types.ts";
import { reviewChanges } from "./relevance.ts";
import { hasPublicationSnapshot } from "./results.ts";
import { events, runs, tasks } from "./schema.ts";

export function prReviewHistory(itemId: string) {
  return db.select({ run: runs, task: tasks, sequence: events.id }).from(runs)
    .innerJoin(tasks, eq(runs.taskId, tasks.id))
    .leftJoin(events, and(eq(events.runId, runs.id), eq(events.type, "run.started")))
    .where(and(eq(tasks.itemId, itemId), eq(tasks.action, "review_pr")))
    .orderBy(desc(events.id)).all();
}

type History = ReturnType<typeof prReviewHistory>;

function selectAssessment(history: History) {
  const byId = new Map(history.map((entry) => [entry.run.id, entry]));
  let selected: (History[number] & { result: NonNullable<typeof runs.$inferSelect.result>; originSequence: number }) | undefined;
  for (const entry of history) {
    const { run } = entry;
    if (!hasPublicationSnapshot(run) || run.result.outcome !== "complete" || run.publication.status === "not_needed") continue;
    let origin = entry;
    const visited = new Set<string>();
    while (origin.run.inferenceFromRunId || origin.run.retryOfRunId) {
      if (visited.has(origin.run.id)) throw new Error(`Cyclic PR assessment ancestry: ${origin.run.id}`);
      visited.add(origin.run.id);
      const parentId = origin.run.inferenceFromRunId ?? origin.run.retryOfRunId!;
      const parent = byId.get(parentId);
      if (!parent) throw new Error(`Missing PR assessment ancestor: ${parentId}`);
      // New copies carry explicit provenance; legacy publication retries can
      // still be reconstructed using their original publication-only rule.
      if (!origin.run.inferenceFromRunId && !hasPublicationSnapshot(parent.run)) break;
      origin = parent;
    }
    if (origin.sequence === null || entry.sequence === null) throw new Error(`Missing run.started event for PR assessment: ${run.id}`);
    // History is delivery-newest first. Copies retain their inference origin's order.
    if (!selected || origin.sequence > selected.originSequence) {
      selected = { ...entry, result: run.result, originSequence: origin.sequence };
    }
  }
  return selected;
}

type Assessment = NonNullable<ReturnType<typeof selectAssessment>>;
export type PrReviewState =
  | { kind: "missing" }
  | { kind: "stale"; assessment: Assessment; changedPaths: string[] }
  | { kind: "current"; assessment: Assessment };

// Authority first, freshness second. A stale opinion never revives an older one.
export async function resolvePrReview(history: History, current: GithubContext, mainSha: string): Promise<PrReviewState> {
  const assessment = selectAssessment(history);
  if (!assessment) return { kind: "missing" };
  const { run, result } = assessment;
  const baseBranch = "base" in current.item ? current.item.base.ref : config.github.baseBranch;
  const { revision } = evaluateGithubContext(current, config.github.botLogin);
  if (current.item.state !== "open" || run.context?.revision !== revision
    || run.context.baseBranch !== baseBranch || !run.mainSha) {
    return { kind: "stale", assessment, changedPaths: [] };
  }
  if (run.mainSha !== mainSha) {
    const changes = await reviewChanges(getRepositoryPath(), run.mainSha, mainSha, result.paths);
    if (changes.relevant) return { kind: "stale", assessment, changedPaths: changes.paths };
  }
  return { kind: "current", assessment };
}
