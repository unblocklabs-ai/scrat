import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { fetchOpenItems } from "./github.ts";

type OpenItems = Awaited<ReturnType<typeof fetchOpenItems>>;

export const githubSnapshots = sqliteTable("github_snapshots", {
  id: integer("id").primaryKey(),
  repository: text("repository").notNull(),
  fetchedAt: text("fetched_at").notNull(),
  items: text("items", { mode: "json" }).$type<OpenItems["items"]>().notNull(),
  pullRequests: text("pull_requests", { mode: "json" }).$type<OpenItems["pullRequests"]>().notNull(),
});
