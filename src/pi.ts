import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, createBashToolDefinition, createReadToolDefinition, detectSupportedImageMimeTypeFromFile, defineTool, DefaultResourceLoader, getAgentDir, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { eq } from "drizzle-orm";
import type { Logger } from "pino";
import { Type } from "typebox";
import { thinkingLevels } from "./config.ts";
import { db } from "./db.ts";
import { runs } from "./schema.ts";
import { parseResult, type Reviewer } from "./results.ts";
import { git } from "./git.ts";
import { canonicalReviewPaths, observedReviewPaths } from "./review-paths.ts";

export function saveReviewer(runId: string, index: number, patch: Partial<Reviewer>) {
  db.transaction((transaction) => {
    const current = transaction.select().from(runs).where(eq(runs.id, runId)).get()!;
    transaction.update(runs).set({ reviewers: current.reviewers.map((reviewer, i) => i === index ? { ...reviewer, ...patch } : reviewer) })
      .where(eq(runs.id, runId)).run();
  });
}

export async function executePi({ run, cwd, context, readOnly, log, sessionFile, environment = {}, reviewerIndex, baseSha }: {
  run: typeof runs.$inferSelect;
  cwd: string;
  context: string;
  readOnly: boolean;
  log: Logger;
  sessionFile?: string;
  environment?: NodeJS.ProcessEnv;
  reviewerIndex?: number;
  baseSha?: string;
}) {
  const modelRuntime = await ModelRuntime.create({
    modelsPath: fileURLToPath(new URL("../scrat.config.json", import.meta.url)),
    modelsStorePath: resolve("data/pi-models-store.json"),
  });
  const model = modelRuntime.getModel(run.provider, run.model);
  if (!model) throw new Error(modelRuntime.getError() ?? `Configure a Pi model for ${run.provider}/${run.model}`);
  const thinkingLevel = thinkingLevels.find((level) => level === run.thinkingLevel);
  if (!thinkingLevel) throw new Error(`Unknown thinking level: ${run.thinkingLevel}`);
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir: getAgentDir(), settingsManager, noExtensions: true, noSkills: true,
    appendSystemPromptOverride: (base) => [...base,
      "Scrat handles Git commits, pushes, GitHub comments, labels, and PR creation. Do not publish or commit changes yourself.",
      "Use dependency implementations from this workspace and its lockfile. Another checkout or a globally cached version is not evidence for this revision.",
      "End your final Markdown response with exactly one line: SCRAT_STATUS: complete, SCRAT_STATUS: incomplete, or SCRAT_STATUS: needs_decision. Complete means the assigned work is finished, not merely that this session ended. For reviews, a complete assessment may contain defects or find the issue unready; use incomplete only if the assessment itself cannot be completed. For implementation, partial work or unresolved blockers are not complete. The harness withholds incomplete implementations from publication. Put an issue's SCRAT_READY marker before the status line, only when warranted.",
    ],
  });
  await resourceLoader.reload();
  const sessionManager = sessionFile
    ? SessionManager.open(sessionFile, resolve("data/pi-sessions"), cwd)
    : SessionManager.create(cwd, resolve("data/pi-sessions"));
  const bash = createBashToolDefinition(cwd, {
    spawnHook: (context) => ({ ...context, env: { ...context.env, ...environment } }),
  });
  const paths = new Set<string>();
  const basePaths = new Set<string>();
  const sdkRead = createReadToolDefinition(cwd);
  const read: typeof sdkRead = {
    ...sdkRead,
    async execute(...args) {
      // Per-invocation operations observe Pi's resolved path, preserving its
      // Unicode/path expansion, images, truncation and cancellation behavior.
      let absolute: string | undefined;
      const tool = createReadToolDefinition(cwd, { operations: {
        access: (path) => access(path, constants.R_OK),
        detectImageMimeType: detectSupportedImageMimeTypeFromFile,
        readFile: async (path) => { absolute = path; return readFile(path); },
      } });
      const result = await tool.execute(...args);
      if (absolute) {
        const local = relative(cwd, absolute);
        if (local !== ".." && !local.startsWith("../")) paths.add(local || ".");
      }
      return result;
    },
  };
  const readBase = readOnly && baseSha ? defineTool({
    name: "read_base",
    label: "Read merge-base file",
    description: `Read a repository-relative text file from the immutable PR merge-base ${baseSha}. Use read for the current PR head.`,
    parameters: Type.Object({ path: Type.String() }),
    async execute(_id, { path }) {
      const text = await git(cwd, ["show", `${baseSha}:${path}`]);
      basePaths.add(relative(cwd, resolve(cwd, path)));
      return { content: [{ type: "text", text }], details: { path, baseSha } };
    },
  }) : undefined;
  const { session } = await createAgentSession({
    cwd, modelRuntime, model, thinkingLevel, settingsManager, sessionManager, resourceLoader,
    tools: readOnly ? ["read", "grep", "find", "ls", ...(readBase ? ["read_base"] : [])] : ["read", "grep", "find", "ls", "bash", "edit", "write"],
    customTools: [
      { ...read, renderCall: undefined, renderResult: undefined },
      ...(readOnly ? (readBase ? [readBase] : []) : [{ ...bash, renderCall: undefined, renderResult: undefined }]),
    ],
  });
  try {
    const sessionDetails = {
      piSessionId: session.sessionId, piSessionFile: session.sessionFile,
      thinkingLevel: session.thinkingLevel,
    };
    if (reviewerIndex === undefined) db.update(runs).set(sessionDetails).where(eq(runs.id, run.id)).run();
    else saveReviewer(run.id, reviewerIndex, sessionDetails);
    session.subscribe((event) => {
      if (event.type === "tool_execution_start") {
        log.debug({ event: "pi.tool_started", tool: event.toolName, toolCallId: event.toolCallId });
      }
      if (event.type === "tool_execution_end" && event.isError) {
        log.warn({ event: "pi.tool_failed", tool: event.toolName, toolCallId: event.toolCallId });
      }
    });
    const skill = await readFile(run.skill, "utf8");
    await session.prompt(`${skill}\n\n${context}`, { expandPromptTemplates: false });
    const last = session.messages.findLast((message) => message.role === "assistant");
    if (!last || last.role !== "assistant" || last.stopReason !== "stop") {
      throw new Error(last?.role === "assistant" ? last.errorMessage || `Pi stopped: ${last.stopReason}` : "Pi returned no assistant response");
    }
    const output = session.getLastAssistantText()?.trim();
    if (!output) throw new Error("Pi returned an empty response");
    const tracked = (await git(cwd, ["ls-files", "-z"])).split("\0").filter(Boolean);
    const baseTracked = baseSha && basePaths.size
      ? (await git(cwd, ["ls-tree", "-r", "--name-only", "-z", baseSha])).split("\0").filter(Boolean) : [];
    return parseResult(output, [...new Set([
      ...observedReviewPaths([...paths], tracked), ...canonicalReviewPaths([...basePaths], baseTracked),
    ])]);
  } finally {
    session.dispose();
  }
}
