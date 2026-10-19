import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, createBashToolDefinition, DefaultResourceLoader, getAgentDir, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { eq } from "drizzle-orm";
import type { Logger } from "pino";
import { thinkingLevels } from "./config.ts";
import { db } from "./db.ts";
import { runs } from "./schema.ts";

export async function executePi(run: typeof runs.$inferSelect, cwd: string, context: string, readOnly: boolean, log: Logger, sessionFile?: string, environment: NodeJS.ProcessEnv = {}) {
  const modelRuntime = await ModelRuntime.create({ modelsPath: fileURLToPath(new URL("../scrat.config.json", import.meta.url)) });
  const model = modelRuntime.getModel(run.provider, run.model);
  if (!model) throw new Error(modelRuntime.getError() ?? `Configure a Pi model for ${run.provider}/${run.model}`);
  const thinkingLevel = thinkingLevels.find((level) => level === run.thinkingLevel);
  if (!thinkingLevel) throw new Error(`Unknown thinking level: ${run.thinkingLevel}`);
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir: getAgentDir(), settingsManager, noExtensions: true, noSkills: true,
    appendSystemPromptOverride: (base) => [...base, "Scrat handles Git commits, pushes, GitHub comments, labels, and PR creation. Do not publish or commit changes yourself."],
  });
  await resourceLoader.reload();
  const sessionManager = sessionFile
    ? SessionManager.open(sessionFile, resolve("data/pi-sessions"), cwd)
    : SessionManager.create(cwd, resolve("data/pi-sessions"));
  const bash = createBashToolDefinition(cwd, {
    spawnHook: (context) => ({ ...context, env: { ...context.env, ...environment } }),
  });
  const { session } = await createAgentSession({
    cwd, modelRuntime, model, thinkingLevel, settingsManager, sessionManager, resourceLoader,
    tools: readOnly ? ["read", "grep", "find", "ls"] : ["read", "grep", "find", "ls", "bash", "edit", "write"],
    customTools: readOnly ? [] : [{ ...bash, renderCall: undefined, renderResult: undefined }],
  });
  const paths = new Set<string>();
  try {
    db.update(runs).set({
      piSessionId: session.sessionId, piSessionFile: session.sessionFile,
      thinkingLevel: session.thinkingLevel,
    }).where(eq(runs.id, run.id)).run();
    session.subscribe((event) => {
      if (event.type === "tool_execution_start") {
        log.debug({ event: "pi.tool_started", tool: event.toolName, toolCallId: event.toolCallId });
        if (event.toolName === "read" || event.toolName === "grep") {
          const args: unknown = event.args;
          if (args && typeof args === "object") {
            const path = "path" in args && typeof args.path === "string" ? args.path : event.toolName === "grep" ? "." : undefined;
            if (path !== undefined) {
              const local = relative(cwd, resolve(cwd, path));
              if (local !== ".." && !local.startsWith("../")) paths.add(local || ".");
            }
          }
        }
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
    const ready = output.split("\n").some((line) => line.trim() === "SCRAT_READY");
    const text = output.split("\n").filter((line) => line.trim() !== "SCRAT_READY").join("\n").trim();
    return { text, ready, paths: [...paths] };
  } finally {
    session.dispose();
  }
}
