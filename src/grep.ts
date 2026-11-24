import { accessSync, constants as fsConstants } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { defineTool, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Logger } from "pino";
import { Type } from "typebox";
import { config } from "./config.ts";
import { redactSecrets } from "./errors.ts";
import { childEnvironment } from "./secrets.ts";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;
const MAX_CONTEXT_LINES = 10;
const LINE_WINDOW_BYTES = 256;
const MAX_PREVIEWS_PER_FILE = 3;
const SCAN_TIMEOUT_MS = 10_000;
const SCAN_MAX_LINES = 50_000;
const SCAN_MAX_BYTES = 16 * 1024 * 1024;
const MAX_JSON_FRAME_BYTES = 2 * 1024 * 1024;
const SPILL_ROW_BYTES = 1024;
const SPILL_SESSION_QUOTA_BYTES = 32 * 1024 * 1024;

type Submatch = { start: number; end: number };
type MatchRecord = { line: number; text: string; submatches: Submatch[] };
type FileBucket = { path: string; generated: boolean; matchCount: number; matches: MatchRecord[]; context: Map<number, string> };

type RgJsonEvent =
  | { type: "match"; data: { path?: { text?: string; bytes?: string }; lines?: { text?: string; bytes?: string }; line_number?: number; submatches?: Array<{ start?: number; end?: number }> } }
  | { type: "context"; data: { path?: { text?: string; bytes?: string }; lines?: { text?: string; bytes?: string }; line_number?: number } }
  | { type: string; data?: unknown };

let cachedRg: string | undefined;

function resolveRipgrep(): string | undefined {
  if (cachedRg !== undefined) return cachedRg;
  const binName = process.platform === "win32" ? "rg.exe" : "rg";
  const piRg = join(getAgentDir(), "bin", binName);
  const env = childEnvironment();
  const candidates = [
    piRg,
    ...(env.PATH ?? "").split(process.platform === "win32" ? ";" : ":").filter((dir) => isAbsolute(dir)).map((dir) => join(dir, binName)),
  ];
  for (const candidate of candidates) {
    try { accessSync(candidate, fsConstants.X_OK); } catch { continue; }
    const probe = spawnSync(candidate, ["--version"], { stdio: "ignore", timeout: 3000, env });
    if (probe.status === 0) {
      cachedRg = candidate;
      return candidate;
    }
  }
  return undefined;
}

function decodeRgField(field?: { text?: string; bytes?: string }) {
  if (!field) return "";
  if (typeof field.text === "string") return field.text;
  if (typeof field.bytes === "string") return Buffer.from(field.bytes, "base64").toString("utf8");
  return "";
}

function stripEol(text: string) {
  return text.endsWith("\r\n") ? text.slice(0, -2) : text.endsWith("\n") ? text.slice(0, -1) : text;
}

function toPosix(path: string) {
  return sep === "/" ? path : path.split(sep).join("/");
}

function utf8SliceAround(text: string, focusByte: number, windowBytes: number): { slice: string; leftClipped: boolean; rightClipped: boolean; startByte: number; endByte: number; totalBytes: number } {
  const buf = Buffer.from(text, "utf8");
  const totalBytes = buf.length;
  if (totalBytes <= windowBytes) return { slice: text, leftClipped: false, rightClipped: false, startByte: 0, endByte: totalBytes, totalBytes };

  const clampedFocus = Math.max(0, Math.min(totalBytes, focusByte));
  let start = Math.max(0, clampedFocus - Math.floor(windowBytes / 3));
  let end = Math.min(totalBytes, start + windowBytes);
  if (end - start < windowBytes) start = Math.max(0, end - windowBytes);

  // Align start forward to UTF-8 codepoint boundary (skip continuation bytes 10xxxxxx)
  while (start < end && (buf[start]! & 0xc0) === 0x80) start++;
  // Align end backward to UTF-8 codepoint boundary
  if (end < totalBytes) {
    while (end > start && (buf[end]! & 0xc0) === 0x80) end--;
  }
  return {
    slice: buf.subarray(start, end).toString("utf8"),
    leftClipped: start > 0,
    rightClipped: end < totalBytes,
    startByte: start,
    endByte: end,
    totalBytes,
  };
}

function clipLine(text: string, submatches: Submatch[] = []) {
  const focus = submatches[0]?.start ?? 0;
  const win = utf8SliceAround(text, focus, LINE_WINDOW_BYTES);
  if (!win.leftClipped && !win.rightClipped) return win.slice;
  const outside = submatches.filter((sm) => sm.end <= win.startByte || sm.start >= win.endByte).length;
  const extra = outside > 0 ? `, +${outside} match${outside === 1 ? "" : "es"} outside window` : "";
  return `${win.leftClipped ? "…" : ""}${win.slice}${win.rightClipped ? "…" : ""} [clipped: ${win.totalBytes}B${extra}]`;
}

function chunkSpillLine(prefix: string, text: string): string[] {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= SPILL_ROW_BYTES) return [`${prefix}${text}`];
  const rows: string[] = [];
  let offset = 0;
  while (offset < buf.length) {
    let end = Math.min(buf.length, offset + SPILL_ROW_BYTES);
    if (end < buf.length) {
      while (end > offset && (buf[end]! & 0xc0) === 0x80) end--;
      if (end === offset) end = Math.min(buf.length, offset + SPILL_ROW_BYTES);
    }
    rows.push(`${prefix}[bytes ${offset}-${end}/${buf.length}] ${buf.subarray(offset, end).toString("utf8")}`);
    offset = end;
  }
  return rows;
}

function directoryRollup(files: FileBucket[]) {
  const dirs = new Map<string, { files: number; matches: number }>();
  for (const file of files) {
    const parts = file.path.split("/");
    const key = parts.length <= 1 ? "." : parts.slice(0, Math.min(2, parts.length - 1)).join("/") + "/";
    const cur = dirs.get(key) ?? { files: 0, matches: 0 };
    cur.files++;
    cur.matches += file.matchCount;
    dirs.set(key, cur);
  }
  return [...dirs.entries()].sort((a, b) => b[1].matches - a[1].matches || a[0].localeCompare(b[0]));
}

function renderFileFull(file: FileBucket, withContext: boolean) {
  const lines: string[] = [`${file.path} (${file.matchCount})`];
  if (!withContext || file.context.size === 0) {
    for (const m of file.matches) lines.push(`  ${m.line}: ${clipLine(m.text, m.submatches)}`);
    return lines.join("\n");
  }
  const byLine = new Map<number, { kind: "match"; m: MatchRecord } | { kind: "ctx"; text: string }>();
  for (const [ln, text] of file.context) byLine.set(ln, { kind: "ctx", text });
  for (const m of file.matches) byLine.set(m.line, { kind: "match", m });
  const sorted = [...byLine.entries()].sort((a, b) => a[0] - b[0]);
  let prevLine: number | undefined;
  for (const [ln, entry] of sorted) {
    if (prevLine !== undefined && ln > prevLine + 1) lines.push("  --");
    if (entry.kind === "match") lines.push(`  ${ln}: ${clipLine(entry.m.text, entry.m.submatches)}`);
    else lines.push(`  ${ln}- ${clipLine(entry.text)}`);
    prevLine = ln;
  }
  return lines.join("\n");
}

function buildSpillContent({ header, files, includeMatches, withContext, maxBytes }: { header: string; files: FileBucket[]; includeMatches: boolean; withContext: boolean; maxBytes: number }): { content: string; bytes: number } | undefined {
  const out: string[] = [];
  let bytes = 0;
  const push = (row: string) => {
    const add = Buffer.byteLength(row, "utf8") + 1;
    if (bytes + add > maxBytes) return false;
    out.push(row);
    bytes += add;
    return true;
  };
  if (!push(header) || !push("") || !push("## FILE INDEX")) return undefined;
  for (const file of files) {
    if (!push(`${file.path}: ${file.matchCount}${file.generated ? " [generated]" : ""}`)) return undefined;
  }
  if (includeMatches) {
    if (!push("") || !push("## MATCHES")) return undefined;
    for (const file of files) {
      if (!withContext || file.context.size === 0) {
        for (const m of file.matches) {
          for (const row of chunkSpillLine(`${file.path}:${m.line}: `, m.text)) if (!push(row)) return undefined;
        }
        continue;
      }
      const byLine = new Map<number, { kind: "match"; text: string } | { kind: "ctx"; text: string }>();
      for (const [ln, text] of file.context) byLine.set(ln, { kind: "ctx", text });
      for (const m of file.matches) byLine.set(m.line, { kind: "match", text: m.text });
      const sorted = [...byLine.entries()].sort((a, b) => a[0] - b[0]);
      let prevLine: number | undefined;
      for (const [ln, entry] of sorted) {
        if (prevLine !== undefined && ln > prevLine + 1 && !push("--")) return undefined;
        for (const row of chunkSpillLine(`${file.path}:${ln}${entry.kind === "match" ? ":" : "-"} `, entry.text)) if (!push(row)) return undefined;
        prevLine = ln;
      }
    }
  }
  return { content: out.join("\n") + "\n", bytes };
}

function trimToByteBudget(text: string, maxBytes: number) {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  let end = Math.max(0, maxBytes - 32);
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return `${buf.subarray(0, end).toString("utf8").trimEnd()}\n[output trimmed to ${maxBytes}B]`;
}

export function createGrepTool({ workspaceRoot, contextRoot, sessionTag, searchRoot, resolveTarget, sdkFallback, log }: {
  workspaceRoot: string;
  contextRoot?: string;
  sessionTag: string;
  searchRoot: (path?: string) => Promise<void>;
  resolveTarget: (path?: string) => Promise<string>;
  sdkFallback: { execute: (...args: any[]) => Promise<any>; promptSnippet?: string };
  log?: Logger;
}) {
  const generatedPatterns = config.tools.git.generatedPaths.map((pattern) => new RegExp(pattern));
  const isGenerated = (file: string) => generatedPatterns.some((re) => re.test(file));
  const inlineBytes = config.tools.grep.inlineBytes;
  let seq = 0, spilledBytes = 0, warnedFallback = false;

  const parameters = Type.Object({
    pattern: Type.String({ description: "Search pattern (Rust regex or literal string)" }),
    path: Type.Optional(Type.String({ description: "Directory or file to search (default: current directory)" })),
    glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" })),
    ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
    literal: Type.Optional(Type.Boolean({ description: "Treat pattern as literal string instead of regex (default: false)" })),
    context: Type.Optional(Type.Integer({ minimum: 0, description: `Context lines before/after each match in matches mode (default: 0; clamped to ${MAX_CONTEXT_LINES}; overlapping context emitted once)` })),
    limit: Type.Optional(Type.Integer({ minimum: 1, description: `Max displayed match or file rows (default: ${DEFAULT_LIMIT}, clamped to ${MAX_LIMIT}; never stops the scan)` })),
    mode: Type.Optional(Type.Union([Type.Literal("matches"), Type.Literal("files"), Type.Literal("content")], {
      description: "Output mode: 'matches' (default, file-grouped matches with compact overflow summary) or 'files' (matching files with exact match counts)",
    })),
  });

  return defineTool({
    name: "grep",
    label: "grep",
    promptSnippet: sdkFallback.promptSnippet ?? "Search file contents for patterns (respects .gitignore)",
    description: [
      `Search file contents for a pattern using ripgrep (Rust regex; set literal=true for exact text). Output is bounded to ${inlineBytes} bytes inline with explicit scan/display status.`,
      "Counts cover the stated search scope. Reduced output is for navigation; a partial scan cannot establish absence. Narrow with path/glob or inspect the spill file with read when missing results matter.",
      "Use mode='files' for a compact per-file match inventory on broad queries.",
    ].join("\n"),
    parameters,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (signal?.aborted) throw new Error("Operation aborted");
      await searchRoot(params.path);
      const rgBin = resolveRipgrep();
      if (!rgBin) {
        if (!warnedFallback) { warnedFallback = true; log?.warn({ event: "grep.fallback_sdk", reason: "rg_not_found" }); }
        return sdkFallback.execute(toolCallId, params, signal, onUpdate, ctx);
      }

      const mode = params.mode === "files" ? "files" : "matches";
      const effectiveLimit = Math.min(MAX_LIMIT, Math.max(1, params.limit ?? DEFAULT_LIMIT));
      const contextLines = mode === "matches" ? Math.min(MAX_CONTEXT_LINES, Math.max(0, params.context ?? 0)) : 0;
      const targetReal = await resolveTarget(params.path);
      const targetStat = await stat(targetReal);
      const isDir = targetStat.isDirectory();
      const relToCwd = relative(workspaceRoot, targetReal);
      const insideCwd = relToCwd !== ".." && !relToCwd.startsWith(`..${sep}`);
      const rgTarget = insideCwd ? (!relToCwd ? "." : relToCwd === "-" ? "./-" : relToCwd) : targetReal;
      const scopeLabel = insideCwd ? toPosix(relToCwd || ".") : toPosix(params.path ?? targetReal);

      const args = ["--json", "--line-number", "--column", "--color=never", "--hidden", "--sort=path"];
      if (params.ignoreCase) args.push("-i");
      if (params.literal) args.push("-F");
      // Caller glob must precede forced exclusions so user globs cannot override .git or spill-dir ignores.
      if (params.glob) args.push("--glob", params.glob);
      args.push("--glob", "!.git/**", "--glob", "!.git");
      if (contextRoot) {
        const spillRoot = resolve(contextRoot, "grep");
        const relSpill = relative(targetReal, spillRoot);
        if (isDir && relSpill !== ".." && !relSpill.startsWith(`..${sep}`)) {
          const clean = insideCwd ? toPosix(relative(workspaceRoot, spillRoot)) : toPosix(relSpill);
          if (!clean) args.push("--glob", "!*");
          else if (insideCwd || !clean.includes("/")) args.push("--glob", `!${clean}`, "--glob", `!${clean}/**`);
          else args.push("--glob", `!${clean}`, "--glob", `!${clean}/**`, "--glob", `!**/${clean}`, "--glob", `!**/${clean}/**`);
        }
      }
      if (contextLines > 0) args.push("-C", String(contextLines));
      args.push("--", params.pattern, rgTarget);

      const rgEnv = childEnvironment();
      delete rgEnv.RIPGREP_CONFIG_PATH;

      const fileMap = new Map<string, FileBucket>();
      let totalMatchLines = 0, collectedBytes = 0, parseErrors = 0;
      let scanPartial = false, partialReason = "", aborted = false;
      let stderrText = "";

      const normalizePath = (rawPath: string) => {
        if (!rawPath) return scopeLabel;
        const abs = resolve(workspaceRoot, rawPath);
        const rel = relative(workspaceRoot, abs);
        if (rel !== ".." && !rel.startsWith(`..${sep}`)) return toPosix(rel || ".");
        return toPosix(rawPath);
      };

      const exitCode = await new Promise<number | null>((done, fail) => {
        const child = spawn(rgBin, args, { cwd: workspaceRoot, env: rgEnv, stdio: ["ignore", "pipe", "pipe"] });
        let stdoutBuf = "", stopped = false;
        let killTimer: NodeJS.Timeout | undefined;

        const stopChild = (reason: string) => {
          if (stopped) return;
          stopped = true;
          scanPartial = true;
          partialReason ||= reason;
          try { child.kill("SIGTERM"); } catch {}
          killTimer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 2000);
        };

        const timer = setTimeout(() => stopChild("timeout"), SCAN_TIMEOUT_MS);
        const onAbort = () => { aborted = true; stopChild("aborted"); };
        if (signal?.aborted) onAbort(); else signal?.addEventListener("abort", onAbort, { once: true });

        const handleLine = (line: string) => {
          if (!line || stopped) return;
          if (Buffer.byteLength(line, "utf8") > MAX_JSON_FRAME_BYTES) {
            scanPartial = true;
            if (!partialReason) partialReason = "oversized_line";
            return;
          }
          let ev: RgJsonEvent;
          try { ev = JSON.parse(line) as RgJsonEvent; } catch { parseErrors++; return; }
          if (ev.type !== "match" && ev.type !== "context") return;
          const data = ev.data as { path?: { text?: string; bytes?: string }; lines?: { text?: string; bytes?: string }; line_number?: number; submatches?: Array<{ start?: number; end?: number }> };
          const lineNo = data.line_number;
          if (typeof lineNo !== "number") return;
          const filePath = normalizePath(decodeRgField(data.path));
          let bucket = fileMap.get(filePath);
          if (!bucket) {
            bucket = { path: filePath, generated: isGenerated(filePath), matchCount: 0, matches: [], context: new Map() };
            fileMap.set(filePath, bucket);
          }
          if (mode === "files") {
            if (ev.type !== "match") return;
            bucket.matchCount++;
            totalMatchLines++;
            collectedBytes += Buffer.byteLength(line, "utf8");
          } else {
            const rawLine = stripEol(decodeRgField(data.lines));
            const text = redactSecrets(rawLine);
            if (ev.type === "match") {
              const submatches: Submatch[] = [];
              const rawBuf = rawLine !== text ? Buffer.from(rawLine, "utf8") : undefined;
              for (const sm of data.submatches ?? []) {
                if (typeof sm.start === "number" && typeof sm.end === "number") {
                  if (!rawBuf) {
                    submatches.push({ start: sm.start, end: sm.end });
                  } else {
                    // Translate byte offsets across redaction so clipLine stays centered on the match.
                    const prefix = redactSecrets(rawBuf.subarray(0, sm.start).toString("utf8"));
                    const matchText = redactSecrets(rawBuf.subarray(sm.start, sm.end).toString("utf8"));
                    const start = Buffer.byteLength(prefix, "utf8");
                    const end = start + Buffer.byteLength(matchText, "utf8");
                    submatches.push({ start, end });
                  }
                  if (submatches.length >= 16) break;
                }
              }
              collectedBytes += Buffer.byteLength(text, "utf8") + submatches.length * 16 + 32;
              bucket.matchCount++;
              bucket.matches.push({ line: lineNo, text, submatches });
              totalMatchLines++;
            } else if (contextLines > 0) {
              collectedBytes += Buffer.byteLength(text, "utf8") + 32;
              bucket.context.set(lineNo, text);
            }
          }
          if (totalMatchLines >= SCAN_MAX_LINES) stopChild("scan_line_limit");
          else if (collectedBytes >= SCAN_MAX_BYTES) stopChild("scan_byte_limit");
        };

        let skippingOversized = false;
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          if (stopped) return;
          if (skippingOversized) {
            const nl = chunk.indexOf("\n");
            if (nl < 0) return;
            skippingOversized = false;
            stdoutBuf = chunk.slice(nl + 1);
          } else {
            stdoutBuf += chunk;
          }
          if (Buffer.byteLength(stdoutBuf, "utf8") > MAX_JSON_FRAME_BYTES && !stdoutBuf.includes("\n")) {
            stdoutBuf = "";
            skippingOversized = true;
            scanPartial = true;
            if (!partialReason) partialReason = "oversized_line";
            return;
          }
          let nl = stdoutBuf.indexOf("\n");
          while (nl >= 0) {
            const line = stdoutBuf.slice(0, nl);
            stdoutBuf = stdoutBuf.slice(nl + 1);
            handleLine(line);
            if (stopped) { stdoutBuf = ""; break; }
            nl = stdoutBuf.indexOf("\n");
          }
        });

        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) => {
          if (stderrText.length < 4096) stderrText += chunk.slice(0, 4096 - stderrText.length);
        });

        child.on("error", (error) => {
          clearTimeout(timer);
          clearTimeout(killTimer);
          signal?.removeEventListener("abort", onAbort);
          fail(error);
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          clearTimeout(killTimer);
          signal?.removeEventListener("abort", onAbort);
          if (aborted) { fail(new Error("Operation aborted")); return; }
          if (!stopped && stdoutBuf.trim()) handleLine(stdoutBuf.trim());
          done(code);
        });
      });

      const cleanStderr = redactSecrets(stderrText.trim());
      if (parseErrors > 0) { scanPartial = true; partialReason ||= "parse_error"; }
      if (exitCode === 2 || (exitCode !== 0 && exitCode !== 1 && !scanPartial)) {
        if (totalMatchLines === 0) throw new Error(cleanStderr || `grep failed with exit code ${exitCode ?? "unknown"}`);
        scanPartial = true;
        partialReason ||= "rg_error";
      }

      const files = [...fileMap.values()].filter((file) => file.matchCount > 0).sort((a, b) => a.path.localeCompare(b.path));
      const scanStatus = scanPartial ? "partial" : "complete";

      // Clean zero requires complete scan, exit code 1, zero stderr/parse errors.
      if (totalMatchLines === 0) {
        if (!scanPartial && exitCode === 1 && !cleanStderr) {
          const text = `[grep | scan: complete | display: full | scope: ${scopeLabel} | 0 matches]`;
          return { content: [{ type: "text" as const, text }], details: { mode, scan: "complete", display: "full", matchLines: 0, files: 0, shownLines: 0, rawBytes: collectedBytes, outBytes: Buffer.byteLength(text, "utf8") } };
        }
        const text = `[grep | scan: partial (${partialReason || "error"}) | display: reduced | scope: ${scopeLabel} | >= 0 matches (NOT exhaustive)${cleanStderr ? `\n${cleanStderr}` : ""}]`;
        return { content: [{ type: "text" as const, text }], details: { mode, scan: "partial", display: "reduced", reason: partialReason, matchLines: 0, files: 0, shownLines: 0, rawBytes: collectedBytes, outBytes: Buffer.byteLength(text, "utf8") } };
      }

      const spillArtifact = async (header: string): Promise<{ path?: string; note: string }> => {
        if (!contextRoot) return { note: "Full results were not spilled (no context directory); narrow with path/glob." };
        const remainingQuota = SPILL_SESSION_QUOTA_BYTES - spilledBytes;
        const built = remainingQuota > 0 ? buildSpillContent({ header, files, includeMatches: mode === "matches", withContext: contextLines > 0, maxBytes: remainingQuota }) : undefined;
        if (!built) {
          return { note: `Spill quota reached (${Math.round(SPILL_SESSION_QUOTA_BYTES / (1024 * 1024))} MiB/session); narrow with path/glob.` };
        }
        const { content, bytes } = built;
        // Reserve quota synchronously before awaiting filesystem writes so parallel grep calls cannot overrun the cap.
        spilledBytes += bytes;
        const dir = join(contextRoot, "grep", sessionTag);
        const file = join(dir, `${String(++seq).padStart(3, "0")}.txt`);
        try {
          await mkdir(dir, { recursive: true, mode: 0o700 });
          await writeFile(file, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
          return { path: file, note: `Full scanned results saved to ${file} — inspect with read (e.g. offset=1, limit=40) or narrow with path/glob.` };
        } catch {
          spilledBytes -= bytes;
          return { note: "Could not write spill file; narrow with path/glob." };
        }
      };

      const countPrefix = scanPartial ? ">= " : "";
      const summaryStats = `${countPrefix}${totalMatchLines} match${totalMatchLines === 1 ? "" : "es"} in ${countPrefix}${files.length} file${files.length === 1 ? "" : "s"}`;

      // Mode: files
      if (mode === "files") {
        const rows = files.map((file) => `${file.path}: ${countPrefix}${file.matchCount}${file.generated ? " [generated]" : ""}`);
        const headerFull = `[grep | mode: files | scan: ${scanStatus}${partialReason ? ` (${partialReason})` : ""} | display: full | scope: ${scopeLabel} | ${summaryStats}]`;
        const fullBody = `${headerFull}\n${rows.join("\n")}`;
        if (!scanPartial && files.length <= effectiveLimit && Buffer.byteLength(fullBody, "utf8") <= inlineBytes) {
          return { content: [{ type: "text" as const, text: fullBody }], details: { mode, scan: scanStatus, display: "full", matchLines: totalMatchLines, files: files.length, shownLines: files.length, rawBytes: collectedBytes, outBytes: Buffer.byteLength(fullBody, "utf8") } };
        }
        const reason = scanPartial ? partialReason : files.length > effectiveLimit ? "limit" : "budget";
        const header = `[grep | mode: files | scan: ${scanStatus}${partialReason ? ` (${partialReason})` : ""} | display: reduced (${reason}) | scope: ${scopeLabel} | ${summaryStats}]`;
        const spill = await spillArtifact(header);
        const guidance = `${scanPartial ? "Partial scan: counts are lower bounds and cannot establish absence. " : ""}Reduced view: ${spill.note}`;
        const keptRows: string[] = [];
        let used = Buffer.byteLength(`${header}\n${guidance}\n\n`, "utf8");
        for (const row of rows.slice(0, effectiveLimit)) {
          const rowBytes = Buffer.byteLength(row, "utf8") + 1;
          if (used + rowBytes > inlineBytes - 120) break;
          keptRows.push(row);
          used += rowBytes;
        }
        const omitted = files.length - keptRows.length;
        const text = trimToByteBudget([
          header,
          guidance,
          "",
          ...keptRows,
          omitted > 0 ? `... (${omitted} more files omitted; see spill file or narrow with path/glob)` : "",
        ].filter(Boolean).join("\n"), inlineBytes);
        return { content: [{ type: "text" as const, text }], details: { mode, scan: scanStatus, display: "reduced", reason, matchLines: totalMatchLines, files: files.length, shownLines: keptRows.length, rawBytes: collectedBytes, outBytes: Buffer.byteLength(text, "utf8"), spillPath: spill.path } };
      }

      // Mode: matches — try Tier 1 (full inline) when scan is complete and within display limit
      if (!scanPartial && totalMatchLines <= effectiveLimit) {
        const header = `[grep | scan: complete | display: full | scope: ${scopeLabel} | ${summaryStats}]`;
        const body = files.map((file) => renderFileFull(file, contextLines > 0)).join("\n\n");
        const fullText = `${header}\n${body}`;
        if (Buffer.byteLength(fullText, "utf8") <= inlineBytes) {
          return { content: [{ type: "text" as const, text: fullText }], details: { mode, scan: "complete", display: "full", matchLines: totalMatchLines, files: files.length, shownLines: totalMatchLines, rawBytes: collectedBytes, outBytes: Buffer.byteLength(fullText, "utf8") } };
        }
      }

      // Tier 2 / Overflow: Reduced deterministic view with complete file inventory + round-robin previews (non-generated first)
      const reason = scanPartial ? partialReason : totalMatchLines > effectiveLimit ? "limit" : "budget";
      const header = `[grep | scan: ${scanStatus}${partialReason ? ` (${partialReason})` : ""} | display: reduced (${reason}) | scope: ${scopeLabel} | ${summaryStats}]`;
      const spill = await spillArtifact(header);
      const notice = [
        `${scanPartial ? "Partial scan (NOT exhaustive): counts are lower bounds and cannot establish absence." : "Reduced view: omitted matches are not proof of 0 callers or unused code."}`,
        spill.note,
        cleanStderr ? `ripgrep warning: ${cleanStderr.slice(0, 200)}` : "",
      ].filter(Boolean).join("\n");

      const headerBlock = `${header}\n${notice}`;
      const remainingTotal = Math.max(1024, inlineBytes - Buffer.byteLength(headerBlock, "utf8") - 64);

      // Build file inventory (up to 45% of remaining budget; switch to directory rollup if too many files)
      const invBudget = Math.floor(remainingTotal * 0.45);
      const fileCountRows = files.map((file) => `  ${file.path}: ${countPrefix}${file.matches.length}${file.generated ? " [generated]" : ""}`);
      let invBlock = "";
      const fullInv = `Matches by file (${countPrefix}${files.length}):\n${fileCountRows.join("\n")}`;
      if (Buffer.byteLength(fullInv, "utf8") <= invBudget) {
        invBlock = fullInv;
      } else {
        const rollups = directoryRollup(files);
        const rollupLines = [`Matches by directory (${rollups.length} dirs, ${countPrefix}${files.length} files):`];
        let used = Buffer.byteLength(rollupLines[0]!, "utf8");
        for (const [dir, counts] of rollups) {
          const line = `  ${dir}: ${countPrefix}${counts.files} file${counts.files === 1 ? "" : "s"}, ${countPrefix}${counts.matches} match${counts.matches === 1 ? "" : "es"}`;
          const len = Buffer.byteLength(line, "utf8") + 1;
          if (used + len > invBudget - 64) { rollupLines.push(`  ... (+${rollups.length - (rollupLines.length - 1)} more dirs)`); break; }
          rollupLines.push(line);
          used += len;
        }
        invBlock = rollupLines.join("\n");
      }

      // Spend remaining budget on round-robin match previews (non-generated files first; collapse generated to counts unless only generated matched)
      const previewBudget = Math.max(512, remainingTotal - Buffer.byteLength(invBlock, "utf8") - 48);
      const nonGenerated = files.filter((file) => !file.generated);
      const previewCandidates = nonGenerated.length > 0 ? nonGenerated : files;
      const perFileCap = previewCandidates.length === 1 ? effectiveLimit : MAX_PREVIEWS_PER_FILE;
      const chosenByFile = new Map<FileBucket, MatchRecord[]>();
      let shownLines = 0, usedPreview = Buffer.byteLength("Sample matches:\n", "utf8");

      roundRobin: for (let round = 0; round < perFileCap; round++) {
        let addedInRound = false;
        for (const file of previewCandidates) {
          if (shownLines >= effectiveLimit) break roundRobin;
          const match = file.matches[round];
          if (!match) continue;
          const renderedLine = `  ${match.line}: ${clipLine(match.text, match.submatches)}`;
          const extraHeader = chosenByFile.has(file) ? 0 : Buffer.byteLength(`\n${file.path} (${file.matches.length})\n`, "utf8") + 28;
          const lineBytes = Buffer.byteLength(renderedLine, "utf8") + 1 + extraHeader;
          if (shownLines > 0 && usedPreview + lineBytes > previewBudget) break roundRobin;
          let arr = chosenByFile.get(file);
          if (!arr) { arr = []; chosenByFile.set(file, arr); }
          arr.push(match);
          usedPreview += lineBytes;
          shownLines++;
          addedInRound = true;
        }
        if (!addedInRound) break;
      }

      const previewSections: string[] = [];
      for (const file of previewCandidates) {
        const picked = chosenByFile.get(file);
        if (!picked?.length) continue;
        const lines = [`${file.path} (${file.matches.length})`];
        for (const m of picked) lines.push(`  ${m.line}: ${clipLine(m.text, m.submatches)}`);
        const omittedInFile = file.matches.length - picked.length;
        if (omittedInFile > 0) lines.push(`  ... (+${omittedInFile} more in this file)`);
        previewSections.push(lines.join("\n"));
      }
      const previewBlock = previewSections.length ? `Sample matches:\n${previewSections.join("\n\n")}` : "";

      const text = trimToByteBudget([headerBlock, invBlock, previewBlock].filter(Boolean).join("\n\n"), inlineBytes);
      return {
        content: [{ type: "text" as const, text }],
        details: { mode, scan: scanStatus, display: "reduced", reason, matchLines: totalMatchLines, files: files.length, shownLines, rawBytes: collectedBytes, outBytes: Buffer.byteLength(text, "utf8"), spillPath: spill.path },
      };
    },
  });
}
