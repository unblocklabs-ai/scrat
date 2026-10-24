import type { ErrorDetails } from "./errors.ts";
import { fingerprintPattern } from "./markers.ts";
import { type Run } from "./schema.ts";

export function hasPublicationSnapshot<R extends Pick<Run, "stage" | "result"> & { context: object | null }>(run: R | undefined): run is R & {
  result: AgentResult; context: NonNullable<R["context"]>;
} {
  return run?.stage === "publishing" && Boolean(run.result && run.context);
}

export function hasValidationCheckpoint(run: Run | undefined): run is Run & {
  result: AgentResult; context: NonNullable<Run["context"]>;
  agentCheckpoint: NonNullable<Run["agentCheckpoint"]>; workspaceId: string; mainSha: string;
} {
  return run?.stage === "validating" && run.result?.outcome === "complete"
    && Boolean(run.context && run.agentCheckpoint && run.workspaceId && run.mainSha);
}

export function entryStage(previousRun: Run | undefined, retryMode: "repair" | "validation"): Run["stage"] {
  return retryMode === "validation" ? "validating" : hasPublicationSnapshot(previousRun) ? "publishing" : "preparing";
}

const prGrades = ["S", "A", "B", "C", "D", "F"] as const;
export type PrGrade = typeof prGrades[number];

type ReportedIssue = { title: string; body: string; fingerprint: string };

export type AgentResult = {
  text: string;
  ready: boolean;
  paths: string[];
  outcome: "complete" | "incomplete" | "needs_decision";
  grade?: PrGrade;
  issues?: ReportedIssue[];
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

export class InterruptedError extends Error {
  override readonly name = "InterruptedError";
  readonly code = "RUN_INTERRUPTED";
}

export class SecretLeakError extends Error {
  readonly code = "SECRET_IN_OUTPUT";
}

export function assertComplete(result: AgentResult) {
  if (result.outcome !== "complete") {
    throw Object.assign(new Error(`Agent returned ${result.outcome}: ${result.text}`), { code: "AGENT_INCOMPLETE" });
  }
}

const issueBegin = "SCRAT_ISSUE_BEGIN", issueEnd = "SCRAT_ISSUE_END";

function reportedIssue(title: unknown, fingerprint: unknown, body: unknown): ReportedIssue {
  if (typeof title !== "string" || !title.trim() || title.includes("\n") || title.length > 256) {
    throw new ResultFormatError("A SCRAT_ISSUE title must be a single non-empty line of at most 256 characters");
  }
  if (typeof fingerprint !== "string" || !fingerprintPattern.test(fingerprint)) {
    throw new ResultFormatError("A SCRAT_ISSUE fingerprint must match [A-Za-z0-9._:-]{1,128}");
  }
  if (typeof body !== "string" || !body.trim()) throw new ResultFormatError("A SCRAT_ISSUE block must have a body");
  return { title: title.trim(), fingerprint, body: body.trim() };
}

function fencedIssue(block: string[]) {
  const [title, fingerprint, gap, ...body] = block;
  if (!title?.startsWith("title: ") || !fingerprint?.startsWith("fingerprint: ") || gap?.trim() !== "") {
    throw new ResultFormatError(`A ${issueBegin} block must have a "title: " line, a "fingerprint: " line, a blank line, then the body`);
  }
  return reportedIssue(title.slice("title: ".length), fingerprint.slice("fingerprint: ".length).trim(), body.join("\n"));
}

function popIssues(lines: string[]) {
  const issues: ReportedIssue[] = [];
  for (;;) {
    while (lines.at(-1)?.trim() === "") lines.pop();
    const last = lines.at(-1)?.trim();
    if (last !== issueEnd) break;
    lines.pop();
    const begin = lines.findLastIndex((line) => line.trim() === issueBegin);
    if (begin < 0) throw new ResultFormatError(`${issueEnd} has no matching ${issueBegin}`);
    issues.push(fencedIssue(lines.splice(begin).slice(1)));
  }
  return issues.reverse();
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
  const issues = popIssues(lines);
  const text = lines.join("\n").trim();
  if (!text) throw new ResultFormatError("Pi returned no report");
  if (requireGrade && outcome === "complete" && !grade) throw new ResultFormatError("A complete consolidated PR review must include SCRAT_GRADE");
  return { text, ready, paths, outcome, grade, issues: issues.length ? issues : undefined };
}
