import { eq } from "drizzle-orm";
import { config } from "./config.ts";
import { db } from "./db.ts";
import { items } from "./schema.ts";

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
export function itemsInRepository(repository: string, source?: typeof items.$inferSelect.source) {
  const rows = source ? db.select().from(items).where(eq(items.source, source)).all() : db.select().from(items).all();
  return rows.filter((item) => sameRepository(itemRepository(item) ?? "", repository));
}
