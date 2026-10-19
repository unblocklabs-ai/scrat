import type { ErrorDetails } from "./errors.ts";

export const prGrades = ["S", "A", "B", "C", "D", "F"] as const;
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

export function parseResult(output: string, paths: string[]): AgentResult {
  const lines = output.trim().split("\n");
  const marker = lines.pop()?.trim();
  const outcome = marker?.startsWith("SCRAT_STATUS: ") ? marker.slice("SCRAT_STATUS: ".length) : undefined;
  if (outcome !== "complete" && outcome !== "incomplete" && outcome !== "needs_decision") {
    throw new Error("Pi must end its response with SCRAT_STATUS: complete, incomplete, or needs_decision");
  }
  const ready = lines.some((line) => line.trim() === "SCRAT_READY");
  const grades = lines.filter((line) => line.trim().startsWith("SCRAT_GRADE:"));
  const grade = grades.length ? prGrades.find((value) => grades[0].trim() === `SCRAT_GRADE: ${value}`) : undefined;
  if (grades.length > 1 || (grades.length && !grade)) throw new Error("Pi must return one valid SCRAT_GRADE: S, A, B, C, D, or F");
  const text = lines.filter((line) => line.trim() !== "SCRAT_READY" && !line.trim().startsWith("SCRAT_GRADE:")).join("\n").trim();
  if (!text) throw new Error("Pi returned no report");
  return { text, ready, paths, outcome, grade };
}
