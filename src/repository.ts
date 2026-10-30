import { and, eq, exists, inArray, isNotNull, isNull, notExists, or, sql, type SQL } from "drizzle-orm";
import { config } from "./config.ts";
import { db } from "./db.ts";
import { asItem } from "./items.ts";
import { items, runs, subjects, tasks, themePreviews, workspaces } from "./schema.ts";

export const remoteUrl = (repository: string) => `https://github.com/${repository}.git`;
export const sameRepository = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
export function itemRepository(item: { payload: { html_url: string } }) {
  const url = new URL(item.payload.html_url);
  if (url.hostname !== "github.com") throw new Error(`Item URL is not on github.com: ${url.href}`);
  return url.pathname.split("/").slice(1, 3).join("/");
}
export function assertConfiguredRepository(repository: string) {
  if (!sameRepository(repository, config.github.repository)) throw new Error(`Scrat serves only ${config.github.repository}, not ${repository}`);
}
const inRepository = (repository: string) => sql`lower(${subjects.repository}) = ${repository.toLowerCase()}`;
const itemRows = (where: SQL | undefined) => db.select({ item: items, subject: subjects }).from(items).innerJoin(subjects, eq(items.id, subjects.id)).where(where).all()
  .map(({ item, subject }) => asItem(item, subject));
export const openItems = (repository: string) => itemRows(and(inRepository(repository), eq(subjects.state, "open")));
export const openOrListedItems = (repository: string, externalIds: string[]) =>
  itemRows(and(inRepository(repository), or(eq(subjects.state, "open"), inArray(items.externalId, externalIds))));
export const findItem = (repository: string, target: string) =>
  itemRows(and(inRepository(repository), /^\d+$/.test(target) ? sql`${items.payload} ->> '$.number' = ${Number(target)}` : eq(items.id, target)))[0];
export function closedItemsWithCleanup(repository: string) {
  const pullRequest = eq(items.kind, "pr");
  return itemRows(and(inRepository(repository), eq(subjects.state, "closed"), or(
    exists(db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.subjectId, subjects.id), eq(tasks.status, "queued")))),
    and(pullRequest, exists(db.select({ id: workspaces.id }).from(workspaces).where(and(eq(workspaces.id, subjects.workspaceId), isNull(workspaces.removedAt),
      notExists(db.select({ id: runs.id }).from(runs).where(and(eq(runs.workspaceId, workspaces.id), isNull(runs.finishedAt)))))))),
    config.storefront.enabled ? and(pullRequest, exists(db.select({ id: themePreviews.id }).from(themePreviews)
      .where(and(eq(themePreviews.subjectId, subjects.id), or(isNull(themePreviews.deletedAt), isNotNull(themePreviews.deploymentId)))))) : undefined,
  )));
}
