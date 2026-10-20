import type { ErrorDetails } from "./errors.ts";
import type { runs } from "./schema.ts";

export function hasPublicationSnapshot(run: typeof runs.$inferSelect | undefined): run is typeof runs.$inferSelect & {
  result: AgentResult; context: NonNullable<typeof runs.$inferSelect.context>;
} {
  return run?.stage === "publishing" && Boolean(run.result && run.context);
}

export function hasValidationCheckpoint(run: typeof runs.$inferSelect | undefined): run is typeof runs.$inferSelect & {
  result: AgentResult; context: NonNullable<typeof runs.$inferSelect.context>;
  agentCheckpoint: NonNullable<typeof runs.$inferSelect.agentCheckpoint>; workspaceId: string; mainSha: string;
} {
  return run?.stage === "validating" && run.result?.outcome === "complete"
    && Boolean(run.context && run.agentCheckpoint && run.workspaceId && run.mainSha);
}

const prGrades = ["S", "A", "B", "C", "D", "F"] as const;
export type PrGrade = typeof prGrades[number];

export type AgentResult = {
  text: string;
  ready: boolean;
  paths: string[];
  outcome: "complete" | "incomplete" | "needs_decision";
  grade?: PrGrade;
};

export type Reviewer = {
  provider: string;
  model: string;
  thinkingLevel: string;
  piSessionId?: string;
  piSessionFile?: string;
  result?: AgentResult;
  error?: ErrorDetails;
};

export class ResultFormatError extends Error {
  readonly code = "SCRAT_FORMAT";
}

export class CheckFailure extends Error {
  readonly code = "CHECK_FAILED";
}

export class SecretLeakError extends Error {
  readonly code = "SECRET_IN_OUTPUT";
}

export function parseResult(output: string, paths: string[], { requireGrade = false }: { requireGrade?: boolean } = {}): AgentResult {
  const lines = output.trim().split("\n");
  const marker = lines.pop()?.trim();
  const outcome = marker?.startsWith("SCRAT_STATUS: ") ? marker.slice("SCRAT_STATUS: ".length) : undefined;
  if (outcome !== "complete" && outcome !== "incomplete" && outcome !== "needs_decision") {
    throw new ResultFormatError("Pi must end its response with SCRAT_STATUS: complete, incomplete, or needs_decision");
  }
  const gradeLine = lines.at(-1)?.trim();
  const grade = prGrades.find((value) => gradeLine === `SCRAT_GRADE: ${value}`);
  if (gradeLine?.startsWith("SCRAT_GRADE:")) {
    if (!grade) throw new ResultFormatError("Pi must return a valid SCRAT_GRADE: S, A, B, C, D, or F");
    lines.pop();
  }
  const ready = lines.at(-1)?.trim() === "SCRAT_READY";
  if (ready) lines.pop();
  const text = lines.join("\n").trim();
  if (!text) throw new ResultFormatError("Pi returned no report");
  if (requireGrade && outcome === "complete" && !grade) throw new ResultFormatError("A complete consolidated PR review must include SCRAT_GRADE");
  return { text, ready, paths, outcome, grade };
}
