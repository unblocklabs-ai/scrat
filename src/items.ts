import { db } from "./db.ts";
import type { EventReferences } from "./events.ts";
import { logger } from "./logging.ts";
import { items } from "./schema.ts";

export function upsertItem(item: Pick<typeof items.$inferInsert,
  "source" | "externalId" | "kind" | "payload"
>, references: EventReferences = {}) {
  try {
    return db.insert(items).values(item).onConflictDoUpdate({
      target: [items.source, items.externalId],
      set: { kind: item.kind, payload: item.payload },
    }).returning().get()!;
  } catch (err) {
    logger.error({ event: "item.upsert_failed", ...references, source: item.source, externalId: item.externalId, err });
    throw err;
  }
}
