import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { type AnySQLiteColumn, integer, primaryKey, sqliteTable, text, unique, uniqueIndex } from "drizzle-orm/sqlite-core";
import { actionIds } from "./actions.ts";
import type { ErrorDetails } from "./errors.ts";
import type { AgentResult, Reviewer } from "./results.ts";
import type { GithubComment, GithubItem } from "./github-types.ts";

export const githubSnapshots = sqliteTable("github_snapshots", {
  id: integer("id").primaryKey(),
  repository: text("repository").notNull(),
  fetchedAt: text("fetched_at").notNull(),
  items: text("items", { mode: "json" }).$type<unknown[]>().notNull(),
  pullRequests: text("pull_requests", { mode: "json" }).$type<unknown[]>().notNull(),
});

export const items = sqliteTable("items", {
  id: text("id").primaryKey().$defaultFn(randomUUID),
  source: text("source", { enum: ["github"] }).notNull(),
  externalId: text("external_id").notNull(),
  kind: text("kind", { enum: ["issue", "pr"] }).notNull(),
  state: text("state", { enum: ["open", "closed"] }).notNull().default("open"),
  workspaceId: text("workspace_id").references(() => workspaces.id),
  selfRepairCount: integer("self_repair_count").notNull().default(0),
  payload: text("payload", { mode: "json" })
    .$type<GithubItem>().notNull(),
}, (table) => [unique().on(table.source, table.externalId)]);

export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey().$defaultFn(randomUUID),
  itemId: text("item_id").notNull().references(() => items.id),
  action: text("action", { enum: actionIds }).notNull(),
  priority: integer("priority").notNull().default(0),
  reason: text("reason").notNull(),
  input: text("input", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  retryMode: text("retry_mode", { enum: ["repair", "validation"] }).notNull().default("repair"),
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

export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  repositoryPath: text("repository_path").notNull(),
  branch: text("branch").notNull(),
  path: text("path").notNull().unique(),
  baseRef: text("base_ref").notNull(),
  baseSha: text("base_sha").notNull(),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  removedAt: text("removed_at"),
});

export const runs = sqliteTable("runs", {
  id: text("id").primaryKey().$defaultFn(randomUUID),
  taskId: text("task_id").notNull().references(() => tasks.id),
  sequence: integer("sequence"),
  retryOfRunId: text("retry_of_run_id").references((): AnySQLiteColumn => runs.id),
  inferenceFromRunId: text("inference_from_run_id").references((): AnySQLiteColumn => runs.id),
  input: text("input", { mode: "json" }).$type<Record<string, unknown>>().notNull().default({}),
  context: text("context", { mode: "json" }).$type<{
    revision: string;
    baseBranch: string;
    headSha?: string;
    item: { number: number; title: string; body?: string | null; url: string };
    comments: GithubComment[];
    commentRevisions: string[];
  }>(),
  skill: text("skill").notNull(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  thinkingLevel: text("thinking_level").notNull(),
  piSessionId: text("pi_session_id"),
  piSessionFile: text("pi_session_file"),
  workspaceId: text("workspace_id").references(() => workspaces.id),
  mainSha: text("main_sha"),
  headSha: text("head_sha"),
  stage: text("stage", { enum: runStages }).notNull().default("preparing"),
  startedAt: text("started_at"),
  finishedAt: text("finished_at"),
  reviewers: text("reviewers", { mode: "json" }).$type<Reviewer[]>().notNull().default([]),
  agentCheckpoint: text("agent_checkpoint", { mode: "json" }).$type<{
    headSha: string; treeSha: string; mergeHead: string | null;
  }>(),
  verification: text("verification", { mode: "json" }).$type<{
    headSha: string;
    commands: { command: string[]; durationMs: number; stdout: string; stderr: string }[];
  }>(),
  result: text("result", { mode: "json" }).$type<AgentResult>(),
  error: text("error", { mode: "json" }).$type<ErrorDetails>(),
  publication: text("publication", { mode: "json" }).$type<{
    status: "pending" | "published" | "not_needed";
    commentId?: number;
    commitSha?: string;
    publishedCommitSha?: string;
    scratLabel?: boolean;
    pullRequestNumber?: number;
    slackReplyTs?: string;
  }>().notNull().$defaultFn(() => ({ status: "pending" })),
}, (table) => [uniqueIndex("runs_sequence_unique").on(table.sequence)]);

export const sourceCursors = sqliteTable("source_cursors", {
  repository: text("repository").notNull(),
  action: text("action", { enum: actionIds }).notNull(),
  branch: text("branch").notNull(),
  sha: text("sha").notNull(),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
}, (table) => [primaryKey({ columns: [table.repository, table.action, table.branch] })]);

export const slackThreads = sqliteTable("slack_threads", {
  itemId: text("item_id").notNull().references(() => items.id).unique(),
  channel: text("channel").notNull(),
  ts: text("ts").notNull(),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
});

export const events = sqliteTable("events", {
  id: integer("id").primaryKey(),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  type: text("type").notNull(),
  operationId: text("operation_id"),
  itemId: text("item_id").references(() => items.id),
  taskId: text("task_id").references(() => tasks.id),
  runId: text("run_id").references(() => runs.id),
  data: text("data", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
});
