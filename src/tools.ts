import { createHash, randomUUID } from "node:crypto";
import { access, lstat, mkdir, open, readFile, realpath, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { createBashToolDefinition, createEditToolDefinition, createFindToolDefinition, createGrepToolDefinition, createLsToolDefinition, createReadToolDefinition, createWriteToolDefinition, defineTool, detectSupportedImageMimeTypeFromFile } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { backgroundsWork, createSlots, heavyCommand, withValidationSlot } from "./commands.ts";
import { config } from "./config.ts";
import { copyRedactedFile, distillCommandOutput, readHeadAndTail, stripAnsi, trimUtf8End } from "./d1.ts";
import { createGrepTool } from "./grep.ts";
import type { ToolName } from "./manifests.ts";
import type { PiOptions } from "./pi.ts";
import { botName } from "./identity.ts";
import { errorCode, ifMissing, redactSecrets } from "./errors.ts";
import { childEnvironment } from "./secrets.ts";
import { blobSize, gitPage } from "./git.ts";
import { GitHubRepository } from "./github.ts";
import { createBrowserTool, createGithubSearchTool, createHttpTool } from "./scoped-tools.ts";
import { createReviewGitTool, omitGeneratedFromUnifiedDiff, pageText } from "./review-git.ts";
import { sandboxCommand } from "./sandbox.ts";

const browserSlot = createSlots(() => config.storefront.limits.browsers, "storefront.browser_waiting", "storefront.browser_started");

type ScopedToolName = "http" | "browser" | "github_search";

export async function createAgentTools({ run: { id: runId }, cwd, contextDir, tools, scoped, baseSha, revisions = {}, environment = {}, log, stop, getLiveToolCallIds, isNestedToolCall }: PiOptions, reviewerIndex?: number) {
  const workspaceRoot = await realpath(cwd);
  const contextRoot = contextDir ? await realpath(contextDir) : undefined;
  const roots = [workspaceRoot, ...contextRoot ? [contextRoot] : []];
  const sessionTag = `${reviewerIndex === undefined ? "main" : `reviewer-${reviewerIndex + 1}`}-${randomUUID().slice(0, 8)}`;
  function assertInside(real: string, path: string, allowed: string[]) {
    if (!allowed.some((root) => { const local = relative(root, real); return local !== ".." && !local.startsWith("../"); })) throw new Error(`Path is outside the workspace: ${path}`);
    return real;
  }
  async function confine(path: string, allowed: string[]) {
    const real = await ifMissing(realpath(path), resolve(path));
    return assertInside(real, path, allowed);
  }
  async function confineWrite(path: string) {
    const tail: string[] = [];
    let current = resolve(path);
    for (;;) {
      try { return assertInside(join(await realpath(current), ...tail), path, [workspaceRoot]); }
      catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
        if (await lstat(current).then(() => true, () => false)) throw new Error(`Path is outside the workspace: ${path}`);
        const parent = dirname(current);
        if (parent === current) throw error;
        tail.unshift(basename(current));
        current = parent;
      }
    }
  }
  const insideWorkspace = (path: string) => confine(path, roots);
  async function resolveSearchTarget(path = ".") {
    const requested = path.startsWith("@") ? path.slice(1) : path;
    if (requested === "~" || requested.startsWith("~/")) throw new Error(`Path is outside the workspace: ${path}`);
    return insideWorkspace(resolve(cwd, requested));
  }
  const searchRoot = async (path = ".") => { await resolveSearchTarget(path); };
  const paths = new Set<string>();
  const gitPaths = new Set<string>();
  const basePaths = new Set<string>();

  const sdkBash = createBashToolDefinition(cwd, {
    spawnHook: (context) => {
      const command = sandboxCommand(cwd, "/bin/bash", ["-c", context.command], { ...childEnvironment(context.env), ...environment }, contextDir ? [contextDir] : []);
      const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
      return config.workspace.sandbox
        ? { ...context, command: [command.file, ...command.args].map(quote).join(" "), env: command.env }
        : { ...context, env: command.env };
    },
  });
  const heavy = config.workspace.heavyCommands.map((pattern) => new RegExp(pattern));
  const generatedDiffPatterns = config.tools.git.generatedPaths.map((pattern) => new RegExp(pattern));
  let bashDumps = 0;
  const runSdkBash = async (toolCallId: string, params: { command: string; timeout?: number }, signal: AbortSignal | undefined, onUpdate: Parameters<typeof sdkBash.execute>[3], ctx: Parameters<typeof sdkBash.execute>[4]) => {
    const hit = heavyCommand(params.command, heavy);
    if (!hit) return sdkBash.execute(toolCallId, params, signal, onUpdate, ctx);
    const segment = redactSecrets(hit).slice(0, config.harness.logTargetChars);
    if (backgroundsWork(params.command)) {
      log.warn({ event: "pi.command_blocked", command: segment });
      throw new Error(`This command line runs a background job (a lone &, nohup, setsid or disown) and includes the heavy check \`${segment}\`. Run heavy checks in the foreground, in a command without background jobs, so ${botName} can queue them behind other heavy jobs.`);
    }
    const bounded = { ...params, timeout: Math.min(params.timeout ?? config.harness.commandTimeoutSeconds, config.harness.commandTimeoutSeconds) };
    const queuedAt = performance.now();
    return withValidationSlot(() => {
      log.info({ event: "pi.heavy_command", command: segment, waitedMs: Math.round(performance.now() - queuedAt) });
      return sdkBash.execute(toolCallId, bounded, signal, onUpdate, ctx);
    }, { runId }, signal);
  };
  const bashParameters = Type.Object({
    command: Type.String({ description: "Shell command to execute" }),
    timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
    goal: Type.Optional(Type.String({ description: "Optional short note of what you are checking (used to focus d1 output filtering when output is large)" })),
    raw: Type.Optional(Type.Boolean({ description: "Set true to bypass generated-diff and d1 output filtering and return raw output" })),
  });
  const bash = defineTool({
    name: sdkBash.name,
    label: sdkBash.label,
    promptSnippet: sdkBash.promptSnippet,
    promptGuidelines: sdkBash.promptGuidelines,
    outputSchema: sdkBash.outputSchema,
    constrainedSampling: sdkBash.constrainedSampling,
    description: config.d1.enabled
      ? `${sdkBash.description} Large non-read command outputs (> ${config.d1.bash.minChars} chars) are distilled via d1 into verbatim spans and large generated/lockfile git diffs (> ${config.tools.git.generatedDiffBytes} bytes) are summarized deterministically with the full log saved to a readable file; pass \`goal\` to focus extraction or \`raw: true\` to bypass filtering.`
      : `${sdkBash.description} Large generated/lockfile git diffs (> ${config.tools.git.generatedDiffBytes} bytes) are summarized deterministically with the full diff saved to a readable file; pass \`raw: true\` to bypass filtering.`,
    parameters: bashParameters,
    async execute(toolCallId, { command, timeout, goal, raw }, signal, onUpdate, ctx) {
      const result = await runSdkBash(toolCallId, { command, timeout }, signal, onUpdate, ctx);
      if (raw) return result;
      const details = result.details as { fullOutputPath?: string } | undefined;
      const structured = (result as { structuredContent?: { exit_code?: number; full_output_path?: string; output?: string; truncated?: boolean; wall_time_seconds?: number } }).structuredContent;
      const isError = (result as { isError?: boolean }).isError;
      const textParts = (result.content ?? []).filter((part): part is { type: "text"; text: string } => part.type === "text");
      const rawInline = textParts.map((part) => part.text).join("\n");
      const exitMatch = isError ? /\n\nCommand exited with code (\d+)$/.exec(rawInline) : null;
      const exitCode = structured?.exit_code ?? (exitMatch ? Number(exitMatch[1]) : undefined);
      const inlineBody = exitMatch ? rawInline.slice(0, exitMatch.index) : rawInline;
      const formatBashResult = (text: string, artifactPath?: string) => {
        const finalText = isError && exitCode !== undefined ? `${text}\n\nCommand exited with code ${exitCode}` : text;
        const structuredRest = structured ? (() => { const { full_output_path: _drop, ...rest } = structured; return rest; })() : undefined;
        return {
          ...result,
          content: [{ type: "text" as const, text: finalText }],
          details: artifactPath ? { fullOutputPath: artifactPath } : undefined,
          ...(structuredRest ? { structuredContent: { ...structuredRest, output: finalText, truncated: true, ...(artifactPath ? { full_output_path: artifactPath } : {}) } } : {}),
        };
      };
      // Only guard standalone git diff commands so chained commands like `git diff && pnpm test` never lose later output.
      const isStandaloneGitDiff = (cmd: string) => {
        const trimmed = cmd.trim();
        if (!trimmed || /[\n;&|`<>$]/.test(trimmed)) return false;
        const tokens = trimmed.split(/\s+/);
        let idx = 0;
        while (idx < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[idx]!)) idx++;
        if (idx >= tokens.length || tokens[idx]!.split("/").at(-1) !== "git") return false;
        idx++;
        const valueFlags = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);
        while (idx < tokens.length && tokens[idx]!.startsWith("-")) {
          const flag = tokens[idx]!;
          idx += valueFlags.has(flag) ? 2 : 1;
        }
        return tokens[idx] === "diff";
      };
      const maybeGitDiff = generatedDiffPatterns.length > 0 && isStandaloneGitDiff(command);
      if (!maybeGitDiff && !config.d1.enabled) return result;
      const diskFull = details?.fullOutputPath
        ? await readHeadAndTail(details.fullOutputPath, Math.min(config.harness.maxOutputBytes, config.harness.distillReadBytes))
        : undefined;
      const sourceText = diskFull?.text ?? inlineBody;
      // Guard bash `git diff` outputs in change mode against lockfile/generated bloat deterministically.
      if (maybeGitDiff) {
        const diffSource = stripAnsi(redactSecrets(sourceText));
        if (diffSource.includes("diff --git ")) {
          const artifactToken = "\0SCRAT_DIFF_ARTIFACT\0";
          const guarded = omitGeneratedFromUnifiedDiff(diffSource, generatedDiffPatterns, config.tools.git.generatedDiffBytes, artifactToken);
          if (guarded.omitted.length) {
            let savedPath: string | undefined;
            let partialArtifact = Boolean(diskFull?.truncated);
            if (contextRoot) {
              const dest = join(contextRoot, `bash-${sessionTag}-${++bashDumps}.log`);
              if (diskFull?.truncated && details?.fullOutputPath) {
                const copied = await copyRedactedFile(details.fullOutputPath, dest, config.harness.maxOutputBytes);
                if (copied) { savedPath = copied.path; partialArtifact = copied.truncated; }
              } else {
                savedPath = await writeFile(dest, diffSource, { encoding: "utf8", mode: 0o600 }).then(() => dest, () => undefined);
                if (savedPath) partialArtifact = false;
              }
            }
            const artifactNote = savedPath
              ? `; ${partialArtifact ? "partial" : "full"} diff saved to ${savedPath} (use read to inspect)`
              : "";
            const truncationWarning = diskFull?.truncated
              ? `[note: raw diff exceeded ${config.harness.distillReadBytes}-byte inspection cap before generated-file filtering; middle output may have been omitted${artifactNote}.]\n\n`
              : "";
            const assembled = `${truncationWarning}${guarded.text.replaceAll(artifactToken, artifactNote)}`;
            const cap = config.tools.readBytes.max;
            let outText = assembled;
            if (Buffer.byteLength(assembled, "utf8") > cap) {
              const suffix = `\n\n[truncated after omitting ${guarded.omitted.length} generated/lockfile diff(s)${artifactNote}]`;
              const headBudget = Math.max(0, cap - Buffer.byteLength(suffix, "utf8"));
              const head = trimUtf8End(Buffer.from(assembled, "utf8").subarray(0, headBudget)).toString("utf8");
              outText = `${head}${suffix}`;
            }
            log.info({ event: "bash.generated_diff_omitted", omitted: guarded.omitted.length, rawChars: diffSource.length, outChars: outText.length, truncatedInput: Boolean(diskFull?.truncated) });
            return formatBashResult(outText, savedPath);
          }
        }
      }
      if (!config.d1.enabled) return result;
      const candidatePath = contextRoot && sourceText.length > config.d1.bash.minChars
        ? join(contextRoot, `bash-${sessionTag}-${++bashDumps}.log`)
        : undefined;
      const distilled = await distillCommandOutput({
        rawOutput: sourceText, command, goal,
        artifactPath: candidatePath,
        sourceArtifactPath: diskFull?.truncated ? details?.fullOutputPath : undefined,
        existingArtifactPath: details?.fullOutputPath,
        partialSource: Boolean(diskFull?.truncated),
        minChars: config.d1.bash.minChars, maxChars: config.d1.bash.maxOutputChars,
        signal, log,
      });
      if (!distilled.filtered) return result;
      return formatBashResult(distilled.text, distilled.artifactPath);
    },
  });
  const sdkGrep = createGrepToolDefinition(cwd);
  const legacyGrep: typeof sdkGrep = { ...sdkGrep, async execute(...args) { await searchRoot(args[1].path); return sdkGrep.execute(...args); } };
  const grepPolicy = scoped.mode === "review" ? config.tools.grep.review : config.tools.grep.change;
  const grep = grepPolicy === "deterministic"
    ? createGrepTool({ workspaceRoot, contextRoot, sessionTag, searchRoot, resolveTarget: resolveSearchTarget, sdkFallback: legacyGrep, log })
    : legacyGrep;
  const sdkFind = createFindToolDefinition(cwd);
  const find: typeof sdkFind = { ...sdkFind, async execute(...args) { await searchRoot(args[1].path); return sdkFind.execute(...args); } };
  const sdkLs = createLsToolDefinition(cwd);
  const ls: typeof sdkLs = { ...sdkLs, async execute(...args) { await searchRoot(args[1].path); return sdkLs.execute(...args); } };
  const sdkRead = createReadToolDefinition(cwd);
  const seenReads = new Map<string, { hash: string; toolCallId: string; bytes: number }>();
  const read: typeof sdkRead = {
    ...sdkRead,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      let absolute: string | undefined;
      let resolvedReal: string | undefined;
      const tool = createReadToolDefinition(cwd, { operations: {
        access: async (path) => access(await insideWorkspace(path), constants.R_OK),
        detectImageMimeType: async (path) => detectSupportedImageMimeTypeFromFile(await insideWorkspace(path)),
        readFile: async (path) => { const real = await insideWorkspace(path); absolute = path; resolvedReal = real; return readFile(real); },
        createReadStream: async function* (path) {
          const real = await insideWorkspace(path);
          absolute = path;
          resolvedReal = real;
          const handle = await open(real, "r");
          try {
            const stats = await handle.stat();
            const end = stats.isFile() && stats.size > 0 ? stats.size - 1 : undefined;
            yield* handle.createReadStream({ end, autoClose: false });
          } finally {
            await handle.close();
          }
        },
      } });
      const result = await tool.execute(toolCallId, params, signal, onUpdate, ctx);
      if (absolute) {
        const local = relative(cwd, absolute);
        if (local !== ".." && !local.startsWith("../")) paths.add(local || ".");
      }
      const minDedup = config.tools.readDedupMinBytes;
      const nestedCall = Boolean(isNestedToolCall?.(toolCallId));
      if (!nestedCall && minDedup > 0 && resolvedReal && getLiveToolCallIds && result.content.length && result.content.every((part): part is { type: "text"; text: string } => part.type === "text")) {
        const textOut = result.content.map((part) => part.text).join("\n");
        const bytes = Buffer.byteLength(textOut, "utf8");
        if (bytes >= minDedup) {
          const hash = createHash("sha256").update(textOut).digest("hex");
          const normOffset = params.offset ?? 1;
          const key = `${resolvedReal}\0${normOffset}\0${params.limit ?? ""}`;
          const prev = seenReads.get(key);
          if (prev && prev.hash === hash && getLiveToolCallIds().has(prev.toolCallId)) {
            const range = params.offset !== undefined || params.limit !== undefined
              ? ` (offset=${normOffset}${params.limit !== undefined ? `, limit=${params.limit}` : ""})`
              : "";
            const stub = `[unchanged: identical ${bytes}-byte read of ${params.path}${range} is already in this session context (sha256:${hash.slice(0, 12)})]`;
            return {
              ...result,
              content: [{ type: "text" as const, text: stub }],
              ...("structuredContent" in result ? { structuredContent: stub } : {}),
            };
          }
          seenReads.set(key, { hash, toolCallId, bytes });
        }
      }
      return result;
    },
  };
  const edit = createEditToolDefinition(cwd, { operations: {
    access: async (path) => access(await confineWrite(path), constants.R_OK | constants.W_OK),
    readFile: async (path) => readFile(await confineWrite(path)),
    writeFile: async (path, content) => writeFile(await confineWrite(path), content, "utf8"),
  } });
  const write = createWriteToolDefinition(cwd, { operations: {
    mkdir: async (dir) => { await mkdir(await confineWrite(dir), { recursive: true }); },
    writeFile: async (path, content) => writeFile(await confineWrite(path), content, "utf8"),
  } });
  const readBase = defineTool({
    name: "read_base",
    label: "Read merge-base file",
    description: `Read a repository-relative text file from the immutable PR merge-base ${baseSha}. Use read for the current PR head.`,
    parameters: Type.Object({
      path: Type.String(),
      offset: Type.Optional(Type.Integer({ minimum: 0, description: "Byte offset into the file, for paging" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: config.tools.readBytes.max, description: `Maximum bytes to return (default ${config.tools.readBytes.default})` })),
    }),
    async execute(_id, { path, offset = 0, limit = config.tools.readBytes.default }) {
      const object = `${baseSha}:${path}`, page = await gitPage(cwd, ["show", object], offset, limit);
      const size = page.more ? await blobSize(cwd, object) : undefined;
      basePaths.add(relative(cwd, resolve(cwd, path)));
      return { content: [{ type: "text", text: pageText(page, offset, size) }], details: { path, baseSha } };
    },
  });
  const quiet = <T extends object>(tool: T) => ({ ...tool, renderCall: undefined, renderResult: undefined });
  const core = {
    read: quiet(read), grep: quiet(grep), find: quiet(find), ls: quiet(ls), git: createReviewGitTool(cwd, revisions, gitPaths, log),
    read_base: readBase, bash: quiet(bash), edit: quiet(edit), write: quiet(write),
  } satisfies Record<Exclude<ToolName, ScopedToolName>, object>;
  const binding = (name?: string) => name === undefined ? undefined : config.bindings[name];
  const browser = scoped.browser
    ? createBrowserTool({ settings: scoped.browser, binding: binding(scoped.browser.binding), contextDir: contextRoot, runId, sessionTag, log, acquire: () => browserSlot({ runId }, stop), limits: scoped.browser.limits, prefix: reviewerIndex === undefined ? undefined : `reviewer-${reviewerIndex + 1}` }) : undefined;
  const table = {
    ...core,
    ...scoped.http && { http: createHttpTool({ settings: scoped.http, binding: binding(scoped.http.binding)!, runId }) },
    ...browser && { browser: browser.tool },
    ...tools.includes("github_search") && { github_search: createGithubSearchTool(new GitHubRepository(config.github.repository)) },
  };
  const names = tools.filter((name) => (name !== "read_base" || baseSha) && (name !== "browser" || browser));
  return { names, customTools: names.flatMap((name) => { const tool = table[name as keyof typeof table]; return tool ? [tool] : []; }), paths, gitPaths, basePaths, close: async () => { await browser?.close(); } };
}
