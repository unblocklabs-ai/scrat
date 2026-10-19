import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { integer, sqliteTable, text, unique, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { fetchOpenItems } from "./github.ts";
import type { JournalEvent } from "./events.ts";

type OpenItems = Awaited<ReturnType<typeof fetchOpenItems>>;

export const githubSnapshots = sqliteTable("github_snapshots", {
  id: integer("id").primaryKey(),
  repository: text("repository").notNull(),
  fetchedAt: text("fetched_at").notNull(),
  items: text("items", { mode: "json" }).$type<OpenItems["items"]>().notNull(),
  pullRequests: text("pull_requests", { mode: "json" }).$type<OpenItems["pullRequests"]>().notNull(),
});

export const items = sqliteTable("items", {
  id: text("id").primaryKey().$defaultFn(randomUUID),
  source: text("source", { enum: ["github"] }).notNull(),
  externalId: text("external_id").notNull(),
  kind: text("kind", { enum: ["issue", "pr"] }).notNull(),
  payload: text("payload", { mode: "json" })
    .$type<OpenItems["items"][number] | OpenItems["pullRequests"][number]>().notNull(),
}, (table) => [unique().on(table.source, table.externalId)]);

export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey().$defaultFn(randomUUID),
  itemId: text("item_id").notNull().references(() => items.id),
  action: text("action", { enum: ["review", "implement"] }).notNull(),
  priority: integer("priority").notNull().default(0),
  reason: text("reason").notNull(),
  input: text("input", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  status: text("status", {
    enum: ["queued", "running", "completed", "failed", "cancelled"],
  }).notNull().default("queued"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
}, (table) => [
  uniqueIndex("tasks_queued_item_action_unique")
    .on(table.itemId, table.action)
    .where(sql`${table.status} = 'queued'`),
]);

const runStages = ["preparing", "agent", "validating", "publishing"] as const;

export const runs = sqliteTable("runs", {
  id: text("id").primaryKey().$defaultFn(randomUUID),
  taskId: text("task_id").notNull().references(() => tasks.id),
  skill: text("skill").notNull(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  thinkingLevel: text("thinking_level").notNull(),
  piSessionId: text("pi_session_id"),
  mainSha: text("main_sha"),
  headSha: text("head_sha"),
  stage: text("stage", { enum: runStages }).notNull().default("preparing"),
  startedAt: text("started_at"),
  finishedAt: text("finished_at"),
  result: text("result", { mode: "json" }).$type<Record<string, unknown>>(),
  error: text("error", { mode: "json" }).$type<{
    stage: typeof runStages[number];
    message: string;
    code?: string;
    cause?: unknown;
  }>(),
  publication: text("publication", { mode: "json" }).$type<{
    status: "pending" | "published" | "not_needed";
    commentId?: number;
    commitSha?: string;
    pullRequestNumber?: number;
  }>().notNull().$defaultFn(() => ({ status: "pending" })),
});

export const events = sqliteTable("events", {
  id: integer("id").primaryKey(),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  type: text("type").$type<JournalEvent["type"]>().notNull(),
  itemId: text("item_id").references(() => items.id),
  taskId: text("task_id").references(() => tasks.id),
  runId: text("run_id").references(() => runs.id),
  data: text("data", { mode: "json" }).$type<JournalEvent["data"]>().notNull(),
});
