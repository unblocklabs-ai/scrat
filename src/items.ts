import { db } from "./db.ts";
import { itemRepository } from "./repository.ts";
import { items, type Item as ItemRow, subjects, type Subject } from "./schema.ts";

export type Item = ItemRow & Pick<Subject, "state" | "workspaceId">;

export const asItem = (item: ItemRow, { state, workspaceId }: Pick<Subject, "state" | "workspaceId">): Item => ({ ...item, state, workspaceId });

export function upsertSubject(values: Omit<typeof subjects.$inferInsert, "state">, state: typeof subjects.$inferInsert.state = "open", database: Pick<typeof db, "insert"> = db) {
  return database.insert(subjects).values({ ...values, state })
    .onConflictDoUpdate({ target: [subjects.repository, subjects.kind, subjects.key], set: { state } }).returning().get()!;
}

export function upsertItem(item: Pick<typeof items.$inferInsert,
  "externalId" | "kind" | "payload"
> & { state?: typeof subjects.$inferInsert.state }, database: Pick<typeof db, "insert"> = db) {
  const state = item.state ?? "open";
  const subject = upsertSubject({ repository: itemRepository(item) ?? "", kind: "item", key: item.externalId }, state, database);
  const row = database.insert(items).values({ id: subject.id, externalId: item.externalId, kind: item.kind, payload: item.payload })
    .onConflictDoUpdate({ target: items.externalId, set: { kind: item.kind, payload: item.payload } }).returning().get()!;
  return asItem(row, subject);
}
