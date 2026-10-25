import { access, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { createBashToolDefinition, createEditToolDefinition, createFindToolDefinition, createGrepToolDefinition, createLsToolDefinition, createReadToolDefinition, createWriteToolDefinition, defineTool, detectSupportedImageMimeTypeFromFile } from "@earendil-works/pi-coding-agent";
import type { Logger } from "pino";
import { Type } from "typebox";
import { backgroundsWork, heavyCommand, withValidationSlot } from "./commands.ts";
import { config } from "./config.ts";
import type { Manifest, ToolName } from "./manifests.ts";
import { botName } from "./identity.ts";
import { errorCode, ifMissing, redactSecrets } from "./errors.ts";
import { childEnvironment } from "./secrets.ts";
import { blobSize, gitPage } from "./git.ts";
import { GitHubRepository } from "./github.ts";
import { createBrowserTool, createGithubSearchTool, createHttpTool } from "./scoped-tools.ts";
import { createReviewGitTool, pageText } from "./review-git.ts";
import { sandboxCommand } from "./sandbox.ts";

type ScopedToolName = "http" | "browser" | "github_search";

export async function createAgentTools({ cwd, contextDir, tools, scoped = {}, storefront = false, baseSha, revisions = {}, environment = {}, log, runId }: {
  cwd: string;
  contextDir?: string;
  tools: readonly ToolName[];
  scoped?: Pick<Manifest, "http" | "browser">;
  storefront?: boolean;
  baseSha?: string;
  revisions?: Record<string, string>;
  environment?: NodeJS.ProcessEnv;
  log: Logger;
  runId: string;
}) {
  const workspaceRoot = await realpath(cwd);
  const roots = [workspaceRoot, ...contextDir ? [await realpath(contextDir)] : []];
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
  async function searchRoot(path = ".") {
    const requested = path.startsWith("@") ? path.slice(1) : path;
    if (requested === "~" || requested.startsWith("~/")) throw new Error(`Path is outside the workspace: ${path}`);
    await insideWorkspace(resolve(cwd, requested));
  }
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
  const bash: typeof sdkBash = {
    ...sdkBash,
    async execute(...args) {
      const hit = heavyCommand(args[1].command, heavy);
      if (!hit) return sdkBash.execute(...args);
      const segment = redactSecrets(hit).slice(0, config.harness.logTargetChars);
      if (backgroundsWork(args[1].command)) {
        log.warn({ event: "pi.command_blocked", command: segment });
        throw new Error(`This command line runs a background job (a lone &, nohup, setsid or disown) and includes the heavy check \`${segment}\`. Run heavy checks in the foreground, in a command without background jobs, so ${botName} can queue them behind other heavy jobs.`);
      }
      args[1] = { ...args[1], timeout: Math.min(args[1].timeout ?? config.harness.commandTimeoutSeconds, config.harness.commandTimeoutSeconds) };
      const queuedAt = performance.now();
      return withValidationSlot(() => {
        log.info({ event: "pi.heavy_command", command: segment, waitedMs: Math.round(performance.now() - queuedAt) });
        return sdkBash.execute(...args);
      }, { runId }, args[2]);
    },
  };
  const sdkGrep = createGrepToolDefinition(cwd);
  const grep: typeof sdkGrep = { ...sdkGrep, async execute(...args) { await searchRoot(args[1].path); return sdkGrep.execute(...args); } };
  const sdkFind = createFindToolDefinition(cwd);
  const find: typeof sdkFind = { ...sdkFind, async execute(...args) { await searchRoot(args[1].path); return sdkFind.execute(...args); } };
  const sdkLs = createLsToolDefinition(cwd);
  const ls: typeof sdkLs = { ...sdkLs, async execute(...args) { await searchRoot(args[1].path); return sdkLs.execute(...args); } };
  const sdkRead = createReadToolDefinition(cwd);
  const read: typeof sdkRead = {
    ...sdkRead,
    async execute(...args) {
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
    read: quiet(read), grep: quiet(grep), find: quiet(find), ls: quiet(ls), git: createReviewGitTool(cwd, revisions, gitPaths),
    read_base: readBase, bash: quiet(bash), edit: quiet(edit), write: quiet(write),
  } satisfies Record<Exclude<ToolName, ScopedToolName>, object>;
  const binding = (name?: string) => name === undefined ? undefined : config.bindings[name];
  const { browserSteps, runSeconds } = config.storefront.limits;
  const browser = scoped.browser || (storefront && tools.includes("browser"))
    ? createBrowserTool({ settings: scoped.browser, binding: binding(scoped.browser?.binding), contextDir, runId, log, ...storefront && { limits: { steps: browserSteps, milliseconds: runSeconds * 1000 } } }) : undefined;
  const table = {
    ...core,
    ...scoped.http && { http: createHttpTool({ settings: scoped.http, binding: binding(scoped.http.binding)!, runId }) },
    ...browser && { browser: browser.tool },
    ...tools.includes("github_search") && { github_search: createGithubSearchTool(new GitHubRepository(config.github.repository)) },
  };
  const names = tools.filter((name) => (name !== "read_base" || baseSha) && (name !== "browser" || browser));
  return { names, customTools: names.flatMap((name) => { const tool = table[name as keyof typeof table]; return tool ? [tool] : []; }), paths, gitPaths, basePaths, close: async () => { await browser?.close(); } };
}
