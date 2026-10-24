import { actionsPublishing, actionsTriggeredBy } from "./actions.ts";
import { branchConflictCode } from "./errors.ts";
import { freshness, savedEvaluation } from "./freshness.ts";
import type { ItemObservation } from "./observation.ts";
import { hasPublicationSnapshot } from "./results.ts";
import { runHistory } from "./run-history.ts";
import type { Run } from "./schema.ts";

type History = ReturnType<typeof runHistory>;

function selectAssessment(history: History) {
  const byId = new Map(history.map((entry) => [entry.run.id, entry]));
  let selected: (History[number] & { result: NonNullable<Run["result"]>; originSequence: number; originId: string }) | undefined;
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
      if (!origin.run.inferenceFromRunId && !hasPublicationSnapshot(parent.run)) break;
      origin = parent;
    }
    const { sequence } = origin.run;
    if (!selected || sequence > selected.originSequence) {
      selected = { ...entry, result: run.result, originSequence: sequence, originId: origin.run.id };
    }
  }
  return selected;
}

export function priorReviewTexts(subjectId: string) {
  const assessment = selectAssessment(runHistory(subjectId, actionsPublishing("pr_assessment")));
  if (!assessment) return undefined;
  const repair = runHistory(subjectId, actionsTriggeredBy("low_grade"))
    .find(({ run }) => run.result?.outcome === "complete" && run.sequence > assessment.run.sequence)?.run.result?.text;
  return { assessment: assessment.result.text, repair };
}

type Assessment = NonNullable<ReturnType<typeof selectAssessment>>;
export type PrReviewState =
  | { kind: "missing" }
  | { kind: "stale"; reason: "context" | "base"; assessment: Assessment; changedPaths: string[] }
  | { kind: "current"; assessment: Assessment }
  | { kind: "blocked"; attempt: History[number] };

export async function resolvePrReview(history: History, now: ItemObservation, mainSha: string): Promise<PrReviewState> {
  const [latest] = history;
  if (latest?.run.error?.code === branchConflictCode && "head" in now.item && latest.run.headSha === now.item.head.sha && latest.run.mainSha === mainSha && latest.run.context?.baseBranch === now.baseBranch) return { kind: "blocked", attempt: latest };
  const assessment = selectAssessment(history);
  if (!assessment) return { kind: "missing" };
  if (now.item.state !== "open") return { kind: "stale", reason: "context", assessment, changedPaths: [] };
  const state = await freshness(savedEvaluation(assessment.run), { ...now, mainSha }, "relevant-paths");
  return state.kind === "current" ? { kind: "current", assessment } : { kind: "stale", reason: state.reason, assessment, changedPaths: state.changedPaths };
}
