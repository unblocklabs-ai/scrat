import { setTimeout } from "node:timers/promises";
import { and, eq, isNull } from "drizzle-orm";
import { config } from "./config.ts";
import { db } from "./db.ts";
import { logger } from "./logging.ts";
import { themePreviews, type ThemePreview } from "./schema.ts";
import { loggie } from "./storefront-loggie.ts";

type UserErrors = { userErrors: { field?: string[] | null; message: string }[] };
type Theme = { id: string; name: string };
type Duplicate = { themeDuplicate: UserErrors & { newTheme: Theme | null } };
type FilesPage = { nodes: { filename: string; checksumMd5: string | null }[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };

const mainThemeQuery = "query MainTheme { themes(first: 1, roles: [MAIN]) { nodes { id } } }";
const namedThemeQuery = "query NamedTheme($names: [String!]) { themes(first: 1, names: $names, roles: [UNPUBLISHED]) { nodes { id name } } }";
const duplicateMutation = "mutation DuplicateTheme($id: ID!, $name: String) { themeDuplicate(id: $id, name: $name) { newTheme { id name } userErrors { field message } } }";
const processingQuery = "query ThemeProcessing($id: ID!) { theme(id: $id) { id processing } }";
const filesQuery = "query ThemeFiles($id: ID!, $first: Int!, $after: String) { theme(id: $id) { files(first: $first, after: $after) { nodes { filename checksumMd5 } pageInfo { hasNextPage endCursor } } } }";
const deleteMutation = "mutation DeleteTheme($id: ID!) { themeDelete(id: $id) { deletedThemeId userErrors { field message } } }";

const refused = (request: string, { userErrors }: UserErrors) => Object.assign(new Error(`Shopify refused ${request}: ${userErrors.map((error) => error.message).join("; ") || "no result"}`), { code: "USER_ERRORS" });
const now = () => new Date().toISOString();

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

export async function ensurePreview(subjectId: string, number: number, stop?: AbortSignal) {
  const recorded = livePreview(subjectId), found = recorded ?? db.insert(themePreviews)
    .values({ subjectId, pullRequestNumber: number, name: `${config.storefront.preview.themeNamePrefix}pr-${number}` }).returning().get()!;
  const preview = found.themeGid ? found : await duplicate(found, Boolean(recorded), stop);
  return preview.baseline ? preview : settle(preview, stop);
}

export async function deletePreview(subjectId: string) {
  const preview = livePreview(subjectId);
  if (!preview) return;
  const id = preview.themeGid ?? (await namedTheme(preview))?.id;
  if (id) {
    const { themeDelete } = await loggie<{ themeDelete: UserErrors & { deletedThemeId: string | null } }>("themeDelete", deleteMutation, { id });
    if (!themeDelete.deletedThemeId && (await loggie<{ theme: { id: string } | null }>("theme", processingQuery, { id })).theme) throw refused("themeDelete", themeDelete);
  }
  savePreview(preview, { deletedAt: now() });
  logger.info({ event: "storefront.preview_deleted", subjectId, themeId: preview.themeId, name: preview.name });
}
