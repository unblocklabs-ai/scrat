import { db } from "./db.ts";
import { itemRepository } from "./repository.ts";
import { items, subjects } from "./schema.ts";

export type Item = typeof items.$inferSelect & Pick<typeof subjects.$inferSelect, "state" | "workspaceId">;

export const asItem = (item: typeof items.$inferSelect, { state, workspaceId }: Pick<typeof subjects.$inferSelect, "state" | "workspaceId">): Item => ({ ...item, state, workspaceId });

export function upsertItem(item: Pick<typeof items.$inferInsert,
  "source" | "externalId" | "kind" | "payload"
> & { state?: typeof subjects.$inferInsert.state }, database: Pick<typeof db, "insert"> = db) {
  const state = item.state ?? "open";
  const subject = database.insert(subjects).values({ repository: itemRepository(item) ?? "", kind: "item", key: item.externalId, state })
    .onConflictDoUpdate({ target: [subjects.repository, subjects.kind, subjects.key], set: { state } }).returning().get()!;
  const row = database.insert(items).values({ id: subject.id, source: item.source, externalId: item.externalId, kind: item.kind, payload: item.payload })
    .onConflictDoUpdate({ target: [items.source, items.externalId], set: { kind: item.kind, payload: item.payload } }).returning().get()!;
  return asItem(row, subject);
}
