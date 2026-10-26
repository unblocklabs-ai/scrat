import { getRepositoryPath } from "./config.ts";
import type { ItemObservation } from "./observation.ts";
import { reviewChanges } from "./relevance.ts";
import { type Run } from "./schema.ts";

type SavedEvaluation = { revision?: string; baseBranch?: string; mainSha?: string | null; paths: string[] };
export type Freshness =
  | { kind: "current"; baseMoved: boolean }
  | { kind: "stale"; reason: "context" | "base"; changedPaths: string[] };
type Current = Pick<ItemObservation, "revision" | "baseBranch" | "priorRevision"> & {
  mainSha?: string | (() => Promise<string>);
};

export const savedEvaluation = (run: Pick<Run, "mainSha" | "result"> & { context: Pick<NonNullable<Run["context"]>, "revision" | "baseBranch"> | null }): SavedEvaluation => ({
  revision: run.context?.revision, baseBranch: run.context?.baseBranch, mainSha: run.mainSha, paths: run.result?.paths ?? [],
});

export async function freshness(saved: SavedEvaluation, now: Current, mode: "exact" | "relevant-paths", unknownBaseIsCurrent = false): Promise<Freshness> {
  const stale = (reason: "context" | "base", changedPaths: string[] = []): Freshness => ({ kind: "stale", reason, changedPaths });
  const sameRevision = saved.revision === now.revision || (saved.revision !== undefined && saved.revision === now.priorRevision);
  if (!sameRevision || saved.baseBranch !== now.baseBranch) return stale("context");
  if (now.mainSha === undefined) return { kind: "current", baseMoved: false };
  if (!saved.mainSha) return unknownBaseIsCurrent ? { kind: "current", baseMoved: false } : stale("context");
  const mainSha = typeof now.mainSha === "string" ? now.mainSha : await now.mainSha();
  if (saved.mainSha === mainSha) return { kind: "current", baseMoved: false };
  if (mode === "exact") return stale("base");
  const changes = await reviewChanges(getRepositoryPath(), saved.mainSha, mainSha, saved.paths);
  return changes.relevant ? stale("base", changes.paths) : { kind: "current", baseMoved: true };
}
