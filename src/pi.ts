import { access, readFile, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { relative, resolve } from "node:path";
import { createAgentSession, createBashToolDefinition, createFindToolDefinition, createGrepToolDefinition, createLsToolDefinition, createReadToolDefinition, detectSupportedImageMimeTypeFromFile, defineTool, DefaultResourceLoader, getAgentDir, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { eq } from "drizzle-orm";
import type { Logger } from "pino";
import { Type } from "typebox";
import { blockedCommand } from "./commands.ts";
import { config, thinkingLevels } from "./config.ts";
import { db } from "./db.ts";
import { runs } from "./schema.ts";
import { parseResult, ResultFormatError, type Reviewer } from "./results.ts";
import { blobSize, git, gitPage } from "./git.ts";
import { createReviewGitTool, defaultBytes, maxBytes, pageText } from "./review-git.ts";
import { canonicalReviewPaths } from "./review-paths.ts";
import { childEnvironment } from "./secrets.ts";
import { dropModelRuntime, sharedModelRuntime } from "./model-runtime.ts";

// A malformed footer is corrected inside the same session instead of failing the run.
const maxFormatCorrections = 2;

function correctionMessage(error: string, requireGrade: boolean) {
  return `Your previous final answer was not accepted: ${error}.\n\nSend your complete final answer again, with the same content, correctly formatted. It must end with these footer lines, in this order:\nSCRAT_READY (optional, only when ready)\nSCRAT_GRADE: X (${requireGrade ? "required for a complete review; " : "optional; "}X is exactly one of S, A, B, C, D, F, with no plus or minus)\nSCRAT_STATUS: complete, incomplete, or needs_decision (required, and the very last line)`;
}

export function saveReviewer(runId: string, index: number, patch: Partial<Reviewer>) {
  db.transaction((transaction) => {
    const current = transaction.select().from(runs).where(eq(runs.id, runId)).get()!;
    transaction.update(runs).set({ reviewers: current.reviewers.map((reviewer, i) => i === index ? { ...reviewer, ...patch } : reviewer) })
      .where(eq(runs.id, runId)).run();
  });
}

export async function executePi({ run, cwd, context, readOnly, log, sessionFile, environment = {}, reviewerIndex, baseSha, contextDir, revisions = {}, requireGrade = false, followUp }: {
  run: typeof runs.$inferSelect;
  cwd: string;
  context: string;
  readOnly: boolean;
  log: Logger;
  sessionFile?: string;
  environment?: NodeJS.ProcessEnv;
  reviewerIndex?: number;
  baseSha?: string;
  contextDir?: string;
  revisions?: Record<string, string>;
  requireGrade?: boolean;
  // Resumes sessionFile with this message instead of starting the skill prompt.
  followUp?: string;
}) {
  const modelRuntime = await sharedModelRuntime();
  const model = modelRuntime.getModel(run.provider, run.model);
  if (!model) {
    dropModelRuntime();
    throw new Error(modelRuntime.getError() ?? `Configure a Pi model for ${run.provider}/${run.model}`);
  }
  const thinkingLevel = thinkingLevels.find((level) => level === run.thinkingLevel);
  if (!thinkingLevel) throw new Error(`Unknown thinking level: ${run.thinkingLevel}`);
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir: getAgentDir(), settingsManager, noExtensions: true, noSkills: true,
    appendSystemPromptOverride: (base) => [...base,
      "Scrat handles Git commits, pushes, GitHub comments, labels, and PR creation. Do not publish or commit changes yourself.",
      "Use dependency implementations from this workspace and its lockfile. Another checkout or a globally cached version is not evidence for this revision.",
      // Notes survive compaction and retries in the retained workspace; Scrat excludes .scrat/ from every commit (git.ts).
      ...readOnly ? [] : [`Keep working notes in ${resolve(cwd, ".scrat/notes.md")} (Git-ignored, never committed or published): the plan, decisions and why, findings, checks run and their results, and what remains. Update it at each milestone, keep it short, and read it first when resuming or after context compaction.`,
        "Your final response is published as written after Scrat validates, commits and pushes your changes; do not say the changes are uncommitted."],
      "End your final Markdown response with exactly one line: SCRAT_STATUS: complete, SCRAT_STATUS: incomplete, or SCRAT_STATUS: needs_decision. Complete means the assigned work is finished, not merely that this session ended. For reviews, a complete assessment may contain defects or find the issue unready; use incomplete only if the assessment itself cannot be completed. For implementation, partial work or unresolved blockers are not complete. The harness withholds incomplete implementations from publication. Put an issue's SCRAT_READY marker before the status line, only when warranted.",
    ],
  });
  await resourceLoader.reload();
  const sessionManager = sessionFile
    ? SessionManager.open(sessionFile, resolve("data/pi-sessions"), cwd)
    : SessionManager.create(cwd, resolve("data/pi-sessions"));
  const bash = createBashToolDefinition(cwd, {
    spawnHook: (context) => ({ ...context, env: { ...childEnvironment(context.env), ...environment } }),
  });
  const blocked = (config.workspace?.blockedCommands ?? []).map((pattern) => new RegExp(pattern));
  const guardedBash: typeof bash = {
    ...bash,
    async execute(...args) {
      const hit = blockedCommand(args[1].command, blocked);
      if (hit) {
        log.warn({ event: "pi.command_blocked", command: hit });
        throw new Error(`\`${hit}\` is a heavy check that Scrat runs itself after you finish and reports back if it fails. Run only targeted checks (for example a single test file), then end your turn when ready.`);
      }
      return bash.execute(...args);
    },
  };
  // File tools stay inside the workspace, including through absolute paths, ~,
  // .. and symlinks committed to the repository under review. The run's own
  // context directory is also readable; it is never part of review scope.
  const roots = [await realpath(cwd), ...contextDir ? [await realpath(contextDir)] : []];
  async function insideWorkspace(path: string) {
    const real = await realpath(path).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return resolve(path);
      throw error;
    });
    if (!roots.some((root) => { const local = relative(root, real); return local !== ".." && !local.startsWith("../"); })) throw new Error(`Path is outside the workspace: ${path}`);
    return real;
  }
  // Search roots mirror Pi's resolution: a leading @ is dropped and ~ means home.
  async function searchRoot(path = ".") {
    const requested = path.startsWith("@") ? path.slice(1) : path;
    if (requested === "~" || requested.startsWith("~/")) throw new Error(`Path is outside the workspace: ${path}`);
    await insideWorkspace(resolve(cwd, requested));
  }
  const sdkGrep = createGrepToolDefinition(cwd);
  const grep: typeof sdkGrep = { ...sdkGrep, async execute(...args) { await searchRoot(args[1].path); return sdkGrep.execute(...args); } };
  const sdkFind = createFindToolDefinition(cwd);
  const find: typeof sdkFind = { ...sdkFind, async execute(...args) { await searchRoot(args[1].path); return sdkFind.execute(...args); } };
  const sdkLs = createLsToolDefinition(cwd);
  const ls: typeof sdkLs = { ...sdkLs, async execute(...args) { await searchRoot(args[1].path); return sdkLs.execute(...args); } };
  const paths = new Set<string>();
  const gitPaths = new Set<string>();
  const basePaths = new Set<string>();
  const sdkRead = createReadToolDefinition(cwd);
  const read: typeof sdkRead = {
    ...sdkRead,
    async execute(...args) {
      // Per-invocation operations observe Pi's resolved path, preserving its
      // Unicode/path expansion, images, truncation and cancellation behavior.
      let absolute: string | undefined;
      const tool = createReadToolDefinition(cwd, { operations: {
        access: async (path) => access(await insideWorkspace(path), constants.R_OK),
        detectImageMimeType: async (path) => detectSupportedImageMimeTypeFromFile(await insideWorkspace(path)),
        readFile: async (path) => { const real = await insideWorkspace(path); absolute = path; return readFile(real); },
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
    parameters: Type.Object({
      path: Type.String(),
      offset: Type.Optional(Type.Integer({ minimum: 0, description: "Byte offset into the file, for paging" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: maxBytes, description: `Maximum bytes to return (default ${defaultBytes})` })),
    }),
    async execute(_id, { path, offset = 0, limit = defaultBytes }) {
      const object = `${baseSha}:${path}`, page = await gitPage(cwd, ["show", object], offset, limit);
      const size = page.more ? await blobSize(cwd, object) : undefined;
      basePaths.add(relative(cwd, resolve(cwd, path)));
      return { content: [{ type: "text", text: pageText(page, offset, size) }], details: { path, baseSha } };
    },
  }) : undefined;
  const gitTool = readOnly ? createReviewGitTool(cwd, revisions, gitPaths) : undefined;
  const { session } = await createAgentSession({
    cwd, modelRuntime, model, thinkingLevel, settingsManager, sessionManager, resourceLoader,
    tools: readOnly ? ["read", "grep", "find", "ls", "git", ...(readBase ? ["read_base"] : [])] : ["read", "grep", "find", "ls", "bash", "edit", "write"],
    customTools: [
      ...[read, grep, find, ls].map((tool) => ({ ...tool, renderCall: undefined, renderResult: undefined })),
      ...(gitTool ? [gitTool, ...(readBase ? [readBase] : [])] : [{ ...guardedBash, renderCall: undefined, renderResult: undefined }]),
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
    await session.prompt(followUp ?? `${await readFile(run.skill, "utf8")}\n\n${context}`, { expandPromptTemplates: false });
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
        await session.prompt(correctionMessage(error.message, requireGrade), { expandPromptTemplates: false });
      }
    }
  } finally {
    session.dispose();
  }
}
