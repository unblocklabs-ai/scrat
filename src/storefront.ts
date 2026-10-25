import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { and, eq, isNull } from "drizzle-orm";
import { upsertComment } from "./comments.ts";
import { config, isBotLogin } from "./config.ts";
import { db } from "./db.ts";
import type { EventReferences } from "./events.ts";
import { blobBytes, changedPaths, gitList } from "./git.ts";
import type { GitHubRepository } from "./github.ts";
import type { GithubComment, GithubItem } from "./github-types.ts";
import { logger } from "./logging.ts";
import { endsWithMarker, isIssueComment, previewMarker, withMarker } from "./markers.ts";
import { themePreviews, type ThemePreview } from "./schema.ts";
import { loggie } from "./storefront-loggie.ts";

type UserErrors = { userErrors: { field?: string[] | null; message: string }[] };
type Theme = { id: string; name: string };
type Duplicate = { themeDuplicate: UserErrors & { newTheme: Theme | null } };
type ThemeFile = { filename: string; checksumMd5: string | null };
type FilesPage = { nodes: ThemeFile[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
type Target = { github: GitHubRepository; number: number; comments: GithubComment[]; references: EventReferences & { subjectId: string } };
type Revision = { repositoryPath: string; baseSha: string; headSha: string };
type Outcome = { headSha: string; problems: string[] } | "removed";

const mainThemeQuery = "query MainTheme { themes(first: 1, roles: [MAIN]) { nodes { id } } }";
const namedThemeQuery = "query NamedTheme($names: [String!]) { themes(first: 1, names: $names, roles: [UNPUBLISHED]) { nodes { id name } } }";
const duplicateMutation = "mutation DuplicateTheme($id: ID!, $name: String) { themeDuplicate(id: $id, name: $name) { newTheme { id name } userErrors { field message } } }";
const processingQuery = "query ThemeProcessing($id: ID!) { theme(id: $id) { id processing } }";
const filesQuery = "query ThemeFiles($id: ID!, $first: Int!, $after: String) { theme(id: $id) { files(first: $first, after: $after) { nodes { filename checksumMd5 } pageInfo { hasNextPage endCursor } } } }";
const checksumsQuery = "query ThemeChecksums($id: ID!, $filenames: [String!], $first: Int!) { theme(id: $id) { files(filenames: $filenames, first: $first) { nodes { filename checksumMd5 } } } }";
const upsertMutation = "mutation UpsertFiles($themeId: ID!, $files: [OnlineStoreThemeFilesUpsertFileInput!]!) { themeFilesUpsert(themeId: $themeId, files: $files) { upsertedThemeFiles { filename } userErrors { field message } } }";
const deleteFilesMutation = "mutation DeleteFiles($themeId: ID!, $files: [String!]!) { themeFilesDelete(themeId: $themeId, files: $files) { deletedThemeFiles { filename } userErrors { field message } } }";
const deleteMutation = "mutation DeleteTheme($id: ID!) { themeDelete(id: $id) { deletedThemeId userErrors { field message } } }";
const environment = "shopify-preview";

const refused = (request: string, { userErrors }: UserErrors) => Object.assign(new Error(`Shopify refused ${request}: ${userErrors.map((error) => error.message).join("; ") || "no result"}`), { code: "USER_ERRORS" });
const now = () => new Date().toISOString();
const md5 = (bytes: Buffer) => createHash("md5").update(bytes).digest("hex");
const fileBody = (bytes: Buffer) => isUtf8(bytes) && !bytes.includes(0) ? { type: "TEXT", value: bytes.toString("utf8") } : { type: "BASE64", value: bytes.toString("base64") };
const previewUrl = (preview: ThemePreview) => `https://${config.storefront.publicHost}/?preview_theme_id=${preview.themeId}`;
const themeLabel = (preview: ThemePreview) => `theme \`${preview.name}\` (ID ${preview.themeId})`;

const livePreview = (subjectId: string) => db.select().from(themePreviews)
  .where(and(eq(themePreviews.subjectId, subjectId), isNull(themePreviews.deletedAt))).get();

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

async function syncFiles(preview: ThemePreview, { repositoryPath, baseSha, headSha }: Revision, stop?: AbortSignal) {
  const { themePaths, uploadBatch, requestTimeoutSeconds } = config.storefront.preview;
  const themePath = new RegExp(themePaths), synced = { ...preview.synced }, problems: string[] = [];
  const tree = new Map((await gitList(repositoryPath, ["ls-tree", "-r", "-z", headSha])).flatMap((entry) => {
    const tab = entry.indexOf("\t"), [mode, type, oid] = entry.slice(0, tab).split(" ");
    return type === "blob" && mode !== "120000" ? [[entry.slice(tab + 1), oid!] as const] : [];
  }));
  const paths = [...new Set([...await changedPaths(repositoryPath, baseSha, headSha), ...Object.keys(synced)])].filter((path) => themePath.test(path)).sort();
  const current = (path: string) => Object.hasOwn(synced, path) ? synced[path] : preview.baseline?.[path] ?? null;
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
  const uploads = new Map<string, { bytes: Buffer; checksum: string }>(), deletions: string[] = [];
  const upload = async () => {
    const files = [...uploads].map(([filename, { bytes }]) => ({ filename, body: fileBody(bytes) }));
    const { themeFilesUpsert } = await loggie<{ themeFilesUpsert: UserErrors }>("themeFilesUpsert", upsertMutation, { themeId: preview.themeGid, files }, { stop, timeoutSeconds: requestTimeoutSeconds });
    await verify(new Map([...uploads].map(([path, { checksum }]) => [path, checksum])), themeFilesUpsert);
    uploads.clear();
  };
  for (const path of paths) {
    const oid = tree.get(path), bytes = oid ? await blobBytes(repositoryPath, oid) : undefined, checksum = bytes ? md5(bytes) : null;
    if (checksum === current(path)) continue;
    if (bytes && checksum) uploads.set(path, { bytes, checksum });
    else deletions.push(path);
    if (uploads.size >= uploadBatch) await upload();
  }
  if (uploads.size) await upload();
  for (let start = 0; start < deletions.length; start += uploadBatch) {
    const batch = deletions.slice(start, start + uploadBatch);
    const { themeFilesDelete } = await loggie<{ themeFilesDelete: UserErrors }>("themeFilesDelete", deleteFilesMutation, { themeId: preview.themeGid, files: batch }, { stop });
    await verify(new Map(batch.map((path) => [path, null])), themeFilesDelete);
  }
  return problems;
}

function previewBody(preview: ThemePreview, outcome: Outcome) {
  if (outcome === "removed") return `**Shopify preview removed:** ${themeLabel(preview)} was deleted when this PR closed.`;
  const { headSha, problems } = outcome;
  return problems.length
    ? `**Shopify preview unavailable for ${headSha}:** ${themeLabel(preview)} does not match this commit.\n\n${problems.map((problem) => `- ${problem}`).join("\n")}`
    : `**Shopify preview:** ${previewUrl(preview)}\n\n${themeLabel(preview)}, synced to ${headSha}.`;
}

async function deploy({ github, number, references }: Target, preview: ThemePreview, outcome: Outcome) {
  let deploymentId = preview.deploymentId;
  try {
    if (outcome !== "removed") {
      deploymentId = await github.createDeployment({ ref: outcome.headSha, environment, description: preview.name }, references);
      await github.setDeploymentStatus(deploymentId, outcome.problems.length
        ? { state: "failure", description: "The preview theme does not match this commit" }
        : { state: "success", environmentUrl: previewUrl(preview), description: "The preview theme matches this commit" }, references);
    }
    if (preview.deploymentId) await github.setDeploymentStatus(preview.deploymentId, { state: "inactive", description: outcome === "removed" ? "The preview theme was deleted" : "A newer preview replaced this one" }, references);
  } catch (error) {
    logger.warn({ event: "storefront.deployment_failed", subjectId: references.subjectId, number, err: error });
  }
  return savePreview(preview, { deploymentId });
}

async function publish(target: Target, preview: ThemePreview, outcome: Outcome) {
  const deployed = await deploy(target, preview, outcome);
  const { github, number, comments, references } = target;
  const existing = comments.findLast((comment) => isBotLogin(comment.author) && isIssueComment(comment) && endsWithMarker(comment.body, previewMarker));
  if (existing || outcome !== "removed") await upsertComment(github, number, existing, withMarker(previewBody(preview, outcome), previewMarker), references);
  return deployed;
}

export async function ensurePreview(target: Target, revision: Revision, stop?: AbortSignal) {
  const { subjectId } = target.references, { headSha } = revision;
  const recorded = livePreview(subjectId), found = recorded ?? db.insert(themePreviews)
    .values({ subjectId, pullRequestNumber: target.number, name: `${config.storefront.preview.themeNamePrefix}pr-${target.number}` }).returning().get()!;
  const duplicated = found.themeGid ? found : await duplicate(found, Boolean(recorded), stop);
  const preview = duplicated.baseline ? duplicated : await settle(duplicated, stop);
  if (preview.headSha === headSha) return;
  if (duplicated.baseline) await readTheme(preview, processingQuery, {}, stop);
  let problems: string[];
  try { problems = await syncFiles(preview, revision, stop); }
  catch (error) {
    const current = livePreview(subjectId);
    if (current && !stop?.aborted) {
      await publish(target, current, { headSha, problems: ["The sync to this commit failed; the next review retries it."] })
        .catch((linkError: unknown) => logger.warn({ event: "storefront.link_failed", subjectId, err: linkError }));
    }
    throw error;
  }
  await publish(target, livePreview(subjectId)!, { headSha, problems });
  savePreview(preview, { headSha, problems });
}

export async function deletePreview(github: GitHubRepository, subjectId: string, item: GithubItem) {
  const preview = livePreview(subjectId);
  if (!preview) return;
  const id = preview.themeGid ?? (await namedTheme(preview))?.id;
  if (id) {
    const { themeDelete } = await loggie<{ themeDelete: UserErrors & { deletedThemeId: string | null } }>("themeDelete", deleteMutation, { id });
    if (!themeDelete.deletedThemeId && (await loggie<{ theme: { id: string } | null }>("theme", processingQuery, { id })).theme) throw refused("themeDelete", themeDelete);
  }
  if (preview.themeGid) {
    const { comments } = await github.fetchItemContext("pr", item.number, { item });
    await publish({ github, number: item.number, comments, references: { subjectId } }, preview, "removed");
  }
  savePreview(preview, { deletedAt: now() });
  logger.info({ event: "storefront.preview_deleted", subjectId, themeId: preview.themeId, name: preview.name });
}

export function previewContext(subjectId: string, headSha: string) {
  const preview = livePreview(subjectId);
  if (preview?.headSha !== headSha) return undefined;
  return JSON.stringify({ url: previewUrl(preview), themeId: preview.themeId, headSha, available: !preview.problems.length, problems: preview.problems }, null, 2);
}
