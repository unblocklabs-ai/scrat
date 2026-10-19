import { and, desc, eq } from "drizzle-orm";
import { db } from "./db.ts";
import { freshness, savedEvaluation } from "./freshness.ts";
import type { ItemObservation } from "./observation.ts";
import { hasPublicationSnapshot } from "./results.ts";
import { runs, tasks } from "./schema.ts";

export function prReviewHistory(itemId: string) {
  return db.select({ run: runs, task: tasks }).from(runs)
    .innerJoin(tasks, eq(runs.taskId, tasks.id))
    .where(and(eq(tasks.itemId, itemId), eq(tasks.action, "review_pr")))
    .orderBy(desc(runs.sequence)).all();
}

type History = ReturnType<typeof prReviewHistory>;

function selectAssessment(history: History) {
  const byId = new Map(history.map((entry) => [entry.run.id, entry]));
  let selected: (History[number] & { result: NonNullable<typeof runs.$inferSelect.result>; originSequence: number; originId: string }) | undefined;
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
    const { sequence } = origin.run;
    if (sequence === null || run.sequence === null) throw new Error(`Missing run sequence for PR assessment: ${run.id}`);
    // History is claim-newest first. Copies retain their inference origin's order.
    if (!selected || sequence > selected.originSequence) {
      selected = { ...entry, result: run.result, originSequence: sequence, originId: origin.run.id };
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
export async function resolvePrReview(history: History, now: ItemObservation, mainSha: string): Promise<PrReviewState> {
  const assessment = selectAssessment(history);
  if (!assessment) return { kind: "missing" };
  if (now.item.state !== "open") return { kind: "stale", assessment, changedPaths: [] };
  const state = await freshness(savedEvaluation(assessment.run), { ...now, mainSha }, "relevant-paths");
  return state.kind === "current" ? { kind: "current", assessment } : { kind: "stale", assessment, changedPaths: state.changedPaths };
}
