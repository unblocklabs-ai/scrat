import { db } from "./db.ts";
import { items } from "./schema.ts";

export function upsertItem(item: Pick<typeof items.$inferInsert,
  "source" | "externalId" | "kind" | "payload"
>) {
  return db.insert(items).values(item).onConflictDoUpdate({
    target: [items.source, items.externalId],
    set: { kind: item.kind, payload: item.payload },
  }).returning().get()!;
}
