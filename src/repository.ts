import { eq } from "drizzle-orm";
import { config } from "./config.ts";
import { db } from "./db.ts";
import { asItem } from "./items.ts";
import { items, subjects } from "./schema.ts";

export const remoteUrl = (repository: string) => `https://github.com/${repository}.git`;
export const sameRepository = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
export function itemRepository(item: { payload: { html_url: string } }) {
  try {
    const url = new URL(item.payload.html_url);
    return url.hostname === "github.com" ? url.pathname.split("/").slice(1, 3).join("/") : undefined;
  } catch { return undefined; }
}
export function assertConfiguredRepository(repository: string) {
  if (!sameRepository(repository, config.github.repository)) throw new Error(`Scrat serves only ${config.github.repository}, not ${repository}`);
}
export function itemsInRepository(repository: string) {
  return db.select({ item: items, subject: subjects }).from(items).innerJoin(subjects, eq(items.id, subjects.id)).all()
    .filter(({ subject }) => sameRepository(subject.repository, repository))
    .map(({ item, subject }) => asItem(item, subject));
}
