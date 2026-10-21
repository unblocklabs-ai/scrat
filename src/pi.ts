import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createAgentSession, DefaultResourceLoader, getAgentDir, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { Logger } from "pino";
import { config, type ThinkingLevel } from "./config.ts";
import { db } from "./db.ts";
import { botName, withBotName } from "./identity.ts";
import { getRun, updateRun } from "./run-history.ts";
import type { Run } from "./schema.ts";
import { InterruptedError, parseResult, ResultFormatError, type Reviewer } from "./results.ts";
import { git } from "./git.ts";
import type { ToolName } from "./manifests.ts";
import { createAgentTools } from "./tools.ts";
import { canonicalReviewPaths } from "./review-paths.ts";
import { redactSecrets } from "./errors.ts";
import { dropModelRuntime, sharedModelRuntime } from "./model-runtime.ts";

const maxFormatCorrections = 2;

function correctionMessage(error: string, requireGrade: boolean) {
  return `Your previous final answer was not accepted: ${error}.\n\nSend your complete final answer again, with the same content, correctly formatted. It must end with these footer lines, in this order:\nSCRAT_READY (optional, only when ready)\nSCRAT_GRADE: X (${requireGrade ? "required for a complete review; " : "optional; "}X is exactly one of S, A, B, C, D, F, with no plus or minus)\nSCRAT_STATUS: complete, incomplete, or needs_decision (required, and the very last line)`;
}

export function saveReviewer(runId: string, index: number, patch: Partial<Reviewer>) {
  db.transaction((transaction) => {
    const current = getRun(runId, transaction)!;
    updateRun(runId, { reviewers: current.reviewers.map((reviewer, i) => i === index ? { ...reviewer, ...patch } : reviewer) }, transaction);
  });
}

export async function executePi({ run, cwd, context, readOnly, tools, log, sessionFile, environment = {}, reviewerIndex, baseSha, contextDir, revisions = {}, requireGrade = false, followUp, stop }: {
  run: Run;
  cwd: string;
  context: string;
  readOnly: boolean;
  tools: readonly ToolName[];
  log: Logger;
  sessionFile?: string;
  environment?: NodeJS.ProcessEnv;
  reviewerIndex?: number;
  baseSha?: string;
  contextDir?: string;
  revisions?: Record<string, string>;
  requireGrade?: boolean;
  followUp?: string;
  stop?: AbortSignal;
}) {
  const modelRuntime = await sharedModelRuntime();
  const model = modelRuntime.getModel(run.provider, run.model);
  if (!model) {
    dropModelRuntime();
    throw new Error(modelRuntime.getError() ?? `Configure a Pi model for ${run.provider}/${run.model}`);
  }
  const thinkingLevel = run.thinkingLevel as ThinkingLevel;
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir: getAgentDir(), settingsManager, noExtensions: true, noSkills: true,
    appendSystemPromptOverride: (base) => [...base,
      `${botName} handles Git commits, pushes, GitHub comments, labels, and PR creation. Do not publish or commit changes yourself.`,
      "Use dependency implementations from this workspace and its lockfile. Another checkout or a globally cached version is not evidence for this revision.",
      ...readOnly ? [] : [`Keep working notes in ${resolve(cwd, ".scrat/notes.md")} (Git-ignored, never committed or published): the plan, decisions and why, findings, checks run and their results, and what remains. Update it at each milestone, keep it short, and read it first, if it exists, when resuming or after context compaction.`,
        `Your final response is published as written after ${botName} validates, commits and pushes your changes; do not say the changes are uncommitted.`],
      "End your final Markdown response with exactly one line: SCRAT_STATUS: complete, SCRAT_STATUS: incomplete, or SCRAT_STATUS: needs_decision. Complete means the assigned work is finished, not merely that this session ended. For reviews, a complete assessment may contain defects or find the issue unready; use incomplete only if the assessment itself cannot be completed. For implementation, partial work or unresolved blockers are not complete. The harness withholds incomplete implementations from publication. Put an issue's SCRAT_READY marker before the status line, only when warranted.",
    ],
  });
  await resourceLoader.reload();
  const sessionManager = sessionFile
    ? SessionManager.open(sessionFile, resolve("data/pi-sessions"), cwd)
    : SessionManager.create(cwd, resolve("data/pi-sessions"));
  const { names, customTools, paths, gitPaths, basePaths } = await createAgentTools({ cwd, contextDir, tools, baseSha, revisions, environment, log, runId: run.id });
  const { session } = await createAgentSession({
    cwd, modelRuntime, model, thinkingLevel, settingsManager, sessionManager, resourceLoader,
    tools: names, customTools,
  });
  try {
    const sessionDetails = {
      piSessionId: session.sessionId, piSessionFile: session.sessionFile,
      thinkingLevel: session.thinkingLevel,
    };
    if (reviewerIndex === undefined) updateRun(run.id, sessionDetails);
    else saveReviewer(run.id, reviewerIndex, sessionDetails);
    const brief = (value: unknown) => typeof value === "string" ? redactSecrets(value).slice(0, 200) : undefined;
    const targets = new Map<string, Record<string, unknown>>();
    session.subscribe((event) => {
      if (event.type === "tool_execution_start") {
        const { path, pattern, operation, command } = event.args ?? {};
        targets.set(event.toolCallId, { path: brief(path), pattern: brief(pattern), operation: brief(operation), command: brief(command) });
        log.debug({ event: "pi.tool_started", tool: event.toolName, toolCallId: event.toolCallId });
      }
      if (event.type === "tool_execution_end") {
        const target = targets.get(event.toolCallId);
        targets.delete(event.toolCallId);
        if (event.isError) {
          const text = (event.result?.content ?? []).map((part: { text?: string }) => part.text ?? "").join(" ").split("\n\nReceived arguments:")[0]!;
          const error = redactSecrets(text).replace(/\s+/g, " ").trim();
          log.warn({ event: "pi.tool_failed", tool: event.toolName, toolCallId: event.toolCallId, ...target, error: event.toolName === "bash" ? error.slice(-300) : error.slice(0, 300) });
        }
      }
    });
    const prompt = async (text: string) => {
      const started = performance.now();
      let timedOut = false, drained = false, drainTimer: NodeJS.Timeout | undefined;
      const timer = setTimeout(() => { timedOut = true; void session.abort(); }, config.harness.agentTimeoutSeconds * 1000);
      const onStop = () => { drainTimer = setTimeout(() => { drained = true; void session.abort(); }, config.harness.drainTimeoutSeconds * 1000); };
      if (stop?.aborted) onStop(); else stop?.addEventListener("abort", onStop, { once: true });
      try { await session.prompt(text, { expandPromptTemplates: false }); }
      catch (error) { if (!timedOut && !drained) throw error; }
      finally { clearTimeout(timer); clearTimeout(drainTimer); stop?.removeEventListener("abort", onStop); }
      if (timedOut) throw Object.assign(new Error(`Agent turn exceeded ${config.harness.agentTimeoutSeconds} seconds and was aborted after ${Math.round((performance.now() - started) / 1000)} seconds`), { code: "AGENT_TIMEOUT" });
      if (drained) throw new InterruptedError(`Agent turn was still running ${config.harness.drainTimeoutSeconds} seconds after the worker was told to stop and was aborted`);
    };
    await prompt(followUp ?? `${withBotName(await readFile(run.skill, "utf8"))}\n\n${context}`);
    for (let corrections = 0; ; corrections++) {
      const last = session.messages.findLast((message) => message.role === "assistant");
      if (!last || last.role !== "assistant" || last.stopReason !== "stop") {
        throw new Error(last?.role === "assistant" ? last.errorMessage || `Pi stopped: ${last.stopReason}` : "Pi returned no assistant response");
      }
      try {
        const output = session.getLastAssistantText()?.trim();
        if (!output) throw new ResultFormatError("Pi returned an empty response");
        const result = parseResult(output, [], { requireGrade });
        const tracked = (await git(cwd, ["ls-files", "-z"])).split("\0").filter(Boolean);
        const baseTracked = baseSha && (basePaths.size || gitPaths.size)
          ? (await git(cwd, ["ls-tree", "-r", "--name-only", "-z", baseSha])).split("\0").filter(Boolean) : [];
        return { ...result, paths: [...new Set([
          ...canonicalReviewPaths([...paths], tracked), ...canonicalReviewPaths([...basePaths], baseTracked),
          ...canonicalReviewPaths([...gitPaths], tracked), ...canonicalReviewPaths([...gitPaths], baseTracked),
        ])] };
      } catch (error) {
        if (!(error instanceof ResultFormatError) || corrections >= maxFormatCorrections) throw error;
        log.warn({ event: "pi.format_retry", attempt: corrections + 1, error: error.message });
        await prompt(correctionMessage(error.message, requireGrade));
      }
    }
  } finally {
    session.dispose();
  }
}
