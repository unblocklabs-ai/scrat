import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isContextOverflow, isRetryableAssistantError } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, getAgentDir, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { Logger } from "pino";
import { config } from "./config.ts";
import type { ThinkingLevel } from "./manifests.ts";
import { db } from "./db.ts";
import { botName, withBotName } from "./identity.ts";
import { getRun, updateRun } from "./run-history.ts";
import type { Run } from "./schema.ts";
import { footerRules, InterruptedError, parseResult, ResultFormatError, type Reviewer, storefrontProblem } from "./results.ts";
import { gitList } from "./git.ts";
import type { Manifest, ToolName } from "./manifests.ts";
import { createAgentTools } from "./tools.ts";
import type { BrowserScope } from "./scoped-tools.ts";
import { canonicalReviewPaths } from "./review-paths.ts";
import { redactSecrets, transientInferenceCode } from "./errors.ts";
import { dropModelRuntime, sharedModelRuntime } from "./model-runtime.ts";

const withStorefront = (skill: string, shown: boolean) => skill.replace(/^\{\{#storefront\}\}\n([\s\S]*?)^\{\{\/storefront\}\}\n/gm, (_, body: string) => shown ? body : "");

function correctionMessage(error: string, requireGrade: boolean, storefront: boolean) {
  return `Your previous final answer was not accepted: ${error}.\n\nSend your complete final answer again, with the same content, correctly formatted. It must end with these footer lines, in this order:\n${footerRules(requireGrade, storefront)}`;
}

function continuationMessage(requireGrade: boolean, storefront: boolean) {
  return `Your assessment was returned incomplete. Finish the remaining inspection, then return the full final assessment. It must end with these footer lines, in this order:\n${footerRules(requireGrade, storefront)}`;
}

export function saveReviewer(runId: string, index: number, patch: Partial<Reviewer>) {
  db.transaction((transaction) => {
    const current = getRun(runId, transaction)!;
    updateRun(runId, { reviewers: current.reviewers.map((reviewer, i) => i === index ? { ...reviewer, ...patch } : reviewer) }, transaction);
  });
}

export type PiOptions = {
  run: Run; cwd: string; tools: readonly ToolName[]; scoped: Pick<Manifest, "mode" | "http"> & { browser?: BrowserScope };
  storefront?: boolean; contextDir?: string; revisions?: Record<string, string>; baseSha?: string;
  environment?: NodeJS.ProcessEnv; log: Logger; stop?: AbortSignal;
};

export async function executePi(options: PiOptions, { context, sessionFile, reviewerIndex, onSession, requireGrade = false, followUp }: {
  context: string;
  sessionFile?: string;
  reviewerIndex?: number;
  onSession?: (details: Pick<Reviewer, "piSessionId" | "piSessionFile" | "thinkingLevel">) => void;
  requireGrade?: boolean;
  followUp?: string;
}) {
  const { run, cwd, tools, scoped, storefront = false, baseSha, log, stop } = options;
  const readOnly = scoped.mode === "review";
  const modelRuntime = await sharedModelRuntime();
  const model = modelRuntime.getModel(run.provider, run.model);
  if (!model) {
    dropModelRuntime();
    throw new Error(modelRuntime.getError() ?? `Configure a Pi model for ${run.provider}/${run.model}`);
  }
  const thinkingLevel = run.thinkingLevel as ThinkingLevel;
  const { names, customTools, paths, gitPaths, basePaths, close } = await createAgentTools(options, reviewerIndex);
  const browsing = names.includes("browser"), graded = storefront && requireGrade;
  const settingsManager = SettingsManager.inMemory({ retry: config.harness.agentRetry });
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir: getAgentDir(), settingsManager, noExtensions: true, noSkills: true,
    appendSystemPromptOverride: (base) => [...base,
      `${botName} handles Git commits, pushes, GitHub comments, labels, and PR creation. Do not publish or commit changes yourself.`,
      "Use dependency implementations from this workspace and its lockfile. Another checkout or a globally cached version is not evidence for this revision.",
      ...readOnly ? [] : [`Keep working notes in ${resolve(cwd, ".scrat/notes.md")} (Git-ignored, never committed or published): the plan, decisions and why, findings, checks run and their results, and what remains. Update it at each milestone, keep it short, and read it first, if it exists, when resuming or after context compaction.`,
        `Your final response is published as written after ${botName} validates, commits and pushes your changes; do not mention ${botName}, its validation or the commit state.`,
        "Do not add workarounds for this workspace's environment (browser flags, paths, sandbox settings) to the repository; if a check cannot run here, say so.",
        "Test bar: tests earn their place; each one slows every later build and change, so a change adds none by default. Add one only when you can name the behavior or contract it protects, the credible regression that would make it fail and why existing coverage misses that failure, and it needs no production seam (export, flag, wrapper, hook) that only tests use. One test at the boundary that owns the contract covers it: extend an existing case or fixture before adding a file, and never replay the scenario at other layers (unit, repository, component, end-to-end). A regression test must demonstrably fail on the pre-fix code for the intended reason. When your change intentionally alters behavior, update or delete the tests coupled to the old behavior or implementation instead of working around them.",
        "Leave your changes uncommitted in the workspace.",
        `Do not run full lint, type-check, verify, build or e2e suites as routine checks; ${botName} validates after you finish and sends failures back into this session. When the task itself needs a full run (a benchmark or measurement, or reproducing a failure only the full suite shows), run it in the foreground; ${botName} queues it for a heavy-check slot, so it may wait. Never background heavy commands (\`&\`, \`nohup\`). Targeted checks are always fine. End your turn when the change is ready.`,
        "Do not assume a database, browser or installed dependencies are present. Do not obtain production secrets or use shared databases to fill environment gaps.",
        `When \`database\` is supplied, ${botName} owns a fresh PostgreSQL container for this run. Its \`environment\` values are already injected into bash commands; use this run's values, not URLs from earlier session history. ${botName} runs configured preparation and migrations before inference and again after your changes, followed by configured validation. Retained failed work may need repair first: when \`database.schemaPrepared\` is false, finish any merge or repair the failed proposal, then run the supplied prepare/migration commands before database-dependent checks. Add new migrations for schema changes rather than rewriting applied history. Do not remove or replace the run's container or connect to a shared database.`],
      ...readOnly ? [`This session is read-only. Use the available read/search/git${browsing ? " and browser" : ""} tools; do not modify files, implement a fix, or claim to have run shell commands, tests${browsing ? " or live integrations; report only the browser checks you performed" : ", browser checks or live integrations"}.`] : [],
      "Tool rules:",
      ...tools.includes("git") ? [
        "- git `show` needs both `path` and `revision`; `log` takes `revision`; `diff` and `diff_stat` need both `from` and `to`. `head`, `base` and `main` are accepted; there are no defaults for `show` or `diff`.",
        "- A revision is a 7-40 char lowercase hex commit SHA or a named one (head, base, main, plus previousMain and previousHead when the input has `previous`). No `^`/`~` suffixes.",
      ] : [],
      "- Never repeat a failed call unchanged; read the error, change the argument, or switch tools.",
      `- Before reading a path you have not seen listed, list it first (\`ls\`, \`find\`${readOnly ? ", or \`diffPaths\`" : ""}). Do not guess repo layouts or config names.`,
      ...readOnly && (tools.includes("read_base") && baseSha || tools.includes("git")) ? [`- A path the PR deletes or renames is missing from the head checkout; read it with ${tools.includes("read_base") && baseSha ? "`read_base`" : "`git show` with revision=base"}${tools.includes("read_base") && baseSha && tools.includes("git") ? " if you have it, otherwise `git show` with revision=base" : ""}.`] : [],
      "- Look inside `node_modules/<pkg>` only after listing it or reading its `package.json` `main`/`exports`.",
      ...readOnly ? ["- Reviews have no shell and no `bash`."] : [],
      "- `grep` is Rust regex: no lookahead or backreferences; set `literal: true` for exact text.",
      "End your final Markdown response with exactly one line: SCRAT_STATUS: complete, SCRAT_STATUS: incomplete, or SCRAT_STATUS: needs_decision. Complete means the assigned work is finished, not merely that this session ended. For reviews, a complete assessment may contain defects or find the issue unready; use incomplete only if the assessment itself cannot be completed. For implementation, partial work or unresolved blockers are not complete. The harness withholds incomplete implementations from publication. Put an issue's SCRAT_READY marker before the status line, only when warranted.",
    ],
  });
  await resourceLoader.reload();
  const sessionDir = resolve("data/pi-sessions");
  const sessionManager = sessionFile
    ? SessionManager.open(sessionFile, sessionDir, cwd)
    : SessionManager.create(cwd, sessionDir);
  const { session } = await createAgentSession({
    cwd, modelRuntime, model, thinkingLevel, settingsManager, sessionManager, resourceLoader,
    tools: names, customTools,
  });
  try {
    const sessionDetails = {
      piSessionId: session.sessionId, piSessionFile: session.sessionFile,
      thinkingLevel: session.thinkingLevel,
    };
    if (onSession) onSession(sessionDetails);
    else if (reviewerIndex === undefined) updateRun(run.id, sessionDetails);
    else saveReviewer(run.id, reviewerIndex, sessionDetails);
    const brief = (value: unknown) => typeof value === "string" ? redactSecrets(value).slice(0, config.harness.logTargetChars) : undefined;
    const targets = new Map<string, Record<string, unknown>>();
    session.subscribe((event) => {
      if (event.type === "tool_execution_start") {
        const { path, pattern, operation, command, revision, from, to } = event.args ?? {};
        targets.set(event.toolCallId, { path: brief(path), pattern: brief(pattern), operation: brief(operation), command: brief(command), revision: brief(revision), from: brief(from), to: brief(to) });
        log.debug({ event: "pi.tool_started", tool: event.toolName, toolCallId: event.toolCallId });
      }
      if (event.type === "tool_execution_end") {
        const target = targets.get(event.toolCallId);
        targets.delete(event.toolCallId);
        if (event.isError) {
          const text = (event.result?.content ?? []).map((part: { text?: string }) => part.text ?? "").join(" ").split("\n\nReceived arguments:")[0]!;
          const error = redactSecrets(text).replace(/\s+/g, " ").trim();
          log.warn({ event: "pi.tool_failed", tool: event.toolName, toolCallId: event.toolCallId, ...target, err: event.toolName === "bash" ? error.slice(-config.harness.logErrorChars) : error.slice(0, config.harness.logErrorChars) });
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
    await prompt(followUp ?? `${withStorefront(withBotName(await readFile(run.skill, "utf8")), storefront)}\n\n${context}`);
    let continuations = 0, regressionReported = false;
    for (let corrections = 0; ; corrections++) {
      const last = session.messages.findLast((message) => message.role === "assistant");
      if (!last || last.role !== "assistant" || last.stopReason !== "stop") {
        if (last?.role !== "assistant") throw new Error("Pi returned no assistant response");
        const transient = !isContextOverflow(last, model.contextWindow) && isRetryableAssistantError(last);
        throw Object.assign(new Error(last.errorMessage || `Pi stopped: ${last.stopReason}`), transient ? { code: transientInferenceCode } : {});
      }
      try {
        const output = session.getLastAssistantText()?.trim();
        if (!output) throw new ResultFormatError("Pi returned an empty response");
        const result = parseResult(output, [], { requireGrade });
        const problem = graded && result.outcome === "complete" ? storefrontProblem(result, config.storefront.limits.regressionMaxGrade, regressionReported) : undefined;
        regressionReported ||= result.storefront === "regression";
        if (problem) throw new ResultFormatError(problem);
        if (readOnly && result.outcome === "incomplete" && continuations < config.harness.corrections.incomplete) {
          continuations++;
          log.warn({ event: "pi.incomplete_continue", attempt: continuations });
          await prompt(continuationMessage(requireGrade, graded));
          corrections--;
          continue;
        }
        const tracked = await gitList(cwd, ["ls-files", "-z"]);
        const baseTracked = baseSha && (basePaths.size || gitPaths.size)
          ? await gitList(cwd, ["ls-tree", "-r", "--name-only", "-z", baseSha]) : [];
        return { ...result, paths: [...new Set([
          ...canonicalReviewPaths([...paths], tracked), ...canonicalReviewPaths([...basePaths], baseTracked),
          ...canonicalReviewPaths([...gitPaths], tracked), ...canonicalReviewPaths([...gitPaths], baseTracked),
        ])] };
      } catch (error) {
        if (!(error instanceof ResultFormatError) || corrections >= config.harness.corrections.format) throw error;
        log.warn({ event: "pi.format_retry", attempt: corrections + 1, err: error });
        await prompt(correctionMessage(error.message, requireGrade, graded));
      }
    }
  } finally {
    try { session.dispose(); } finally { await close(); }
  }
}
