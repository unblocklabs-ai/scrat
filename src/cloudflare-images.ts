import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { config } from "./config.ts";
import { redactSecrets } from "./errors.ts";
import { logger, withOperation } from "./logging.ts";
import { serialized } from "./single-flight.ts";

export type UploadedImage = { id: string; fullUrl: string; thumbUrl: string };
type Options = { runId?: string; references?: Record<string, unknown> };
type Reply = { success?: boolean; result?: { id?: string }; errors?: { message?: string }[] };
type Receipt = { accountHash: string; id: string };

const shotName = /^screenshot-[A-Za-z0-9_-]+\.png$/;
const locks = new Map<string, Promise<unknown>>();
const settings = () => config.media.cloudflareImages;
const escaped = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/\|/g, "&#124;");
const safeId = (id: unknown): id is string => typeof id === "string" && /^[\w.-]+$/.test(id) && id !== "." && id !== "..";
const receiptOf = (path: string) => join(dirname(path), `.cf-image-${basename(path)}.json`);

function under(base: string, ...segments: string[]) {
  const url = new URL(base);
  url.pathname = [url.pathname.replace(/\/+$/, ""), ...segments.map(encodeURIComponent)].join("/");
  return url.href;
}

const sofMarker = (marker: number) => marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
const standalone = (marker: number) => marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8);

function jpegSize(bytes: Buffer) {
  for (let at = 2; at < bytes.length;) {
    if (bytes[at] !== 0xff) return undefined;
    while (bytes[at] === 0xff) at++;
    const marker = bytes[at++];
    if (marker === undefined || marker === 0xd9 || marker === 0xda) return undefined;
    if (standalone(marker)) continue;
    if (at + 2 > bytes.length) return undefined;
    const length = bytes.readUInt16BE(at);
    if (length < 2 || at + length > bytes.length) return undefined;
    if (sofMarker(marker)) return length >= 7 ? { width: bytes.readUInt16BE(at + 5), height: bytes.readUInt16BE(at + 3) } : undefined;
    at += length;
  }
  return undefined;
}

function dimensions(bytes: Buffer) {
  if (bytes.length >= 24 && bytes.readUInt32BE(0) === 0x89504e47 && bytes.toString("latin1", 12, 16) === "IHDR") return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  if (bytes.length >= 30 && bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") {
    const chunk = bytes.toString("latin1", 12, 16);
    if (chunk === "VP8X") return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
    if (chunk === "VP8 ") return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
    if (chunk === "VP8L") { const bits = bytes.readUInt32LE(21); return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) }; }
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return jpegSize(bytes);
  return undefined;
}

function endpoint(): { url: string; headers: Record<string, string> } {
  const { auth, accountId, baseUrl, loggie } = settings(), path = ["accounts", accountId, "images", "v1"];
  if (auth === "loggie") {
    const key = process.env.LOGGIE_API_KEY;
    if (!key) throw new Error("LOGGIE_API_KEY is not set");
    return { url: under(loggie.url, "api", "proxy", loggie.slug, ...path), headers: { "x-api-key": key } };
  }
  const token = process.env.CLOUDFLARE_IMAGES_TOKEN;
  if (!token) throw new Error("CLOUDFLARE_IMAGES_TOKEN is not set");
  return { url: under(baseUrl, ...path), headers: { authorization: `Bearer ${token}` } };
}

function delivered(id: string): UploadedImage {
  const { deliveryBaseUrl, accountHash, variant, thumbnailVariant } = settings(), url = (name: string) => under(deliveryBaseUrl, accountHash, id).concat("/", name);
  return { id, fullUrl: url(variant), thumbUrl: url(thumbnailVariant || variant) };
}

async function readReceipt(path: string) {
  const parsed = await readFile(path, "utf8").then((text) => JSON.parse(text) as Partial<Receipt>, () => undefined);
  return safeId(parsed?.id) && parsed.accountHash === settings().accountHash ? delivered(parsed.id) : undefined;
}

async function record(path: string, id: string) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify({ accountHash: settings().accountHash, id } satisfies Receipt) + "\n", { mode: 0o600 });
  try {
    try { await link(temporary, path); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const winner = await readReceipt(path);
      if (winner) return winner;
      await rename(temporary, path);
    }
    return delivered(id);
  } finally { await rm(temporary, { force: true }); }
}

async function readBounded(path: string, maxBytes: number) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0)).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT" || err.code === "ELOOP") return undefined;
    throw err;
  });
  if (!handle) return { skipped: "notFile" as const };
  try {
    const entry = await handle.stat();
    if (!entry.isFile()) return { skipped: "notFile" as const };
    if (maxBytes > 0 && entry.size > maxBytes) return { skipped: "maxBytes" as const, bytes: entry.size };
    return { bytes: await handle.readFile() };
  } finally { await handle.close(); }
}

async function upload(path: string, { runId, references }: Options) {
  const { maxBytes, maxDimension, timeoutSeconds } = settings(), file = basename(path), fields = { ...references, runId, file };
  return withOperation("media.cloudflare_images.upload", fields, async (operation) => {
    const read = await readBounded(path, maxBytes);
    if (read.skipped) {
      if (read.skipped === "maxBytes") operation.log.warn({ event: "media.cloudflare_images.too_large", bytes: read.bytes, maxBytes });
      operation.complete({ skipped: read.skipped });
      return undefined;
    }
    const { bytes } = read, size = dimensions(bytes);
    if (!size) {
      operation.log.warn({ event: "media.cloudflare_images.not_image" });
      operation.complete({ skipped: "notImage" });
      return undefined;
    }
    if (maxDimension > 0 && Math.max(size.width, size.height) > maxDimension) {
      operation.log.warn({ event: "media.cloudflare_images.too_large", ...size, maxDimension });
      operation.complete({ skipped: "maxDimension" });
      return undefined;
    }
    const { url, headers } = endpoint(), form = new FormData();
    form.append("file", new Blob([bytes]), file);
    form.append("metadata", JSON.stringify({ source: "scrat", runId, file }));
    form.append("requireSignedURLs", "false");
    operation.stage("request");
    const response = await fetch(url, { method: "POST", headers, body: form, redirect: "error", ...timeoutSeconds > 0 && { signal: AbortSignal.timeout(timeoutSeconds * 1000) } });
    const reply = await response.json().catch(() => ({})) as Reply;
    const id = reply.result?.id;
    if (!response.ok || reply.success === false || !safeId(id)) throw new Error(`Cloudflare Images refused ${file} with HTTP ${response.status}${reply.errors?.length ? `: ${reply.errors.map((error) => error.message).join("; ")}` : ""}`);
    operation.complete({ status: response.status, imageId: redactSecrets(id) });
    return id;
  });
}

async function uploadOne(path: string, options: Options) {
  const file = basename(path), fields = { ...options.references, runId: options.runId };
  if (redactSecrets(file) !== file) {
    logger.warn({ ...fields, file: redactSecrets(file), event: "media.cloudflare_images.secret_name" });
    return undefined;
  }
  const receipt = receiptOf(path);
  return serialized(locks, receipt, async () => {
    const recorded = await readReceipt(receipt);
    if (recorded) return recorded;
    const id = await upload(path, options).catch((err: unknown) => { logger.warn({ ...fields, file, event: "media.cloudflare_images.upload_failed", err }); return undefined; });
    if (!id) return undefined;
    return record(receipt, id).catch((err: unknown) => { logger.warn({ ...fields, file, event: "media.cloudflare_images.receipt_failed", err }); return undefined; });
  });
}

async function uploadAll(files: { name: string; path: string }[], options: Options) {
  const images = new Map<string, UploadedImage>();
  for (let next = 0; next < files.length;) {
    const batch = files.slice(next, next += settings().concurrency);
    await Promise.all(batch.map(async ({ name, path }) => {
      const image = await uploadOne(path, options);
      if (image) images.set(name, image);
    }));
  }
  return images;
}

export async function uploadCloudflareImage(filePath: string, { contextDir, ...options }: Options & { contextDir: string }) {
  if (!settings().enabled) return undefined;
  const [root, target] = await Promise.all([realpath(contextDir), realpath(filePath)]).catch(() => []);
  if (!root || !target || !target.startsWith(root + sep)) throw new Error(`Refused: ${basename(filePath)} is not a file inside the run's context directory`);
  const key = relative(root, target);
  return (await uploadAll([{ name: key, path: join(root, key) }], options)).get(key);
}

async function runScreenshots(contextDirs: readonly string[]) {
  const roots = [...new Set((await Promise.all(contextDirs.map((dir) => realpath(dir).catch(() => undefined)))).filter((dir) => dir !== undefined))];
  const located = new Map<string, string>();
  for (const root of roots) {
    const lines = (await readFile(join(root, "screenshots.jsonl"), "utf8").catch(() => "")).split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const name = basename((JSON.parse(line) as { path?: string }).path ?? "");
        if (shotName.test(name) && !located.has(name)) located.set(name, join(root, name));
      } catch { continue; }
    }
  }
  return located;
}

type Kind = "text" | "table" | "code";

const fenceOf = (line: string) => /^ {0,3}(`{3,}(?=[^`]*$)|~{3,})/.exec(line)?.[1];
const unquoted = (line: string) => line.replace(/^(?: {0,3}>)+ ?/, "");
const blank = (line: string) => !line.trim();
const delimiterRow = (line: string) => line.includes("|") && /^ {0,3}\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/.test(line);
const referenceDefinition = /^ {0,3}\[[^\]]+\]:/;

function blocks(markdown: string) {
  const lines = markdown.split(/(?<=\n)/), parts: { text: string; kind: Kind }[] = [];
  let fence: string | undefined, table = false, previous: Kind | "blank" = "blank";
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!, body = unquoted(line), marker = fenceOf(body);
    let kind: Kind;
    if (fence !== undefined) {
      kind = "code";
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && body.trim() === marker) fence = undefined;
    } else if (marker) { kind = "code"; fence = marker; }
    else if (/^(?: {4}|\t)/.test(line) && !blank(line) && (previous === "blank" || previous === "code") && !table) kind = "code";
    else if (referenceDefinition.test(line)) kind = "code";
    else {
      if (blank(line)) table = false;
      else if (!table && line.includes("|") && delimiterRow(lines[index + 1] ?? "")) table = true;
      else if (table && !line.includes("|")) table = false;
      kind = table ? "table" : "text";
    }
    previous = blank(line) && fence === undefined && kind !== "code" ? "blank" : kind;
    const last = parts.at(-1);
    if (last?.kind === kind) last.text += line;
    else parts.push({ text: line, kind });
  }
  return parts;
}

const reference = /!\[([^\]\n]*)\]\(\s*<?([^()\s<>]+)>?\s*\)|(`+)([^`\n]+?)\3|\[[^\]\n]*\](?:\([^)\n]*\)|\[[^\]\n]*\])|<[aA]\b[^>]*>[\s\S]*?<\/[aA]\s*>|<\/?[A-Za-z][^>\n]*>|\bhttps?:\/\/[^\s)>\]]+|(?<![\w/.~-])(\/?(?:[\w.~-]+\/)*screenshot-[A-Za-z0-9_-]+\.png)(?![\w/-])/g;

function named(target: string | undefined, allowed: ReadonlyMap<string, unknown>) {
  if (!target || /^[a-z][\w+.-]*:/i.test(target.trim())) return undefined;
  const name = target.trim().split("/").at(-1)!;
  return allowed.has(name) ? name : undefined;
}

function rewrite(text: string, table: boolean, allowed: ReadonlyMap<string, unknown>, images?: Map<string, UploadedImage>, collect?: Set<string>) {
  const width = settings().thumbnailWidth;
  const thumbnail = ({ fullUrl, thumbUrl }: UploadedImage, alt: string) => `<a href="${escaped(fullUrl)}"><img src="${escaped(thumbUrl)}"${width > 0 ? ` width="${width}"` : ""} alt="${escaped(alt)}" /></a>`;
  return text.replace(reference, (match, alt: string | undefined, target: string | undefined, ticks: string | undefined, code: string | undefined, bare: string | undefined) => {
    const name = named(target ?? code ?? bare, allowed);
    if (!name) return match;
    collect?.add(name);
    const image = images?.get(name);
    if (!image) return match;
    if (target !== undefined) return thumbnail(image, alt || name);
    if (table) return thumbnail(image, name);
    return ticks ? `[${match}](${image.fullUrl})` : `[\`${bare}\`](${image.fullUrl})`;
  });
}

export async function embedRunScreenshots(markdown: string, contextDir: string | readonly string[] | undefined, options: Options = {}) {
  const dirs = [contextDir ?? []].flat();
  if (!settings().enabled || !dirs.length) return markdown;
  return embed(markdown, dirs, options).catch((err: unknown) => {
    logger.warn({ ...options.references, runId: options.runId, event: "media.cloudflare_images.embed_failed", err });
    return markdown;
  });
}

async function embed(markdown: string, contextDirs: readonly string[], options: Options) {
  const located = await runScreenshots(contextDirs);
  if (!located.size) return markdown;
  const parts = blocks(markdown), referenced = new Set<string>();
  for (const part of parts) if (part.kind !== "code") rewrite(part.text, part.kind === "table", located, undefined, referenced);
  if (!referenced.size) return markdown;
  const images = await uploadAll([...referenced].map((name) => ({ name, path: located.get(name)! })), options);
  if (!images.size) return markdown;
  return parts.map((part) => part.kind === "code" ? part.text : rewrite(part.text, part.kind === "table", located, images)).join("");
}
