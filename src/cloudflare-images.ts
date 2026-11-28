import { lstat, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { config } from "./config.ts";
import { logger, withOperation } from "./logging.ts";
import { serialized } from "./single-flight.ts";

export type UploadedImage = { id: string; fullUrl: string; thumbUrl: string };
type Options = { runId?: string; references?: Record<string, unknown> };
type Reply = { success?: boolean; result?: { id?: string }; errors?: { message?: string }[] };

const cacheName = "uploaded-images.json";
const shotName = /^screenshot-[A-Za-z0-9_-]+\.png$/;
const locks = new Map<string, Promise<unknown>>();
const settings = () => config.media.cloudflareImages;
const trimmed = (url: string) => url.replace(/\/+$/, "");
const escaped = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/\|/g, "&#124;");

function dimensions(bytes: Buffer) {
  if (bytes.length >= 24 && bytes.readUInt32BE(0) === 0x89504e47 && bytes.toString("latin1", 12, 16) === "IHDR") return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  if (bytes.length >= 30 && bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") {
    const chunk = bytes.toString("latin1", 12, 16);
    if (chunk === "VP8X") return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
    if (chunk === "VP8 ") return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
    if (chunk === "VP8L") { const bits = bytes.readUInt32LE(21); return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) }; }
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    for (let at = 2; at + 9 <= bytes.length && bytes[at] === 0xff; at += 2 + bytes.readUInt16BE(at + 2)) {
      const marker = bytes[at + 1]!;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { width: bytes.readUInt16BE(at + 7), height: bytes.readUInt16BE(at + 5) };
    }
  }
  return undefined;
}

function endpoint(): { url: string; headers: Record<string, string> } {
  const { auth, accountId, baseUrl, loggie } = settings(), path = `accounts/${encodeURIComponent(accountId)}/images/v1`;
  if (auth === "loggie") {
    const key = process.env.LOGGIE_API_KEY;
    if (!key) throw new Error("LOGGIE_API_KEY is not set");
    return { url: `${trimmed(loggie.url)}/api/proxy/${encodeURIComponent(loggie.slug)}/${path}`, headers: { "x-api-key": key } };
  }
  const token = process.env.CLOUDFLARE_IMAGES_TOKEN;
  if (!token) throw new Error("CLOUDFLARE_IMAGES_TOKEN is not set");
  return { url: `${trimmed(baseUrl)}/${path}`, headers: { authorization: `Bearer ${token}` } };
}

function delivered(id: string): UploadedImage {
  const { deliveryBaseUrl, accountHash, variant, thumbnailVariant } = settings(), base = `${trimmed(deliveryBaseUrl)}/${accountHash}/${encodeURIComponent(id)}`;
  return { id, fullUrl: `${base}/${variant}`, thumbUrl: `${base}/${thumbnailVariant || variant}` };
}

async function upload(filePath: string, { runId, references }: Options) {
  const { maxBytes, maxDimension, timeoutSeconds } = settings(), file = basename(filePath), fields = { ...references, runId, file };
  return withOperation("media.cloudflare_images.upload", fields, async (operation) => {
    const bytes = await readFile(filePath);
    if (maxBytes > 0 && bytes.length > maxBytes) {
      operation.log.warn({ event: "media.cloudflare_images.too_large", bytes: bytes.length, maxBytes });
      operation.complete({ skipped: "maxBytes" });
      return undefined;
    }
    const size = dimensions(bytes);
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
    if (!response.ok || reply.success === false || !id) throw new Error(`Cloudflare Images refused ${file} with HTTP ${response.status}${reply.errors?.length ? `: ${reply.errors.map((error) => error.message).join("; ")}` : ""}`);
    operation.complete({ status: response.status, imageId: id });
    return delivered(id);
  });
}

async function readCache(contextDir: string): Promise<Record<string, UploadedImage>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(contextDir, cacheName), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, UploadedImage> : {};
  } catch { return {}; }
}

async function uploadAll(contextDir: string, files: string[], options: Options) {
  return serialized(locks, contextDir, async () => {
    const cache = await readCache(contextDir), missing = files.filter((file) => !cache[file]);
    let added = false;
    for (let next = 0; next < missing.length;) {
      const batch = missing.slice(next, next += settings().concurrency);
      await Promise.all(batch.map(async (file) => {
        const path = join(contextDir, file), entry = await lstat(path).catch(() => undefined);
        if (!entry?.isFile()) return;
        const image = await upload(path, options).catch((err: unknown) => { logger.warn({ ...options.references, runId: options.runId, file, event: "media.cloudflare_images.upload_failed", err }); return undefined; });
        if (image) { cache[file] = image; added = true; }
      }));
    }
    if (added) {
      const temporary = join(contextDir, `${cacheName}.${process.pid}.tmp`);
      await writeFile(temporary, JSON.stringify(cache, null, 2) + "\n", { mode: 0o600 }).then(() => rename(temporary, join(contextDir, cacheName)))
        .catch((err: unknown) => logger.warn({ ...options.references, runId: options.runId, event: "media.cloudflare_images.cache_failed", err }));
    }
    return new Map(files.flatMap((file) => cache[file] ? [[file, cache[file]] as const] : []));
  });
}

export async function uploadCloudflareImage(filePath: string, { contextDir, ...options }: Options & { contextDir: string }) {
  if (!settings().enabled) return undefined;
  const [root, target] = await Promise.all([realpath(contextDir), realpath(filePath)]).catch(() => []);
  if (!root || !target || !target.startsWith(root + sep)) throw new Error(`Refused: ${basename(filePath)} is not a file inside the run's context directory`);
  const key = relative(root, target);
  return (await uploadAll(root, [key], options)).get(key);
}

async function runScreenshots(contextDir: string) {
  const lines = (await readFile(join(contextDir, "screenshots.jsonl"), "utf8").catch(() => "")).split("\n").filter(Boolean);
  return new Set(lines.flatMap((line) => {
    try { const name = basename((JSON.parse(line) as { path?: string }).path ?? ""); return shotName.test(name) ? [name] : []; }
    catch { return []; }
  }));
}

function blocks(markdown: string) {
  const parts: { text: string; code: boolean }[] = [];
  let fence: string | undefined;
  for (const line of markdown.split(/(?<=\n)/)) {
    const marker = /^ {0,3}(`{3,}(?=[^`]*$)|~{3,})/.exec(line)?.[1], code = fence !== undefined || marker !== undefined;
    if (fence === undefined) fence = marker;
    else if (marker && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = undefined;
    const last = parts.at(-1);
    if (last?.code === code) last.text += line;
    else parts.push({ text: line, code });
  }
  return parts;
}

const reference = /!\[([^\]\n]*)\]\(\s*<?([^()\s<>]+)>?\s*\)|(`+)([^`\n]+?)\3|\[[^\]\n]*\]\([^)\n]*\)|<\/?[A-Za-z][^>\n]*>|\bhttps?:\/\/[^\s)>\]]+|(?<![\w/.~-])(\/?(?:[\w.~-]+\/)*screenshot-[A-Za-z0-9_-]+\.png)(?![\w/-])/g;

function named(target: string | undefined, allowed: Set<string>) {
  if (!target || /^[a-z][\w+.-]*:/i.test(target.trim())) return undefined;
  const name = target.trim().split("/").at(-1)!;
  return allowed.has(name) ? name : undefined;
}

function rewrite(text: string, images: Map<string, UploadedImage> | Set<string>, collect?: Set<string>) {
  const allowed = images instanceof Map ? new Set(images.keys()) : images, width = settings().thumbnailWidth;
  const thumbnail = ({ fullUrl, thumbUrl }: UploadedImage, alt: string) => `<a href="${escaped(fullUrl)}"><img src="${escaped(thumbUrl)}"${width > 0 ? ` width="${width}"` : ""} alt="${escaped(alt)}" /></a>`;
  return text.split(/(?<=\n)/).map((line) => {
    const table = line.trimStart().startsWith("|");
    return line.replace(reference, (match, alt: string | undefined, target: string | undefined, ticks: string | undefined, code: string | undefined, bare: string | undefined) => {
      const name = named(target ?? code ?? bare, allowed);
      if (!name) return match;
      collect?.add(name);
      const image = images instanceof Map ? images.get(name) : undefined;
      if (!image) return match;
      if (target !== undefined) return thumbnail(image, alt || name);
      if (table) return thumbnail(image, name);
      return ticks ? `[${match}](${image.fullUrl})` : `[\`${bare}\`](${image.fullUrl})`;
    });
  }).join("");
}

export async function embedRunScreenshots(markdown: string, contextDir: string | undefined, options: Options = {}) {
  if (!settings().enabled || !contextDir) return markdown;
  return embed(markdown, contextDir, options).catch((err: unknown) => {
    logger.warn({ ...options.references, runId: options.runId, event: "media.cloudflare_images.embed_failed", err });
    return markdown;
  });
}

async function embed(markdown: string, directory: string, options: Options) {
  const contextDir = await realpath(directory).catch(() => undefined);
  if (!contextDir) return markdown;
  const allowed = await runScreenshots(contextDir);
  if (!allowed.size) return markdown;
  const parts = blocks(markdown), referenced = new Set<string>();
  for (const part of parts) if (!part.code) rewrite(part.text, allowed, referenced);
  if (!referenced.size) return markdown;
  const images = await uploadAll(contextDir, [...referenced], options);
  if (!images.size) return markdown;
  return parts.map((part) => part.code ? part.text : rewrite(part.text, images)).join("");
}
