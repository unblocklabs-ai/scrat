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

export const prGrades = ["S", "A", "B", "C", "D", "F"] as const;
export type PrGrade = typeof prGrades[number];

const reviewVerdicts = ["clean", "concerns", "breaking"] as const;
type ReviewVerdict = typeof reviewVerdicts[number];
const storefrontResults = ["verified", "regression", "unavailable"] as const;

type ReportedIssue = { title: string; body: string; fingerprint: string };

export type AgentResult = {
  text: string;
  ready: boolean;
  paths: string[];
  outcome: "complete" | "incomplete" | "needs_decision";
  grade?: PrGrade;
  verdict?: ReviewVerdict;
  storefront?: typeof storefrontResults[number];
  issues?: ReportedIssue[];
  storefrontReview?: { slack: string; report?: string; session?: Pick<Reviewer, "piSessionId" | "piSessionFile" | "thinkingLevel"> };
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
  const verdictLine = lines.at(-1)?.trim();
  const verdict = reviewVerdicts.find((value) => verdictLine === `SCRAT_VERDICT: ${value}`);
  if (verdictLine?.startsWith("SCRAT_VERDICT:")) {
    if (!verdict) throw new ResultFormatError("Pi must return a valid SCRAT_VERDICT: clean, concerns, or breaking");
    lines.pop();
  }
  const gradeLine = lines.at(-1)?.trim();
  const grade = prGrades.find((value) => gradeLine === `SCRAT_GRADE: ${value}`);
  if (gradeLine?.startsWith("SCRAT_GRADE:")) {
    if (!grade) throw new ResultFormatError("Pi must return a valid SCRAT_GRADE: S, A, B, C, D, or F");
    lines.pop();
  }
  const storefrontLine = lines.at(-1)?.trim();
  const storefront = storefrontResults.find((value) => storefrontLine === `SCRAT_STOREFRONT: ${value}`);
  if (storefrontLine?.startsWith("SCRAT_STOREFRONT:")) {
    if (!storefront) throw new ResultFormatError("Pi must return a valid SCRAT_STOREFRONT: verified, regression, or unavailable");
    lines.pop();
  }
  const ready = lines.at(-1)?.trim() === "SCRAT_READY";
  if (ready) lines.pop();
  const issues = popIssues(lines);
  const text = lines.join("\n").trim();
  if (!text) throw new ResultFormatError("Pi returned no report");
  if (requireGrade && outcome === "complete" && !grade) throw new ResultFormatError("A complete consolidated PR review must include SCRAT_GRADE");
  return { text, ready, paths, outcome, grade, verdict, storefront, issues: issues.length ? issues : undefined };
}

export function storefrontProblem({ storefront, grade }: AgentResult, regressionMaxGrade: PrGrade, regressionReported: boolean) {
  if (!storefront) return "A complete storefront review must include SCRAT_STOREFRONT immediately before SCRAT_GRADE";
  if (regressionReported && storefront !== "regression") return "An earlier answer reported SCRAT_STOREFRONT: regression; keep that line and lower the grade instead of changing the result";
  if (storefront === "regression" && grade && prGrades.indexOf(grade) < prGrades.indexOf(regressionMaxGrade)) {
    return `SCRAT_STOREFRONT: regression caps the grade at ${regressionMaxGrade}; lower SCRAT_GRADE and the grade in the assessment to ${regressionMaxGrade} or below and keep the confirmed regression among the findings`;
  }
}
