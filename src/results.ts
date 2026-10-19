import type { ErrorDetails } from "./errors.ts";

export type AgentResult = {
  text: string;
  ready: boolean;
  paths: string[];
  outcome: "complete" | "incomplete" | "needs_decision";
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
  const outcome = marker?.replace(/^SCRAT_STATUS: /, "");
  if (outcome !== "complete" && outcome !== "incomplete" && outcome !== "needs_decision") {
    throw new Error("Pi must end its response with SCRAT_STATUS: complete, incomplete, or needs_decision");
  }
  const ready = lines.some((line) => line.trim() === "SCRAT_READY");
  const text = lines.filter((line) => line.trim() !== "SCRAT_READY").join("\n").trim();
  if (!text) throw new Error("Pi returned no report");
  return { text, ready, paths, outcome };
}
