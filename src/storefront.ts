import { setTimeout } from "node:timers/promises";
import { and, eq, isNull } from "drizzle-orm";
import { config } from "./config.ts";
import { db } from "./db.ts";
import { logger } from "./logging.ts";
import { themePreviews, type ThemePreview } from "./schema.ts";
import { LoggieError, loggie } from "./storefront-loggie.ts";

type UserErrors = { userErrors: { field?: string[] | null; message: string }[] };
type FilesPage = { nodes: { filename: string; checksumMd5: string | null }[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };

const mainThemeQuery = "query MainTheme { themes(first: 1, roles: [MAIN]) { nodes { id } } }";
const duplicateMutation = "mutation DuplicateTheme($id: ID!, $name: String) { themeDuplicate(id: $id, name: $name) { newTheme { id name } userErrors { field message } } }";
const processingQuery = "query ThemeProcessing($id: ID!) { theme(id: $id) { id processing } }";
const filesQuery = "query ThemeFiles($id: ID!, $first: Int!, $after: String) { theme(id: $id) { files(first: $first, after: $after) { nodes { filename checksumMd5 } pageInfo { hasNextPage endCursor } } } }";
const deleteMutation = "mutation DeleteTheme($id: ID!) { themeDelete(id: $id) { deletedThemeId userErrors { field message } } }";

const refused = (request: string, { userErrors }: UserErrors) => new LoggieError(`Shopify refused ${request}: ${userErrors.map((error) => error.message).join("; ") || "no result"}`, "USER_ERRORS", 200);
const now = () => new Date().toISOString();

const livePreview = (subjectId: string) => db.select().from(themePreviews)
  .where(and(eq(themePreviews.subjectId, subjectId), isNull(themePreviews.deletedAt))).get();

function markDeleted(preview: ThemePreview) {
  const at = now();
  db.update(themePreviews).set({ deletedAt: at, updatedAt: at }).where(eq(themePreviews.id, preview.id)).run();
}

async function createPreview(subjectId: string, number: number) {
  const { themes } = await loggie<{ themes: { nodes: { id: string }[] } }>("themes", mainThemeQuery);
  const main = themes.nodes[0];
  if (!main) throw new Error("The store has no MAIN theme to duplicate");
  const name = `${config.storefront.preview.themeNamePrefix}pr-${number}`;
  const { themeDuplicate } = await loggie<{ themeDuplicate: UserErrors & { newTheme: { id: string; name: string } | null } }>("themeDuplicate", duplicateMutation, { id: main.id, name });
  const theme = themeDuplicate.newTheme;
  if (!theme || themeDuplicate.userErrors.length) throw refused("themeDuplicate", themeDuplicate);
  const preview = db.insert(themePreviews).values({
    subjectId, pullRequestNumber: number, themeGid: theme.id, themeId: Number(theme.id.split("/").at(-1)), name: theme.name,
  }).returning().get()!;
  logger.info({ event: "storefront.preview_created", subjectId, themeId: preview.themeId, name: preview.name });
  return preview;
}

async function readTheme<T>(preview: ThemePreview, query: string, variables: Record<string, unknown> = {}) {
  const { theme } = await loggie<{ theme: T | null }>("theme", query, { id: preview.themeGid, ...variables });
  if (theme) return theme;
  markDeleted(preview);
  throw new Error(`Preview theme ${preview.name} (${preview.themeId}) is gone from the store; the next review creates a new one`);
}

async function settle(preview: ThemePreview, stop?: AbortSignal) {
  const { processingWaitSeconds, processingPollSeconds, filesPageSize } = config.storefront.preview;
  const deadline = Date.now() + processingWaitSeconds * 1000;
  while ((await readTheme<{ processing: boolean }>(preview, processingQuery)).processing) {
    if (Date.now() + processingPollSeconds * 1000 > deadline) throw new Error(`Preview theme ${preview.name} is still processing after ${processingWaitSeconds}s; the next review waits again`);
    await setTimeout(processingPollSeconds * 1000, undefined, { signal: stop });
  }
  const baseline: Record<string, string | null> = {};
  for (let after: string | null = null, more = true; more;) {
    const { files }: { files: FilesPage } = await readTheme(preview, filesQuery, { first: filesPageSize, after });
    for (const { filename, checksumMd5 } of files.nodes) baseline[filename] = checksumMd5;
    ({ hasNextPage: more, endCursor: after } = files.pageInfo);
  }
  return db.update(themePreviews).set({ baseline, updatedAt: now() }).where(eq(themePreviews.id, preview.id)).returning().get()!;
}

export async function ensurePreview(subjectId: string, number: number, stop?: AbortSignal) {
  const preview = livePreview(subjectId) ?? await createPreview(subjectId, number);
  return preview.baseline ? preview : settle(preview, stop);
}

export async function deletePreview(subjectId: string) {
  const preview = livePreview(subjectId);
  if (!preview) return;
  const { themeDelete } = await loggie<{ themeDelete: UserErrors & { deletedThemeId: string | null } }>("themeDelete", deleteMutation, { id: preview.themeGid });
  if (!themeDelete.deletedThemeId && (await loggie<{ theme: { id: string } | null }>("theme", processingQuery, { id: preview.themeGid })).theme) throw refused("themeDelete", themeDelete);
  markDeleted(preview);
  logger.info({ event: "storefront.preview_deleted", subjectId, themeId: preview.themeId, name: preview.name });
}
