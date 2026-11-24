import { existsSync, readFileSync } from "node:fs";
import { open, unlink, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { Agent, fetch as undiciFetch } from "undici";
import { config } from "./config.ts";
import { errorMessage, redactSecrets } from "./errors.ts";

type D1Log = { info?(details: Record<string, unknown>): void; warn(details: Record<string, unknown>): void };

type D1Response = {
  answers?: Record<string, { noul?: number; span?: number[] }>;
  infer_ms?: number;
};

type D1Requester = (payload: { model: string; state: string; questions: Record<string, { type: "noul"; instructions: string }> }, signal?: AbortSignal) => Promise<D1Response>;

type Chunk = { start: number; end: number; text: string };

const ansiRe = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const highSeverityAnomalyRe = /\b(?:error|exception|traceback|failed|failure|fatal|panic|assert(?:ion)?error|segmentation fault|killed|oom|timeout|denied|refused|conflict)\b|FAIL\s|error\s+TS\d+:/i;
const anomalyRe = /\b(?:error|exception|traceback|failed|failure|fatal|panic|assert(?:ion)?error|segmentation fault|killed|oom|timeout|denied|refused|conflict|warning)\b|FAIL\s/i;
const vitestFailStartRe = /^\s*(?:FAIL\s+\S|❯\s+\S.*:\d+:\d+|AssertionError:\s)/;
const tsErrorStartRe = /^\s*(?:[^\s(]+\(\d+,\d+\):\s*error\s+TS\d+:|[^\s:]+\.[cm]?[jt]sx?:\d+:\d+\s*-\s*error\s+TS\d+:)/;
const eslintErrorLineRe = /^\s*\d+:\d+\s+error\s+\S/;
const eslintFileHeaderRe = /^(?:\/|[A-Za-z0-9_.-]+\/)?[^\s/][^\s]*\.[A-Za-z0-9]{1,8}$/;
const knipSectionStartRe = /^(?:Unused (?:files|exports|types|enum members|class members|dependencies|devDependencies|unlisted binaries)|Unlisted (?:dependencies|binaries)|Unresolved imports|Duplicate exports)\s*\(\d+\)/;
const structuredFailureRe = new RegExp(
  `${vitestFailStartRe.source}|${tsErrorStartRe.source}|${eslintErrorLineRe.source}|${knipSectionStartRe.source}`,
  "m",
);
const structuralSplitRe = /(?=(?:^|\n)(?:<prompt-data>|<\/prompt-data>|#{1,4}\s+|===\s+|---\s*$|FAIL\s+))/gm;
const paragraphSplitRe = /\n\s*\n/g;
const b64JunkRe = /[A-Za-z0-9+/=_-]{180,}/g;
const wordRe = /[A-Za-z0-9_]{3,}/g;
const numUnitRe = /\b\d+(?:\.\d+)?\s*(?:ms|s|m|min|hr|hrs|kb|mb|gb|%|x|px|\$)\b/gi;
const stopWords = new Set([
  "the", "and", "for", "that", "this", "with", "from", "are", "was", "were", "have", "has", "had",
  "not", "but", "you", "your", "our", "their", "they", "them", "can", "could", "should", "would",
  "will", "just", "about", "into", "over", "after", "before", "then", "than", "when", "what",
  "which", "where", "there", "here", "been", "being", "also", "more", "some", "only", "still",
]);
const structuralMarkers = ["###", "## ", "**", "FAIL", "ERROR", "AssertionError", "Summary", "Result", "Expected", "Received"];
const readHintCommands = new Set(["cat", "head", "tail", "nl", "wc", "ls", "stat", "pwd", "diff", "cmp", "cut", "grep", "egrep", "fgrep", "rg", "sed", "jq"]);
const readHintHelpers = new Set(["echo", "true", "false"]);
const gitReadSubcommands = new Set(["diff", "show", "status", "log", "ls-files", "rev-parse"]);

const nativeFetch = globalThis.fetch;
let cachedDispatcher: { certPath: string | null; agent: Agent } | undefined;
let d1CircuitOpenUntil = 0;
let d1Consecutive429s = 0;

function getDispatcher(certPath: string | null) {
  if (cachedDispatcher && cachedDispatcher.certPath === certPath) return cachedDispatcher.agent;
  const connect = certPath && existsSync(certPath) ? { ca: readFileSync(certPath) } : undefined;
  const agent = new Agent({ connect, connections: 4 });
  cachedDispatcher = { certPath, agent };
  return agent;
}

export function trimUtf8End(buf: Buffer) {
  if (!buf.length) return buf;
  let lead = buf.length - 1;
  const floor = Math.max(0, buf.length - 4);
  while (lead > floor && (buf[lead]! & 0xc0) === 0x80) lead--;
  const b = buf[lead]!;
  if ((b & 0xc0) === 0x80) return buf.subarray(0, lead);
  const expected = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
  return lead + expected > buf.length ? buf.subarray(0, lead) : buf;
}

function trimUtf8Start(buf: Buffer) {
  let start = 0;
  while (start < buf.length && (buf[start]! & 0xc0) === 0x80) start++;
  return buf.subarray(start);
}

export function utf8TailSlice(text: string, maxBytes: number) {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  return trimUtf8Start(buf.subarray(buf.length - maxBytes)).toString("utf8");
}

export async function readHeadAndTail(filePath: string, maxBytes: number): Promise<{ text: string; truncated: boolean; totalBytes: number } | undefined> {
  const handle = await open(filePath, "r").catch(() => undefined);
  if (!handle) return undefined;
  try {
    const { size } = await handle.stat();
    const margin = Math.max(config.tools.redactionMarginBytes, 8192);
    if (size <= maxBytes + 2 * margin) {
      const buf = Buffer.alloc(size);
      const { bytesRead } = await handle.read(buf, 0, size, 0);
      const redacted = redactSecrets(buf.subarray(0, bytesRead).toString("utf8"));
      const redactedBuf = Buffer.from(redacted, "utf8");
      if (size <= maxBytes || redactedBuf.length <= maxBytes) {
        return { text: redacted, truncated: false, totalBytes: size };
      }
      const headBytes = Math.floor(maxBytes / 2);
      const tailBytes = maxBytes - headBytes;
      const head = trimUtf8End(redactedBuf.subarray(0, headBytes)).toString("utf8");
      const tail = trimUtf8Start(redactedBuf.subarray(redactedBuf.length - tailBytes)).toString("utf8");
      const omitted = Math.max(1, redactedBuf.length - Buffer.byteLength(head, "utf8") - Buffer.byteLength(tail, "utf8"));
      return { text: `${head}\n\n[... ${omitted} bytes omitted from middle of ${size}-byte log ...]\n\n${tail}`, truncated: true, totalBytes: size };
    }
    const headBytes = Math.floor(maxBytes / 2);
    const tailBytes = maxBytes - headBytes;
    const headReadLen = Math.min(size, headBytes + margin);
    const tailReadLen = Math.min(size, tailBytes + margin);
    const headBuf = Buffer.alloc(headReadLen);
    const tailBuf = Buffer.alloc(tailReadLen);
    const [headRead, tailRead] = await Promise.all([
      handle.read(headBuf, 0, headReadLen, 0),
      handle.read(tailBuf, 0, tailReadLen, size - tailReadLen),
    ]);
    // Redact with a byte margin on each cut edge, then drop the margin bytes so no straddling secret fragment can survive.
    const headRedactedBuf = Buffer.from(redactSecrets(trimUtf8End(headBuf.subarray(0, headRead.bytesRead)).toString("utf8")), "utf8");
    const tailRedactedBuf = Buffer.from(redactSecrets(trimUtf8Start(tailBuf.subarray(0, tailRead.bytesRead)).toString("utf8")), "utf8");
    const head = trimUtf8End(headRedactedBuf.subarray(0, Math.min(headBytes, Math.max(0, headRedactedBuf.length - margin)))).toString("utf8");
    const tailStart = Math.max(Math.min(tailRedactedBuf.length, margin), tailRedactedBuf.length - tailBytes);
    const tail = trimUtf8Start(tailRedactedBuf.subarray(tailStart)).toString("utf8");
    const omitted = Math.max(1, size - Buffer.byteLength(head, "utf8") - Buffer.byteLength(tail, "utf8"));
    return { text: `${head}\n\n[... ${omitted} bytes omitted from middle of ${size}-byte log ...]\n\n${tail}`, truncated: true, totalBytes: size };
  } finally { await handle.close().catch(() => undefined); }
}

async function persistArtifact(filePath: string | undefined, content: string) {
  if (!filePath) return undefined;
  return writeFile(filePath, content, { encoding: "utf8", mode: 0o600 }).then(() => filePath, () => undefined);
}

function findSafeSplit(text: string, margin: number): number {
  if (text.length <= margin) return 0;
  let limit = text.length - margin;
  // Never split inside or walk backward into a PEM private-key block.
  let pemFloor = 0;
  let searchFrom = limit;
  while (searchFrom >= 0) {
    const lastBegin = text.lastIndexOf("-----BEGIN ", searchFrom);
    if (lastBegin < 0) break;
    const endAfter = text.indexOf("-----END ", lastBegin);
    const endDashes = endAfter >= 0 ? text.indexOf("-----", endAfter + 9) : -1;
    const pemEnd = endDashes >= 0 ? endDashes + 5 : -1;
    if (pemEnd > 0 && pemEnd <= limit) {
      pemFloor = pemEnd;
      break;
    }
    if (text.length - lastBegin <= margin * 3) {
      limit = lastBegin;
      searchFrom = lastBegin - 1;
    } else {
      break;
    }
  }
  const floor = Math.max(0, limit - margin, pemFloor);
  // Pass 1: newline boundary not immediately after Bearer/token.
  for (let idx = limit; idx > floor; idx--) {
    if (text.charCodeAt(idx - 1) === 10) {
      const before = text.slice(Math.max(0, idx - 32), idx);
      if (!/\b(?:Bearer|token)\s+$/i.test(before)) return idx;
    }
  }
  // Pass 2: whitespace boundary (Bearer/token \S+ stops at whitespace).
  for (let idx = limit; idx > floor; idx--) {
    const ch = text.charCodeAt(idx - 1);
    if (ch === 32 || ch === 9 || ch === 13) {
      const before = text.slice(Math.max(0, idx - 32), idx);
      if (!/\b(?:Bearer|token)\s+$/i.test(before)) return idx;
    }
  }
  // Fallback for unbroken delimiter-free lines: verify no secret straddles the candidate cut.
  const candidate = floor === pemFloor && pemFloor > 0 ? pemFloor : limit;
  const probeHalf = Math.floor(margin / 2);
  const zoneStart = Math.max(0, candidate - probeHalf);
  const zoneEnd = Math.min(text.length, candidate + probeHalf);
  const zone = text.slice(zoneStart, zoneEnd);
  const redactedZone = redactSecrets(zone);
  if (redactedZone === zone) return candidate;
  let firstDiff = 0;
  const maxCmp = Math.min(zone.length, redactedZone.length);
  while (firstDiff < maxCmp && zone.charCodeAt(firstDiff) === redactedZone.charCodeAt(firstDiff)) firstDiff++;
  return firstDiff < candidate - zoneStart ? zoneStart + firstDiff : candidate;
}

async function writeAll(handle: Awaited<ReturnType<typeof open>>, buf: Buffer) {
  let offset = 0;
  while (offset < buf.length) {
    const { bytesWritten } = await handle.write(buf, offset, buf.length - offset);
    if (bytesWritten <= 0) throw new Error("Short write while persisting redacted log");
    offset += bytesWritten;
  }
}

export async function copyRedactedFile(srcPath: string, destPath: string, maxBytes: number): Promise<{ path: string; truncated: boolean } | undefined> {
  const src = await open(srcPath, "r").catch(() => undefined);
  if (!src) return undefined;
  const dst = await open(destPath, "w", 0o600).catch(() => undefined);
  if (!dst) { await src.close().catch(() => undefined); return undefined; }
  const margin = Math.max(config.tools.redactionMarginBytes, 8192);
  const chunkSize = 256 * 1024;
  let failed = false;
  try {
    const { size } = await src.stat();
    const capOutput = size > maxBytes;
    const readCap = capOutput ? Math.min(size, maxBytes + margin) : size;
    let pos = 0, byteCarry = Buffer.alloc(0), rawCarry = "", written = 0, hitEof = false;
    const buf = Buffer.alloc(chunkSize);
    const emit = async (rawText: string, dropTrailingMargin: boolean) => {
      if (!rawText) return;
      const redactedBuf = Buffer.from(redactSecrets(rawText), "utf8");
      const trimmed = dropTrailingMargin ? trimUtf8End(redactedBuf.subarray(0, Math.max(0, redactedBuf.length - margin))) : redactedBuf;
      const slice = capOutput && written + trimmed.length > maxBytes
        ? trimUtf8End(trimmed.subarray(0, Math.max(0, maxBytes - written)))
        : trimmed;
      if (slice.length) { await writeAll(dst, slice); written += slice.length; }
    };
    while (pos < readCap) {
      const toRead = Math.min(chunkSize, readCap - pos);
      const { bytesRead } = await src.read(buf, 0, toRead, pos);
      if (bytesRead <= 0) { hitEof = true; break; }
      pos += bytesRead;
      const combined = byteCarry.length ? Buffer.concat([byteCarry, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
      const valid = trimUtf8End(combined);
      byteCarry = valid.length < combined.length ? Buffer.from(combined.subarray(valid.length)) : Buffer.alloc(0);
      const text = rawCarry + valid.toString("utf8");
      if (pos < readCap) {
        const cut = findSafeSplit(text, margin);
        if (cut > 0) await emit(text.slice(0, cut), false);
        rawCarry = text.slice(cut);
      } else {
        await emit(text, readCap < size);
        rawCarry = "";
      }
      if (capOutput && written >= maxBytes) { rawCarry = ""; break; }
    }
    if (hitEof && (rawCarry || byteCarry.length)) {
      const tail = rawCarry + (byteCarry.length ? byteCarry.toString("utf8") : "");
      await emit(tail, false);
    }
    return { path: destPath, truncated: capOutput };
  } catch {
    failed = true;
    return undefined;
  } finally {
    await src.close().catch(() => undefined);
    await dst.close().catch(() => undefined);
    if (failed) await unlink(destPath).catch(() => undefined);
  }
}

async function persistCommandArtifact(artifactPath: string | undefined, content: string, sourceArtifactPath: string | undefined, existingArtifactPath: string | undefined, partialSource: boolean) {
  if (artifactPath && sourceArtifactPath) {
    const copied = await copyRedactedFile(sourceArtifactPath, artifactPath, config.harness.maxOutputBytes);
    if (copied) return { savedPath: copied.path, isPartial: copied.truncated };
  }
  const written = await persistArtifact(artifactPath, content);
  if (written) return { savedPath: written, isPartial: partialSource };
  return { savedPath: existingArtifactPath, isPartial: false };
}

export function stripAnsi(text: string) {
  return text.replace(ansiRe, "");
}

function isCodeReadCommand(command: string) {
  const trimmed = command.trim();
  if (!trimmed || /[\n`><]|\$\(/.test(trimmed)) return false;
  const segments = trimmed.split(/\s*(?:\|\||&&|\||;)\s*/).filter(Boolean);
  if (!segments.length) return false;
  let hasRead = false;
  for (const segment of segments) {
    const tokens = segment.trim().split(/\s+/);
    let idx = 0;
    while (idx < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[idx]!)) idx++;
    if (idx >= tokens.length) continue;
    const exe = tokens[idx]!.split("/").at(-1)!;
    if (readHintHelpers.has(exe)) continue;
    if (readHintCommands.has(exe)) { hasRead = true; continue; }
    if (exe === "git") {
      const sub = tokens.slice(idx + 1).find((token) => !token.startsWith("-"));
      if (sub && gitReadSubcommands.has(sub)) { hasRead = true; continue; }
    }
    return false;
  }
  return hasRead;
}

function extractStructuredFailures(text: string, maxBlocks = config.d1.failureBlocks.maxBlocks, contextLines = config.d1.failureBlocks.contextLines) {
  if (!config.d1.failureBlocks.enabled || maxBlocks <= 0) return { blocks: [] as string[], total: 0 };
  const lines = text.split("\n");
  const blocks: string[] = [];
  const seen = new Set<string>();
  let total = 0;
  const pushBlock = (blockLines: string[]) => {
    const rendered = blockLines.join("\n").trimEnd();
    if (!rendered || seen.has(rendered)) return;
    seen.add(rendered);
    total++;
    if (blocks.length < maxBlocks) blocks.push(rendered);
  };
  let lastEslintHeader: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (!trimmed) { lastEslintHeader = undefined; continue; }
    if (!/^\s/.test(line) && eslintFileHeaderRe.test(trimmed)) { lastEslintHeader = trimmed; continue; }

    if (knipSectionStartRe.test(trimmed)) {
      const taken = [line];
      let j = i + 1;
      for (; j < lines.length && taken.length <= contextLines; j++) {
        const next = lines[j]!;
        if (!next.trim() || knipSectionStartRe.test(next.trim())) break;
        taken.push(next);
      }
      pushBlock(taken);
      i = j - 1;
      continue;
    }

    if (tsErrorStartRe.test(line)) {
      const taken = [line];
      let j = i + 1;
      for (; j < lines.length && taken.length <= contextLines; j++) {
        const next = lines[j]!;
        if (!next.trim() || tsErrorStartRe.test(next) || !/^\s+/.test(next)) break;
        taken.push(next);
      }
      pushBlock(taken);
      i = j - 1;
      continue;
    }

    if (eslintErrorLineRe.test(line)) {
      const taken = lastEslintHeader ? [lastEslintHeader, line] : [line];
      let j = i + 1;
      for (; j < lines.length && taken.length <= contextLines + 1; j++) {
        const next = lines[j]!;
        if (!next.trim() || (!eslintErrorLineRe.test(next) && !/^\s*\d+:\d+\s+warning\s+/.test(next))) break;
        if (eslintErrorLineRe.test(next)) taken.push(next);
      }
      pushBlock(taken);
      i = j - 1;
      continue;
    }

    if (vitestFailStartRe.test(line)) {
      const taken = [line];
      let j = i + 1;
      for (; j < lines.length && taken.length <= contextLines; j++) {
        const next = lines[j]!;
        const nt = next.trim();
        if (!nt) {
          // Allow one blank line inside a Vitest diff block if followed by Expected/Received/stack line
          const peek = lines[j + 1]?.trim() ?? "";
          if (/^(?:Expected|Received|[-+]|at\s+|❯\s+)/.test(peek)) { taken.push(next); continue; }
          break;
        }
        if (/^✓\s|^Test Files\s|^⎯/.test(nt)) break;
        if (vitestFailStartRe.test(next) && /^\s*FAIL\s+/.test(next)) break;
        taken.push(next);
      }
      pushBlock(taken);
      i = j - 1;
    }
  }
  return { blocks, total };
}

function fitStructuredFailureBlock(blocks: string[], maxChars: number) {
  const header = "## STRUCTURED FAILURES\n";
  if (!blocks.length || maxChars < header.length + 24) return { text: "", kept: 0 };
  const kept: string[] = [];
  let used = header.length;
  for (const block of blocks) {
    const sep = kept.length ? 2 : 0;
    if (used + sep + block.length <= maxChars) {
      kept.push(block);
      used += sep + block.length;
    } else if (!kept.length) {
      const avail = maxChars - header.length - 12;
      if (avail >= 24) kept.push(`${block.slice(0, avail).trimEnd()}\n[trimmed]`);
      break;
    } else {
      break;
    }
  }
  return kept.length ? { text: `${header}${kept.join("\n\n")}`, kept: kept.length } : { text: "", kept: 0 };
}

function extractAnomalyLines(text: string, maxLines = 10) {
  const high: string[] = [], low: string[] = [], seen = new Set<string>();
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line || !anomalyRe.test(line)) continue;
    const key = line.slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    const entry = `L${i + 1}: ${line.slice(0, 180)}`;
    if (highSeverityAnomalyRe.test(line)) {
      high.push(entry);
      if (high.length >= maxLines) break;
    } else if (low.length < maxLines) {
      low.push(entry);
    }
  }
  return [...high, ...low].slice(0, maxLines);
}

function fitAnomalyBlock(anomalies: string[], maxChars: number) {
  const header = "## FLAGGED ANOMALY LINES\n";
  if (!anomalies.length || maxChars < header.length + 24) return "";
  const kept: string[] = [];
  let used = header.length;
  for (const line of anomalies) {
    const add = (kept.length ? 1 : 0) + line.length;
    if (used + add > maxChars) break;
    kept.push(line);
    used += add;
  }
  return kept.length ? `${header}${kept.join("\n")}` : "";
}

function boundedPreview(text: string, maxChars: number, artifactPath?: string, partialArtifact = false, artifactLabel?: string) {
  if (text.length <= maxChars) return text;
  const lines = text.split("\n").length;
  const label = artifactLabel ?? (partialArtifact ? "partial head+tail output" : "full output");
  const ref = artifactPath ? `; ${label} saved to ${artifactPath} (${text.length} chars, ${lines} lines) — use read to inspect` : ` (${text.length} chars, ${lines} lines)`;
  const half = Math.max(80, Math.min(Math.floor((maxChars - ref.length - 48) / 2), Math.floor((text.length - 1) / 2)));
  const omitted = Math.max(1, text.length - 2 * half);
  return `${text.slice(0, half)}\n\n... [truncated ${omitted} chars${ref}] ...\n\n${text.slice(-half)}`;
}

function splitParagraphByLines(text: string, start: number, end: number, maxChunkChars: number) {
  const spans: Array<[number, number]> = [];
  let curStart = start, curPos = start;
  const lines = text.slice(start, end).match(/[^\n]*\n|[^\n]+/g) ?? [];
  for (const line of lines) {
    const len = line.length;
    if (curPos > curStart && curPos - curStart + len > maxChunkChars) {
      spans.push([curStart, curPos]);
      curStart = curPos;
    }
    if (len > maxChunkChars) {
      if (curPos > curStart) spans.push([curStart, curPos]);
      const lineEnd = curPos + len;
      for (let off = curPos; off < lineEnd; off += maxChunkChars) spans.push([off, Math.min(lineEnd, off + maxChunkChars)]);
      curStart = lineEnd;
    }
    curPos += len;
  }
  if (curPos > curStart) spans.push([curStart, curPos]);
  return spans;
}

function chunkTextStructurally(text: string, targetChars = 900, maxChunkChars = 1600): Chunk[] {
  if (!text) return [];
  if (text.length <= maxChunkChars) return [{ start: 0, end: text.length, text }];
  const boundaries = new Set<number>([0, text.length]);
  for (const match of text.matchAll(new RegExp(structuralSplitRe.source, "gm"))) {
    if (match.index !== undefined && match.index > 0) boundaries.add(match.index);
  }
  const sorted = [...boundaries].sort((a, b) => a - b);
  const spans: Array<[number, number]> = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const segStart = sorted[i]!, segEnd = sorted[i + 1]!;
    if (segEnd - segStart <= maxChunkChars) { spans.push([segStart, segEnd]); continue; }
    const seg = text.slice(segStart, segEnd);
    const paraCuts = new Set<number>([0, seg.length]);
    for (const match of seg.matchAll(paragraphSplitRe)) {
      if (match.index !== undefined) paraCuts.add(match.index + match[0].length);
    }
    const sortedParas = [...paraCuts].sort((a, b) => a - b);
    for (let j = 0; j < sortedParas.length - 1; j++) {
      const pStart = segStart + sortedParas[j]!, pEnd = segStart + sortedParas[j + 1]!;
      if (pEnd - pStart <= maxChunkChars) spans.push([pStart, pEnd]);
      else spans.push(...splitParagraphByLines(text, pStart, pEnd, maxChunkChars));
    }
  }
  const merged: Chunk[] = [];
  for (const [start, end] of spans) {
    if (end <= start) continue;
    const prev = merged.at(-1);
    if (prev && end - prev.start <= targetChars) {
      prev.end = end;
      prev.text = text.slice(prev.start, end);
    } else {
      merged.push({ start, end, text: text.slice(start, end) });
    }
  }
  return merged;
}

function isBinaryOrBase64(text: string) {
  if (text.length < 200 || !b64JunkRe.test(text)) return false;
  return text.replace(b64JunkRe, "").trim().length < 24;
}

/** Returns candidate chunk indices ordered by priority (pinned first/tail, then highest lexical/anomaly score). */
function preselectChunksByPriority(chunks: Chunk[], query: string, maxCandidates = 16) {
  let real = chunks.map((chunk, index) => ({ chunk, index })).filter(({ chunk }) => chunk.text.trim() && !isBinaryOrBase64(chunk.text)).map(({ index }) => index);
  if (!real.length) real = chunks.slice(0, maxCandidates).map((_, index) => index);

  const terms = new Map<string, number>();
  for (const raw of query.match(wordRe) ?? []) {
    const term = raw.toLowerCase();
    if (!stopWords.has(term)) terms.set(term, /\d|_/.test(term) || term.length >= 7 ? 2.0 : 1.0);
  }
  const pinned: number[] = [...real.slice(-2)];
  if (real.length && !pinned.includes(real[0]!)) pinned.unshift(real[0]!);
  const pinnedSet = new Set(pinned);

  const scored: Array<[number, number]> = [];
  for (const index of real) {
    if (pinnedSet.has(index)) continue;
    const ch = chunks[index]!.text;
    const low = ch.toLowerCase();
    let score = 0;
    for (const [term, weight] of terms) if (low.includes(term)) score += weight;
    if (structuredFailureRe.test(ch)) score += 4.0;
    else if (highSeverityAnomalyRe.test(ch)) score += 2.0;
    else if (anomalyRe.test(ch)) score += 1.2;
    score += Math.min(1.5, 0.35 * ((ch.match(numUnitRe) ?? []).length));
    if (structuralMarkers.some((marker) => ch.includes(marker))) score += 0.6;
    score += 0.25 * (index / Math.max(1, chunks.length - 1));
    scored.push([score, index]);
  }
  scored.sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  const slots = Math.max(0, maxCandidates - pinned.length);
  return [...pinned, ...scored.slice(0, slots).map(([, idx]) => idx)];
}

function mergeSelectedChunks(text: string, chunks: Chunk[], ranked: Array<[number, number]>, maxTotalChars: number) {
  if (!ranked.length) return { text: "", kept: 0 };
  const picked: number[] = [];
  let used = 0;
  for (const [, idx] of ranked) {
    const len = chunks[idx]!.text.length;
    if (picked.length && used + len + 40 > maxTotalChars) continue;
    picked.push(idx);
    used += len + 40;
  }
  picked.sort((a, b) => a - b);
  const ranges: Array<[number, number]> = [];
  for (const idx of picked) {
    const { start, end } = chunks[idx]!;
    const prev = ranges.at(-1);
    if (prev && start <= prev[1] + 2) prev[1] = Math.max(prev[1], end);
    else ranges.push([start, end]);
  }
  const parts: string[] = [];
  let prevEnd = 0;
  for (const [start, end] of ranges) {
    if (start > prevEnd) {
      const omitted = start - prevEnd;
      if (parts.length || omitted > 80) parts.push(`... [omitted ${omitted} chars] ...`);
    }
    const piece = text.slice(start, end).trim();
    if (piece) parts.push(piece);
    prevEnd = end;
  }
  if (prevEnd < text.length && text.length - prevEnd > 80) parts.push(`... [omitted ${text.length - prevEnd} chars] ...`);
  let joined = parts.join("\n\n");
  if (joined.length > maxTotalChars && maxTotalChars > 32) {
    const cut = joined.slice(0, maxTotalChars - 12);
    const nl = cut.lastIndexOf("\n");
    joined = `${(nl > 60 ? cut.slice(0, nl) : cut).trimEnd()}\n[trimmed]`;
  }
  return { text: joined, kept: picked.length };
}

function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  return undefined;
}

function defaultRequester(sharedDeadline?: number): D1Requester | undefined {
  const token = process.env[config.d1.tokenEnv]?.trim();
  const url = (process.env.D1_URL ?? config.d1.url).trim();
  if (!token || !url) return undefined;
  const certPath = process.env.D1_CERT_PATH ?? config.d1.certPath;
  const dispatcher = url.startsWith("https://") && certPath ? getDispatcher(certPath) : undefined;
  return async (payload, signal) => {
    const deadline = sharedDeadline ?? (Date.now() + config.d1.timeoutMs);
    const maxAttempts = 1 + config.d1.maxRetries;
    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const now = Date.now();
      if (d1CircuitOpenUntil > 0) {
        if (now < d1CircuitOpenUntil) {
          throw new Error(`d1 circuit breaker open (${Math.ceil((d1CircuitOpenUntil - now) / 1000)}s remaining)`);
        }
        d1CircuitOpenUntil = 0;
        d1Consecutive429s = 0;
      }
      const remaining = deadline - now;
      if (remaining <= 0 || signal?.aborted) break;
      const timeout = AbortSignal.timeout(remaining);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const init = {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: combined,
        ...(dispatcher ? { dispatcher } : {}),
      };
      const response = globalThis.fetch === nativeFetch
        ? await undiciFetch(url, init)
        : await globalThis.fetch(url, init);
      if (response.ok) {
        d1Consecutive429s = 0;
        d1CircuitOpenUntil = 0;
        return await response.json() as D1Response;
      }
      const status = response.status;
      const snippet = redactSecrets((await response.text().catch(() => "")).slice(0, 300));
      lastError = new Error(`d1 HTTP ${status}: ${snippet}`);
      if (status === 429) {
        d1Consecutive429s++;
        if (d1Consecutive429s >= config.d1.circuitBreakerThreshold) {
          d1CircuitOpenUntil = Date.now() + config.d1.circuitBreakerCooldownMs;
          throw lastError;
        }
      }
      const retryable = status === 429 || status === 502 || status === 503;
      if (!retryable || attempt === maxAttempts) throw lastError;
      const headerWait = retryAfterMs(response.headers.get("retry-after"));
      const baseWait = headerWait ?? Math.round(config.d1.retryBaseDelayMs * Math.pow(2, attempt - 1));
      const jitter = config.d1.retryJitterMs > 0 ? Math.floor(Math.random() * config.d1.retryJitterMs) : 0;
      const budgetLeft = deadline - Date.now() - config.d1.retryReserveMs;
      if (budgetLeft <= 0) throw lastError;
      const waitMs = Math.min(baseWait + jitter, budgetLeft);
      if (waitMs > 0) await delay(waitMs, undefined, { signal: combined });
    }
    throw lastError ?? new Error("d1 timeout exceeded");
  };
}

async function extractRelevantChunks({ text, query, instructionTemplate, maxTotalChars, maxChunks = 8, maxCandidateChunks = config.d1.maxCandidateChunks, targetChunkChars = 1000, maxChunkChars = 1800, threshold = config.d1.scoreThreshold, signal, requester }: {
  text: string; query: string; instructionTemplate: string; maxTotalChars: number;
  maxChunks?: number; maxCandidateChunks?: number; targetChunkChars?: number; maxChunkChars?: number;
  threshold?: number; signal?: AbortSignal; requester?: D1Requester;
}) {
  const started = performance.now();
  const extractionDeadlineMs = Date.now() + config.d1.timeoutMs;
  const effRequester = requester ?? defaultRequester(extractionDeadlineMs);
  if (!text || !effRequester) return { usedD1: false, text: "", kept: 0, total: 0, d1Ms: 0 };
  const safeText = redactSecrets(text);
  const safeQuery = redactSecrets(query).trim();
  const chunks = chunkTextStructurally(safeText, targetChunkChars, maxChunkChars);
  if (chunks.length <= 1) return { usedD1: false, text: "", kept: 0, total: chunks.length, d1Ms: 0 };

  // Priority-ordered candidates ensure pinned tail & top lexical/anomaly chunks are packed first.
  const candidates = preselectChunksByPriority(chunks, safeQuery, maxCandidateChunks);
  const qClean = safeQuery.length > 2400 ? `${safeQuery.slice(0, 1200)}\n...\n${safeQuery.slice(-1000)}` : safeQuery;

  const waves: Array<{ state: string; questions: Record<string, { type: "noul"; instructions: string }>; map: Map<string, number> }> = [];
  let lines: string[] = [], questions: Record<string, { type: "noul"; instructions: string }> = {}, map = new Map<string, number>(), curChars = 0;
  const maxWaves = config.d1.maxWaves;
  const waveMaxChars = config.d1.waveMaxChars;
  const waveMaxItems = config.d1.waveMaxItems;
  const flush = () => {
    if (!map.size) return;
    waves.push({ state: `QUERY:\n${qClean}\n\nITEMS:\n${lines.join("\n\n")}`, questions, map });
    lines = []; questions = {}; map = new Map(); curChars = 0;
  };
  for (const chunkIdx of candidates) {
    const chunkText = chunks[chunkIdx]!.text.trim();
    if (!chunkText) continue;
    let idx = lines.length;
    let entry = `[${idx}] ${chunkText}`;
    if (map.size && (curChars + entry.length > waveMaxChars || idx >= waveMaxItems)) {
      flush();
      if (waves.length >= maxWaves) break;
      idx = 0;
      entry = `[${idx}] ${chunkText}`;
    }
    lines.push(entry);
    const key = `i${idx}`;
    questions[key] = { type: "noul", instructions: instructionTemplate.replaceAll("{idx}", String(idx)) };
    map.set(key, chunkIdx);
    curChars += entry.length + 2;
  }
  if (waves.length < maxWaves) flush();
  if (!waves.length) return { usedD1: false, text: "", kept: 0, total: chunks.length, d1Ms: 0 };

  const remainingMs = Math.max(1, extractionDeadlineMs - Date.now());
  const extractionDeadline = AbortSignal.timeout(remainingMs);
  const waveSignal = signal ? AbortSignal.any([signal, extractionDeadline]) : extractionDeadline;
  const waveConcurrency = d1Consecutive429s > 0 ? 1 : config.d1.waveConcurrency;
  const answersList: Array<Record<string, { noul?: number; span?: number[] }> | undefined> = new Array(waves.length);
  let nextWave = 0;
  let firstError: unknown;
  const runWorker = async () => {
    while (nextWave < waves.length) {
      if (waveSignal.aborted) break;
      const idx = nextWave++;
      const { state, questions: qs } = waves[idx]!;
      try {
        const resp = await effRequester({ model: config.d1.model, state, questions: qs }, waveSignal);
        answersList[idx] = resp.answers ?? {};
      } catch (error) {
        if (firstError === undefined) firstError = error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(waveConcurrency, waves.length) }, runWorker));
  const d1Ms = Math.round(performance.now() - started);

  const scores = new Map<number, number>();
  for (let i = 0; i < waves.length; i++) {
    const ans = answersList[i];
    if (!ans) continue;
    for (const [key, chunkIdx] of waves[i]!.map) {
      const score = ans[key]?.noul;
      if (typeof score === "number" && Number.isFinite(score)) {
        const prev = scores.get(chunkIdx);
        if (prev === undefined || score > prev) scores.set(chunkIdx, score);
      }
    }
  }
  if (!scores.size) {
    if (firstError !== undefined) throw firstError;
    return { usedD1: false, text: "", kept: 0, total: chunks.length, d1Ms };
  }

  const ranked = [...scores.entries()].map(([idx, sc]) => [sc, idx] as [number, number]).sort((a, b) => b[0] - a[0]);
  const above = ranked.filter(([sc]) => sc >= threshold).slice(0, maxChunks);
  const chosen = above.length ? above : ranked.slice(0, 1);
  const merged = mergeSelectedChunks(safeText, chunks, chosen, maxTotalChars);
  return { usedD1: true, text: merged.text, kept: merged.kept, total: chunks.length, d1Ms };
}

export async function distillCommandOutput({ rawOutput, command, goal, preferStructured = true, artifactPath, sourceArtifactPath, existingArtifactPath, partialSource = false, allowReadBypass = true, minChars, maxChars, signal, log, requester }: {
  rawOutput: string; command: string; goal?: string; preferStructured?: boolean; artifactPath?: string; sourceArtifactPath?: string; existingArtifactPath?: string;
  partialSource?: boolean; allowReadBypass?: boolean;
  minChars: number; maxChars: number; signal?: AbortSignal; log?: D1Log; requester?: D1Requester;
}) {
  const cleaned = redactSecrets(stripAnsi(rawOutput));
  if (cleaned.length <= minChars || (allowReadBypass && isCodeReadCommand(command))) return { text: cleaned, filtered: false, artifactPath: undefined };

  const { blocks: structuredBlocks, total: structuredTotal } = extractStructuredFailures(cleaned);
  const anomalies = extractAnomalyLines(cleaned, 10);
  const effGoal = redactSecrets(goal?.trim() || `Key results, failing tests, exact file:line errors, tracebacks, and summary from \`${redactSecrets(command).slice(0, 140)}\``);
  const headCap = Math.min(1800, Math.max(120, Math.floor(Math.min(cleaned.length, maxChars) / 8)));
  const tailCap = Math.min(2600, Math.max(180, Math.floor(Math.min(cleaned.length, maxChars) / 6)));
  const totalLines = cleaned.split("\n").length;
  const headBlk = `## HEAD\n${cleaned.slice(0, headCap).trim()}`;
  const tailBlk = `## TAIL\n${cleaned.slice(-tailCap).trim()}`;
  const anomBlk = fitAnomalyBlock(anomalies, Math.min(1200, Math.floor(maxChars / 4)));
  const middle = cleaned.slice(headCap, Math.max(headCap, cleaned.length - tailCap));
  const plannedPath = artifactPath ?? existingArtifactPath;
  const hdrEstimate = 160 + (plannedPath?.length ?? 0);

  if (preferStructured && structuredBlocks.length && config.d1.failureBlocks.skipD1OnMatch) {
    const fixedStructOverhead = hdrEstimate + headBlk.length + tailBlk.length + 40;
    const structBudget = Math.max(0, maxChars - fixedStructOverhead);
    const fitted = fitStructuredFailureBlock(structuredBlocks, structBudget);
    if (fitted.kept > 0) {
      const formatStructured = (savedPath: string | undefined, isPartial: boolean) => {
        const label = isPartial ? "partial log" : "full output";
        const ref = savedPath ? `; ${label}: ${savedPath} (use read to inspect)` : "";
        const assemble = (body: string, keptCount: number) => {
          const hdr = `[structured failures: ${cleaned.length} chars / ${totalLines} lines -> ${keptCount}/${structuredTotal} failure block(s)${ref}]`;
          return [hdr, headBlk, body, tailBlk].filter(Boolean).join("\n\n");
        };
        let out = assemble(fitted.text, fitted.kept);
        if (out.length <= maxChars) return { text: out, kept: fitted.kept };
        const avail = maxChars - assemble("", fitted.kept).length - 4;
        const smaller = avail > 0 ? fitStructuredFailureBlock(structuredBlocks, avail) : { text: "", kept: 0 };
        out = assemble(smaller.text, smaller.kept);
        if (out.length <= maxChars) return { text: out, kept: smaller.kept };
        return { text: `${out.slice(0, Math.max(0, maxChars - 12)).trimEnd()}\n[trimmed]`, kept: smaller.kept };
      };
      const plannedPartial = partialSource && !sourceArtifactPath && plannedPath === artifactPath;
      const previewOut = formatStructured(plannedPath, plannedPartial);
      if (previewOut.text.length < cleaned.length || cleaned.length > maxChars) {
        const { savedPath, isPartial } = await persistCommandArtifact(artifactPath, cleaned, sourceArtifactPath, existingArtifactPath, partialSource);
        const finalOut = savedPath === plannedPath && isPartial === plannedPartial ? previewOut : formatStructured(savedPath, isPartial);
        log?.info?.({ event: "d1.structured_failures_extracted", rawChars: cleaned.length, outChars: finalOut.text.length, kept: finalOut.kept, total: structuredTotal });
        return { text: finalOut.text, filtered: true, artifactPath: savedPath };
      }
      return { text: cleaned, filtered: false, artifactPath: undefined };
    }
  }

  const fixedOverhead = hdrEstimate + headBlk.length + tailBlk.length + (anomBlk ? anomBlk.length + 2 : 0) + 40;
  const midBudget = Math.max(0, maxChars - fixedOverhead);

  if (middle.trim() && midBudget >= 240) {
    try {
      const result = await extractRelevantChunks({
        text: middle,
        query: effGoal,
        instructionTemplate: "Does item [{idx}] contain failing tests, errors, tracebacks, file:line locations, counts, or key conclusions answering QUERY?",
        maxTotalChars: midBudget,
        signal,
        requester,
      });
      if (result.usedD1) {
        const formatOut = (savedPath: string | undefined, isPartial: boolean) => {
          const label = isPartial ? "partial log" : "full output";
          const ref = savedPath ? `; ${label}: ${savedPath} (use read to inspect)` : "";
          const hdr = `[d1 filtered: ${cleaned.length} chars / ${totalLines} lines -> verbatim spans (${result.kept}/${result.total} middle chunks)${ref}]`;
          const assemble = (midText: string, anom: string) => {
            const parts = [hdr, headBlk];
            if (midText) parts.push(`## RELEVANT SPANS (d1)\n${midText}`);
            if (anom) parts.push(anom);
            parts.push(tailBlk);
            return parts.join("\n\n");
          };
          let out = assemble(result.text, anomBlk);
          if (out.length <= maxChars) return out;
          // Enforce maxChars strictly by trimming middle spans first, then anomaly lines if needed.
          const withoutMid = assemble("", anomBlk);
          const availMid = maxChars - withoutMid.length - "\n\n## RELEVANT SPANS (d1)\n\n[trimmed]".length;
          if (result.text && availMid >= 120) {
            const cut = result.text.slice(0, availMid);
            const nl = cut.lastIndexOf("\n");
            const trimmedMid = `${(nl > 60 ? cut.slice(0, nl) : cut).trimEnd()}\n[trimmed]`;
            out = assemble(trimmedMid, anomBlk);
            if (out.length <= maxChars) return out;
          }
          const baseNoAnom = assemble("", "");
          const availAnom = maxChars - baseNoAnom.length - 2;
          const smallerAnom = availAnom > 0 ? fitAnomalyBlock(anomalies, availAnom) : "";
          out = assemble("", smallerAnom);
          if (out.length <= maxChars) return out;
          return `${out.slice(0, Math.max(0, maxChars - 12)).trimEnd()}\n[trimmed]`;
        };
        const plannedPartial = partialSource && !sourceArtifactPath && plannedPath === artifactPath;
        const previewOut = formatOut(plannedPath, plannedPartial);
        if (previewOut.length < cleaned.length || cleaned.length > maxChars) {
          const { savedPath, isPartial } = await persistCommandArtifact(artifactPath, cleaned, sourceArtifactPath, existingArtifactPath, partialSource);
          const out = savedPath === plannedPath && isPartial === plannedPartial ? previewOut : formatOut(savedPath, isPartial);
          log?.info?.({ event: "d1.command_filtered", rawChars: cleaned.length, outChars: out.length, kept: result.kept, total: result.total, d1Ms: result.d1Ms });
          return { text: out, filtered: true, artifactPath: savedPath };
        }
        return { text: cleaned, filtered: false, artifactPath: undefined };
      }
    } catch (error) {
      log?.warn({ event: "d1.fallback", target: "command", err: redactSecrets(errorMessage(error)) });
    }
  }

  if (cleaned.length <= maxChars) return { text: cleaned, filtered: false, artifactPath: undefined };
  const { savedPath, isPartial } = await persistCommandArtifact(artifactPath, cleaned, sourceArtifactPath, existingArtifactPath, partialSource);
  const fittedStruct = structuredBlocks.length ? fitStructuredFailureBlock(structuredBlocks, Math.floor(maxChars / 2) - 2).text : "";
  const fittedAnom = fittedStruct || fitAnomalyBlock(anomalies, Math.floor(maxChars / 2) - 2);
  const anomPrefix = fittedAnom ? `${fittedAnom}\n\n` : "";
  const previewBudget = Math.max(400, maxChars - anomPrefix.length);
  const fallback = boundedPreview(cleaned, previewBudget, savedPath, isPartial);
  const text = anomPrefix ? `${anomPrefix}${fallback}` : fallback;
  return { text, filtered: true, artifactPath: savedPath };
}

export async function distillBrowserText({ rawText, url, focus, artifactPath, partialSource = false, totalSourceChars, minChars, maxChars, signal, log, requester }: {
  rawText: string; url: string; focus?: string; artifactPath?: string; partialSource?: boolean; totalSourceChars?: number;
  minChars: number; maxChars: number; signal?: AbortSignal; log?: D1Log; requester?: D1Requester;
}) {
  const cleaned = redactSecrets(rawText);
  if (cleaned.length <= minChars) return { text: cleaned, filtered: false, artifactPath: undefined };

  const query = redactSecrets(focus?.trim()
    || `Main page content, product/variant/price/cart/checkout details, interactive controls, status messages, and any errors or empty states on ${url}`);
  const topCap = Math.min(600, Math.floor(maxChars / 8));
  const top = cleaned.slice(0, topCap).trim();
  const rest = cleaned.slice(topCap);
  const partialLabel = partialSource
    ? `partial page text (first ${cleaned.length}${totalSourceChars ? ` of ${totalSourceChars}` : ""} chars)`
    : "full page text";

  const browserRefEst = artifactPath ? `; ${partialLabel}: ${artifactPath} (use read to inspect)` : partialSource ? `; ${partialLabel}` : "";
  const browserHeaderEst = `[d1 page text: ${cleaned.length} chars -> 6/99 sections${browserRefEst}]`.length + (top ? `## TOP\n${top}\n\n`.length : 0) + "## EXTRACTED SECTIONS\n\n\n".length;
  const browserBudget = Math.max(200, maxChars - browserHeaderEst);

  try {
    const result = await extractRelevantChunks({
      text: rest,
      query,
      instructionTemplate: "Does item [{idx}] contain main page content, pricing/product/cart/checkout info, errors, or details relevant to QUERY (ignoring repetitive navigation, cookie banners, and footer boilerplate)?",
      maxTotalChars: browserBudget,
      targetChunkChars: 700,
      maxChunkChars: 1400,
      maxChunks: 6,
      signal,
      requester,
    });
    if (result.usedD1 && result.text) {
      const savedPath = await persistArtifact(artifactPath, cleaned);
      const ref = savedPath ? `; ${partialLabel}: ${savedPath} (use read to inspect)` : partialSource ? `; ${partialLabel}` : "";
      const hdr = `[d1 page text: ${cleaned.length} chars -> ${result.kept}/${result.total} sections${ref}]`;
      const topBlk = top ? `## TOP\n${top}` : "";
      const assemble = (bodyText: string) => [hdr, topBlk, `## EXTRACTED SECTIONS\n${bodyText}`].filter(Boolean).join("\n\n");
      let out = assemble(result.text);
      if (out.length > maxChars) {
        const avail = maxChars - assemble("").length - 12;
        if (avail >= 80) {
          const cut = result.text.slice(0, avail);
          const nl = cut.lastIndexOf("\n");
          out = assemble(`${(nl > 40 ? cut.slice(0, nl) : cut).trimEnd()}\n[trimmed]`);
        }
        if (out.length > maxChars) out = `${out.slice(0, Math.max(0, maxChars - 12)).trimEnd()}\n[trimmed]`;
      }
      log?.info?.({ event: "d1.browser_text_filtered", rawChars: cleaned.length, outChars: out.length, kept: result.kept, total: result.total, d1Ms: result.d1Ms });
      return { text: out, filtered: true, artifactPath: savedPath };
    }
  } catch (error) {
    log?.warn({ event: "d1.fallback", target: "browser_text", err: redactSecrets(errorMessage(error)) });
  }
  if (cleaned.length > maxChars) {
    const savedPath = await persistArtifact(artifactPath, cleaned);
    return { text: boundedPreview(cleaned, maxChars, savedPath, partialSource, partialLabel), filtered: false, artifactPath: savedPath };
  }
  return { text: cleaned, filtered: false, artifactPath: undefined };
}

export async function distillHistory({ rawHistory, action, artifactPath, minChars, maxChars, signal, log, requester }: {
  rawHistory: string; action: string; artifactPath?: string;
  minChars: number; maxChars: number; signal?: AbortSignal; log?: D1Log; requester?: D1Requester;
}) {
  const cleaned = redactSecrets(rawHistory);
  if (cleaned.length <= minChars) return { text: cleaned, filtered: false, artifactPath: undefined };

  const lines = cleaned.split("\n");
  const headerEnd = lines.findIndex((line) => line.startsWith("## "));
  const header = headerEnd > 0 ? lines.slice(0, headerEnd).join("\n").trim() : "";
  const body = headerEnd > 0 ? lines.slice(headerEnd).join("\n") : cleaned;
  const histRefEst = artifactPath ? `\nFull history saved to ${artifactPath} (use read if needed).` : "";
  const histHeaderEst = (header ? `${header}\n\n`.length : 0) + `[d1 history digest: ${cleaned.length} chars -> 6/99 sections.${histRefEst}]\n\n\n`.length;
  const histBudget = Math.max(200, maxChars - histHeaderEst);

  try {
    const result = await extractRelevantChunks({
      text: body,
      query: `Recent ${action} outcomes, recurring or open breakages, material UI/behaviour changes, and coverage gaps across previous runs`,
      instructionTemplate: "Does item [{idx}] describe run outcomes, recurring/open breakages, material page/behaviour changes, or coverage gaps relevant to QUERY?",
      maxTotalChars: histBudget,
      targetChunkChars: 900,
      maxChunkChars: 1600,
      maxChunks: 6,
      signal,
      requester,
    });
    if (result.usedD1 && result.text) {
      const savedPath = await persistArtifact(artifactPath, cleaned);
      const ref = savedPath ? `\nFull history saved to ${savedPath} (use read if needed).` : "";
      const prefix = `${header ? `${header}\n\n` : ""}[d1 history digest: ${cleaned.length} chars -> ${result.kept}/${result.total} sections.${ref}]\n\n`;
      let out = `${prefix}${result.text}\n`;
      if (out.length > maxChars) {
        const avail = maxChars - prefix.length - 13;
        if (avail >= 80) {
          const cut = result.text.slice(0, avail);
          const nl = cut.lastIndexOf("\n");
          out = `${prefix}${(nl > 40 ? cut.slice(0, nl) : cut).trimEnd()}\n[trimmed]\n`;
        }
        if (out.length > maxChars) out = `${out.slice(0, Math.max(0, maxChars - 12)).trimEnd()}\n[trimmed]`;
      }
      log?.info?.({ event: "d1.history_filtered", action, rawChars: cleaned.length, outChars: out.length, kept: result.kept, total: result.total, d1Ms: result.d1Ms });
      return { text: out, filtered: true, artifactPath: savedPath };
    }
  } catch (error) {
    log?.warn({ event: "d1.fallback", target: "history", action, err: redactSecrets(errorMessage(error)) });
  }
  return { text: cleaned, filtered: false, artifactPath: undefined };
}
