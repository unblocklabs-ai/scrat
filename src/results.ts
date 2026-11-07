import type { ErrorDetails } from "./errors.ts";
import { fingerprintPattern } from "./markers.ts";
import { type Run } from "./schema.ts";
import type { LabelCategory } from "./manifests.ts";

export function hasPublicationSnapshot<R extends Pick<Run, "stage"> & { result: object | null; context: object | null }>(run: R | undefined): run is R & {
  result: NonNullable<R["result"]>; context: NonNullable<R["context"]>;
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

export function hasReviewCheckpoint(run: Run | undefined): run is Run & {
  result: AgentResult; context: NonNullable<Run["context"]>; mainSha: string; headSha: string;
} {
  return run?.stage === "validating" && run.result?.outcome === "complete" && Boolean(run.context && run.mainSha && run.headSha);
}

export const workerStoppedMessage = "Worker stopped before finishing this run";

export function entryStage(previousRun: Run | undefined, retryMode: "repair" | "validation", reviewResume: Run | undefined): Run["stage"] {
  return retryMode === "validation" || reviewResume ? "validating" : hasPublicationSnapshot(previousRun) ? "publishing" : "preparing";
}

export const prGrades = ["S", "A", "B", "C", "D", "F"] as const;
export type PrGrade = typeof prGrades[number];

const reviewVerdicts = ["clean", "concerns", "breaking"] as const;
type ReviewVerdict = typeof reviewVerdicts[number];
const outcomes = ["complete", "incomplete", "needs_decision"] as const;
const storefrontResults = ["verified", "regression", "unavailable"] as const;

type ReportedIssue = { title: string; body: string; fingerprint: string };
type LabelSelection = { category: string; name: string };

export type AgentResult = {
  text: string;
  ready: boolean;
  paths: string[];
  outcome: typeof outcomes[number];
  grade?: PrGrade;
  verdict?: ReviewVerdict;
  storefront?: typeof storefrontResults[number];
  issues?: ReportedIssue[];
  labels?: LabelSelection[];
  storefrontReview?: { slack: string; blocks?: unknown[]; report?: string; session?: Pick<Reviewer, "piSessionId" | "piSessionFile" | "thinkingLevel"> };
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

export const agentIncompleteCode = "AGENT_INCOMPLETE";

export function assertComplete(result: AgentResult) {
  if (result.outcome !== "complete") {
    throw Object.assign(new Error(`Agent returned ${result.outcome}: ${result.text}`), { code: agentIncompleteCode });
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

const anyOf = (values: readonly string[]) => `${values.slice(0, -1).join(", ")}, or ${values.at(-1)}`;

function popFooter<T extends string>(lines: string[], token: string, values: readonly T[]) {
  const line = lines.at(-1)?.trim();
  if (!line?.startsWith(`${token}:`)) return undefined;
  const value = values.find((candidate) => line === `${token}: ${candidate}`);
  if (!value) throw new ResultFormatError(`Pi must return a valid ${token}: ${anyOf(values)}`);
  lines.pop();
  return value;
}

export function footerRules(requireGrade: boolean, storefront: boolean, requireLabels = false) {
  return `SCRAT_READY (optional, only when ready)\n${requireLabels ? 'SCRAT_LABELS: [{"category":"...","name":"..."}] (required for a complete classification; exactly one configured choice per category)\n' : ""}${storefront ? `SCRAT_STOREFRONT: ${anyOf(storefrontResults)} (required for a complete review)\n` : ""}SCRAT_GRADE: X (${requireGrade ? "required for a complete review; " : "optional; "}X is exactly one of ${prGrades.join(", ")}, with no plus or minus)\nSCRAT_VERDICT: ${anyOf(reviewVerdicts)} (only when your instructions ask for it)\nSCRAT_STATUS: ${anyOf(outcomes)} (required, and the very last line)`;
}

const isLabelSelections = (value: unknown): value is LabelSelection[] => Array.isArray(value) && value.every((choice: unknown) =>
  typeof choice === "object" && choice !== null && "category" in choice && typeof choice.category === "string" && "name" in choice && typeof choice.name === "string");

export function validateLabelSelections(value: unknown, categories: readonly LabelCategory[]): asserts value is LabelSelection[] {
  if (!categories.length || !isLabelSelections(value) || value.length !== categories.length || categories.some(({ category, choices }) => {
    const selected = value.filter((choice) => choice.category === category);
    return selected.length !== 1 || !choices.some(({ name }) => name === selected[0]!.name);
  })) throw new ResultFormatError("SCRAT_LABELS must select exactly one allowed label per configured category, with no unknown or duplicate categories");
}

function popLabelSelections(lines: string[]) {
  const line = lines.at(-1)?.trim();
  if (!line?.startsWith("SCRAT_LABELS:")) return undefined;
  let value: unknown;
  try { value = JSON.parse(line.slice("SCRAT_LABELS:".length)); }
  catch { throw new ResultFormatError("SCRAT_LABELS must contain a JSON array of category/name objects"); }
  if (!isLabelSelections(value)) throw new ResultFormatError("SCRAT_LABELS must contain a JSON array of category/name objects");
  lines.pop();
  return value;
}

export function parseResult(output: string, paths: string[], { requireGrade = false, labelCategories }: { requireGrade?: boolean; labelCategories?: readonly LabelCategory[] } = {}): AgentResult {
  const lines = output.trim().split("\n");
  const outcome = popFooter(lines, "SCRAT_STATUS", outcomes);
  if (!outcome) throw new ResultFormatError(`Pi must end its response with SCRAT_STATUS: ${anyOf(outcomes)}`);
  const verdict = popFooter(lines, "SCRAT_VERDICT", reviewVerdicts);
  const grade = popFooter(lines, "SCRAT_GRADE", prGrades);
  const storefront = popFooter(lines, "SCRAT_STOREFRONT", storefrontResults);
  const labels = popLabelSelections(lines);
  const ready = lines.at(-1)?.trim() === "SCRAT_READY";
  if (ready) lines.pop();
  const issues = popIssues(lines);
  const text = lines.join("\n").trim();
  if (!text) throw new ResultFormatError("Pi returned no report");
  if (requireGrade && outcome === "complete" && !grade) throw new ResultFormatError("A complete consolidated PR review must include SCRAT_GRADE");
  if (labelCategories && outcome === "complete") validateLabelSelections(labels, labelCategories);
  return { text, ready, paths, outcome, grade, verdict, storefront, ...labels ? { labels } : {}, issues: issues.length ? issues : undefined };
}

export function storefrontProblem({ storefront, grade }: AgentResult, regressionMaxGrade: PrGrade, regressionReported: boolean) {
  if (!storefront) return "A complete storefront review must include SCRAT_STOREFRONT immediately before SCRAT_GRADE";
  if (regressionReported && storefront !== "regression") return "An earlier answer reported SCRAT_STOREFRONT: regression; keep that line and lower the grade instead of changing the result";
  if (storefront === "regression" && grade && prGrades.indexOf(grade) < prGrades.indexOf(regressionMaxGrade)) {
    return `SCRAT_STOREFRONT: regression caps the grade at ${regressionMaxGrade}; lower SCRAT_GRADE and the grade in the assessment to ${regressionMaxGrade} or below and keep the confirmed regression among the findings`;
  }
}
