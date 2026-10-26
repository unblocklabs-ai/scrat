import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { upsertComment } from "./comments.ts";
import { config, isBotLogin } from "./config.ts";
import { db } from "./db.ts";
import { errorMessage, ifMissing } from "./errors.ts";
import type { EventReferences } from "./events.ts";
import { blobBytes, changedPaths, gitList } from "./git.ts";
import type { GitHubRepository } from "./github.ts";
import type { GithubComment, GithubItem } from "./github-types.ts";
import { bestEffort, logger } from "./logging.ts";
import { endsWithMarker, isIssueComment, previewMarker, withMarker } from "./markers.ts";
import { themePreviews, type ThemePreview } from "./schema.ts";
import { loggie } from "./storefront-loggie.ts";

type UserErrors = { userErrors: { field?: string[] | null; message: string }[] };
type Theme = { id: string; name: string };
type Duplicate = { themeDuplicate: UserErrors & { newTheme: Theme | null } };
type ThemeFile = { filename: string; checksumMd5: string | null };
type LiveFile = ThemeFile & { body: { content?: string; contentBase64?: string; url?: string } };
type FilesPage = { nodes: ThemeFile[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
type Target = { github: GitHubRepository; number: number; comments: GithubComment[]; references: EventReferences & { subjectId: string } };
type Revision = { repositoryPath: string; baseSha: string; headSha: string };
type Outcome = { headSha: string; problems: string[] } | { closed: string };

const mainThemeQuery = "query MainTheme { themes(first: 1, roles: [MAIN]) { nodes { id } } }";
const namedThemeQuery = "query NamedTheme($names: [String!]) { themes(first: 1, names: $names, roles: [UNPUBLISHED]) { nodes { id name } } }";
const duplicateMutation = "mutation DuplicateTheme($id: ID!, $name: String) { themeDuplicate(id: $id, name: $name) { newTheme { id name } userErrors { field message } } }";
const processingQuery = "query ThemeProcessing($id: ID!) { theme(id: $id) { id processing role } }";
const filesQuery = "query ThemeFiles($id: ID!, $first: Int!, $after: String) { theme(id: $id) { files(first: $first, after: $after) { nodes { filename checksumMd5 } pageInfo { hasNextPage endCursor } } } }";
const checksumsQuery = "query ThemeChecksums($id: ID!, $filenames: [String!], $first: Int!) { theme(id: $id) { files(filenames: $filenames, first: $first) { nodes { filename checksumMd5 } } } }";
const bodyQuery = "query ThemeBodies($id: ID!, $filenames: [String!], $first: Int!) { theme(id: $id) { files(filenames: $filenames, first: $first) { nodes { filename checksumMd5 body { ... on OnlineStoreThemeFileBodyText { content } ... on OnlineStoreThemeFileBodyBase64 { contentBase64 } ... on OnlineStoreThemeFileBodyUrl { url } } } } } }";
const upsertMutation = "mutation UpsertFiles($themeId: ID!, $files: [OnlineStoreThemeFilesUpsertFileInput!]!) { themeFilesUpsert(themeId: $themeId, files: $files) { upsertedThemeFiles { filename } userErrors { field message } } }";
const deleteFilesMutation = "mutation DeleteFiles($themeId: ID!, $files: [String!]!) { themeFilesDelete(themeId: $themeId, files: $files) { deletedThemeFiles { filename } userErrors { field message } } }";
const deleteMutation = "mutation DeleteTheme($id: ID!) { themeDelete(id: $id) { deletedThemeId userErrors { field message } } }";
const environment = "shopify-preview", unverified = "";

const refused = (request: string, { userErrors }: UserErrors) => Object.assign(new Error(`Shopify refused ${request}: ${userErrors.map((error) => error.message).join("; ") || "no result"}`), { code: "USER_ERRORS" });
const now = () => new Date().toISOString();
export const md5 = (bytes: Buffer) => createHash("md5").update(bytes).digest("hex");
const fileBody = (bytes: Buffer) => isUtf8(bytes) && !bytes.includes(0) ? { type: "TEXT", value: bytes.toString("utf8") } : { type: "BASE64", value: bytes.toString("base64") };
const previewUrl = (preview: ThemePreview) => `https://${config.storefront.publicHost}/?preview_theme_id=${preview.themeId}`;
const themeLabel = (preview: ThemePreview) => `theme \`${preview.name}\`${preview.themeId ? ` (ID ${preview.themeId})` : ""}`;

export const statePath = (...parts: string[]) => resolve("data/storefront", ...parts);

export async function readState<T>(name: string, fallback: T) {
  const text = await ifMissing(readFile(statePath(name), "utf8"), undefined);
  if (text === undefined) return fallback;
  return bestEffort(logger, "storefront.state_unreadable", { path: statePath(name) }, async () => JSON.parse(text) as T);
}

export async function writeStateText(name: string, text: string) {
  const path = statePath(name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.tmp`, text);
  await rename(`${path}.tmp`, path);
}

export const writeState = (name: string, value: unknown) => writeStateText(name, JSON.stringify(value, null, 2) + "\n");

export async function treeBlobs(repositoryPath: string, sha: string, paths: string[] = []) {
  return new Map((await gitList(repositoryPath, ["ls-tree", "-r", "-z", sha, ...paths.length ? ["--", ...paths] : []])).flatMap((entry) => {
    const tab = entry.indexOf("\t"), [mode, type, oid] = entry.slice(0, tab).split(" ");
    return type === "blob" && mode !== "120000" ? [[entry.slice(tab + 1), oid!] as const] : [];
  }));
}

const livePreview = (subjectId: string) => db.select().from(themePreviews)
  .where(and(eq(themePreviews.subjectId, subjectId), isNull(themePreviews.deletedAt))).get();

const activeDeployments = (subjectId: string) => db.select().from(themePreviews)
  .where(and(eq(themePreviews.subjectId, subjectId), isNotNull(themePreviews.deploymentId))).orderBy(themePreviews.createdAt).all();

function savePreview(preview: ThemePreview, values: Partial<ThemePreview>) {
  return db.update(themePreviews).set({ ...values, updatedAt: now() }).where(eq(themePreviews.id, preview.id)).returning().get()!;
}

async function namedTheme(preview: ThemePreview, stop?: AbortSignal) {
  const { themes } = await loggie<{ themes: { nodes: Theme[] } }>("themes", namedThemeQuery, { names: [preview.name] }, { stop });
  return themes.nodes.find((theme) => theme.name === preview.name);
}

function record(preview: ThemePreview, theme: Theme | null | undefined, event: string) {
  if (!theme) return undefined;
  const recorded = savePreview(preview, { themeGid: theme.id, themeId: Number(theme.id.split("/").at(-1)), name: theme.name });
  logger.info({ event, subjectId: preview.subjectId, themeId: recorded.themeId, name: recorded.name });
  return recorded;
}

async function duplicate(preview: ThemePreview, retried: boolean, stop?: AbortSignal) {
  const adopted = retried ? record(preview, await namedTheme(preview, stop), "storefront.preview_adopted") : undefined;
  if (adopted) return adopted;
  const { themes } = await loggie<{ themes: { nodes: { id: string }[] } }>("themes", mainThemeQuery, {}, { stop });
  const main = themes.nodes[0];
  if (!main) throw new Error("The store has no MAIN theme to duplicate");
  let reply: Duplicate;
  try { reply = await loggie<Duplicate>("themeDuplicate", duplicateMutation, { id: main.id, name: preview.name }, { stop }); }
  catch (error) {
    record(preview, (error as { data?: Partial<Duplicate> }).data?.themeDuplicate?.newTheme, "storefront.preview_created");
    throw error;
  }
  const created = record(preview, reply.themeDuplicate.newTheme, "storefront.preview_created");
  if (!created) throw refused("themeDuplicate", reply.themeDuplicate);
  return created;
}

async function readTheme<T>(preview: ThemePreview, query: string, variables: Record<string, unknown>, stop?: AbortSignal) {
  const { theme } = await loggie<{ theme: T | null }>("theme", query, { id: preview.themeGid, ...variables }, { stop });
  if (theme) return theme;
  savePreview(preview, { deletedAt: now() });
  throw new Error(`Preview theme ${preview.name} (${preview.themeId}) is gone from the store; the next review creates a new one`);
}

async function settle(preview: ThemePreview, stop?: AbortSignal) {
  const { processingWaitSeconds, processingPollSeconds, filesPageSize } = config.storefront.preview;
  const deadline = Date.now() + processingWaitSeconds * 1000;
  while ((await readTheme<{ processing: boolean }>(preview, processingQuery, {}, stop)).processing) {
    if (Date.now() + processingPollSeconds * 1000 > deadline) throw new Error(`Preview theme ${preview.name} is still processing after ${processingWaitSeconds}s; the next review waits again`);
    await setTimeout(processingPollSeconds * 1000, undefined, { signal: stop });
  }
  const baseline: Record<string, string | null> = {};
  for (let after: string | null = null, more = true; more;) {
    const { files }: { files: FilesPage } = await readTheme(preview, filesQuery, { first: filesPageSize, after }, stop);
    for (const { filename, checksumMd5 } of files.nodes) baseline[filename] = checksumMd5;
    ({ hasNextPage: more, endCursor: after } = files.pageInfo);
  }
  return savePreview(preview, { baseline });
}

export async function liveFiles(paths: string[], stop?: AbortSignal) {
  const { filesPageSize, requestTimeoutSeconds } = config.storefront.preview;
  const { themes } = await loggie<{ themes: { nodes: { id: string }[] } }>("themes", mainThemeQuery, {}, { stop });
  const id = themes.nodes[0]?.id;
  if (!id) throw new Error("The store has no MAIN theme");
  const read = async <T>(query: string, filenames: string[]) =>
    (await loggie<{ theme: { files: { nodes: T[] } } | null }>("theme", query, { id, filenames, first: filenames.length }, { stop })).theme?.files.nodes ?? [];
  const checksums = new Map<string, string | null>();
  for (let start = 0; start < paths.length; start += filesPageSize) {
    for (const { filename, checksumMd5 } of await read<ThemeFile>(checksumsQuery, paths.slice(start, start + filesPageSize))) checksums.set(filename, checksumMd5);
  }
  const bytes = async (path: string) => {
    const [file] = await read<LiveFile>(bodyQuery, [path]);
    if (!file) throw new Error(`\`${path}\` left the live theme while Scrat copied it`);
    const { content, contentBase64, url } = file.body;
    if (content !== undefined) return Buffer.from(content, "utf8");
    if (contentBase64 !== undefined) return Buffer.from(contentBase64, "base64");
    const timeout = AbortSignal.timeout(requestTimeoutSeconds * 1000);
    const response = await fetch(url!, { signal: stop ? AbortSignal.any([timeout, stop]) : timeout });
    if (!response.ok) throw new Error(`Copying \`${path}\` from the live theme failed with HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  };
  return { checksums, bytes };
}

async function syncFiles(preview: ThemePreview, { repositoryPath, baseSha, headSha }: Revision, stop?: AbortSignal) {
  const { themePaths, uploadBatch, uploadBatchBytes, requestTimeoutSeconds } = config.storefront.preview;
  const themePath = new RegExp(themePaths), synced = { ...preview.synced }, problems: string[] = [];
  const tree = await treeBlobs(repositoryPath, headSha);
  const changed = new Set((await changedPaths(repositoryPath, baseSha, headSha)).filter((path) => themePath.test(path)));
  const reverted = Object.keys(synced).filter((path) => !changed.has(path) && themePath.test(path));
  const live = reverted.length ? await liveFiles(reverted, stop) : undefined;
  const current = (path: string) => Object.hasOwn(synced, path) ? synced[path] : preview.baseline?.[path] ?? null;
  const target = async (path: string): Promise<{ bytes?: Buffer; checksum: string | null }> => {
    if (changed.has(path)) {
      const oid = tree.get(path), bytes = oid ? await blobBytes(repositoryPath, oid) : undefined;
      return { bytes, checksum: bytes ? md5(bytes) : null };
    }
    if (!live?.checksums.has(path)) return { checksum: null };
    if (live.checksums.get(path) === current(path)) return { checksum: current(path) };
    const bytes = await live.bytes(path), expected = live.checksums.get(path);
    if (expected && md5(bytes) !== expected) {
      problems.push(`\`${path}\` read from the live theme does not match its checksum, so Scrat did not copy it`);
      return { checksum: current(path) };
    }
    return { bytes, checksum: md5(bytes) };
  };
  const mark = (paths: string[]) => {
    for (const path of paths) synced[path] = unverified;
    savePreview(preview, { synced });
  };
  const verify = async (expected: Map<string, string | null>, { userErrors }: UserErrors) => {
    problems.push(...userErrors.map((error) => `Shopify: ${error.message}`));
    const { files } = await readTheme<{ files: { nodes: ThemeFile[] } }>(preview, checksumsQuery, { filenames: [...expected.keys()], first: expected.size }, stop);
    const actual = new Map(files.nodes.map(({ filename, checksumMd5 }) => [filename, checksumMd5]));
    for (const [path, checksum] of expected) {
      synced[path] = actual.get(path) ?? null;
      if (synced[path] !== checksum) problems.push(`\`${path}\` ${checksum ? "does not match the commit" : "is still in the theme"}`);
    }
    savePreview(preview, { synced });
  };
  const uploads = new Map<string, { body: ReturnType<typeof fileBody>; checksum: string }>(), deletions: string[] = [];
  let pending = 0;
  const upload = async () => {
    const batch = [...uploads];
    uploads.clear(); pending = 0;
    mark(batch.map(([path]) => path));
    const files = batch.map(([filename, { body }]) => ({ filename, body }));
    const { themeFilesUpsert } = await loggie<{ themeFilesUpsert: UserErrors }>("themeFilesUpsert", upsertMutation, { themeId: preview.themeGid, files }, { stop, timeoutSeconds: requestTimeoutSeconds });
    await verify(new Map(batch.map(([path, { checksum }]) => [path, checksum])), themeFilesUpsert);
  };
  for (const path of [...new Set([...changed, ...reverted])].sort()) {
    const { bytes, checksum } = await target(path);
    if (checksum === current(path)) continue;
    if (!bytes || !checksum) { deletions.push(path); continue; }
    const body = fileBody(bytes), size = Buffer.byteLength(body.value);
    if (uploads.size >= uploadBatch || (uploads.size && pending + size > uploadBatchBytes)) await upload();
    uploads.set(path, { body, checksum }); pending += size;
  }
  if (uploads.size) await upload();
  for (let start = 0; start < deletions.length; start += uploadBatch) {
    const batch = deletions.slice(start, start + uploadBatch);
    mark(batch);
    const { themeFilesDelete } = await loggie<{ themeFilesDelete: UserErrors }>("themeFilesDelete", deleteFilesMutation, { themeId: preview.themeGid, files: batch }, { stop });
    await verify(new Map(batch.map((path) => [path, null])), themeFilesDelete);
  }
  return problems;
}

function previewBody(preview: ThemePreview, outcome: Outcome) {
  if ("closed" in outcome) return `**Shopify preview removed:** ${outcome.closed}.`;
  const { headSha, problems } = outcome;
  return problems.length
    ? `**Shopify preview unavailable for ${headSha}:** ${themeLabel(preview)} does not match this commit.\n\n${problems.map((problem) => `- ${problem}`).join("\n")}`
    : `**Shopify preview:** ${previewUrl(preview)}\n\n${themeLabel(preview)}, synced to ${headSha}.`;
}

async function deploy({ github, number, references }: Target, preview: ThemePreview, outcome: Outcome) {
  await bestEffort(logger, "storefront.deployment_failed", { subjectId: references.subjectId, number }, async () => {
    for (const row of activeDeployments(references.subjectId)) {
      await github.setDeploymentStatus(row.deploymentId!, { state: "inactive", description: "closed" in outcome ? "The preview was removed" : "A newer preview replaced this one" }, references);
      savePreview(row, { deploymentId: null });
    }
    if ("closed" in outcome) return;
    const deploymentId = await github.createDeployment({ ref: outcome.headSha, environment, description: preview.name }, references);
    savePreview(preview, { deploymentId });
    await github.setDeploymentStatus(deploymentId, outcome.problems.length
      ? { state: "failure", description: "The preview theme does not match this commit" }
      : { state: "success", environmentUrl: previewUrl(preview), description: "The preview theme matches this commit" }, references);
  });
}

async function publish(target: Target, preview: ThemePreview, outcome: Outcome) {
  const repeated = "headSha" in outcome && preview.headSha === outcome.headSha && JSON.stringify(preview.problems) === JSON.stringify(outcome.problems);
  if (!repeated) await deploy(target, preview, outcome);
  const { github, number, comments, references } = target;
  const existing = comments.findLast((comment) => isBotLogin(comment.author) && isIssueComment(comment) && endsWithMarker(comment.body, previewMarker));
  if (existing || !("closed" in outcome)) await upsertComment(github, number, existing, withMarker(previewBody(preview, outcome), previewMarker), references);
  if ("headSha" in outcome) savePreview(preview, outcome);
}

export async function ensurePreview(target: Target, revision: Revision, stop?: AbortSignal) {
  const { subjectId } = target.references, { headSha } = revision;
  const recorded = livePreview(subjectId), found = recorded ?? db.insert(themePreviews)
    .values({ subjectId, pullRequestNumber: target.number, name: `${config.storefront.preview.themeNamePrefix}pr-${target.number}` }).returning().get()!;
  const duplicated = found.themeGid ? found : await duplicate(found, Boolean(recorded), stop);
  const preview = duplicated.baseline ? duplicated : await settle(duplicated, stop);
  if (preview.headSha === headSha && !preview.problems.length) return;
  let problems: string[];
  try {
    const { role } = await readTheme<{ role: string }>(preview, processingQuery, {}, stop);
    problems = role === "UNPUBLISHED" ? await syncFiles(preview, revision, stop) : [`${themeLabel(preview)} is no longer unpublished (role ${role}), so Scrat does not write to it`];
  } catch (error) {
    if (!stop?.aborted) {
      await bestEffort(logger, "storefront.link_failed", { subjectId }, () => publish(target, livePreview(subjectId) ?? preview, { headSha, problems: [`The sync to this commit failed (${errorMessage(error)}); the next review retries it.`] }));
    }
    throw error;
  }
  await publish(target, livePreview(subjectId) ?? preview, { headSha, problems });
}

async function removeTheme(preview: ThemePreview) {
  const id = preview.themeGid ?? (await namedTheme(preview))?.id;
  const theme = id ? (await loggie<{ theme: { role: string } | null }>("theme", processingQuery, { id })).theme : null;
  if (!id || !theme) return `${themeLabel(preview)} was already gone from the store`;
  if (theme.role !== "UNPUBLISHED") {
    logger.warn({ event: "storefront.preview_kept", subjectId: preview.subjectId, themeId: preview.themeId, name: preview.name, role: theme.role });
    return `${themeLabel(preview)} is no longer unpublished (role ${theme.role}), so Scrat left it in the store`;
  }
  const { themeDelete } = await loggie<{ themeDelete: UserErrors & { deletedThemeId: string | null } }>("themeDelete", deleteMutation, { id });
  if (!themeDelete.deletedThemeId) throw refused("themeDelete", themeDelete);
  logger.info({ event: "storefront.preview_deleted", subjectId: preview.subjectId, themeId: preview.themeId, name: preview.name });
  return `${themeLabel(preview)} was deleted when this PR closed`;
}

export async function deletePreview(github: GitHubRepository, subjectId: string, item: GithubItem) {
  const preview = livePreview(subjectId), shown = preview ?? activeDeployments(subjectId).at(-1);
  if (!shown) return;
  const closed = preview ? await removeTheme(preview) : `${themeLabel(shown)} was already gone from the store`;
  const { comments } = await github.fetchItemContext("pr", item.number, { item });
  await publish({ github, number: item.number, comments, references: { subjectId } }, shown, { closed });
  if (preview) savePreview(preview, { deletedAt: now() });
}

export function previewContext(subjectId: string, headSha: string) {
  const preview = livePreview(subjectId);
  if (preview?.headSha !== headSha) return undefined;
  const available = !preview.problems.length;
  return { url: available ? previewUrl(preview) : null, themeId: preview.themeId, headSha, available, problems: preview.problems };
}
