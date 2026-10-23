import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const path = process.argv[2] ?? "data/scrat.sqlite";
if (!existsSync(path)) {
  console.log(JSON.stringify({ migrate: "subjects", result: "no_database" }));
  process.exit(0);
}

const db = new DatabaseSync(path);
const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
const columns = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);

if (!tables.has("items")) {
  console.log(JSON.stringify({ migrate: "subjects", result: "fresh_database" }));
  process.exit(0);
}
if (tables.has("subjects")) {
  if (columns("tasks").includes("item_id")) throw new Error("subjects exists but tasks.item_id remains: the database is half-migrated");
  console.log(JSON.stringify({ migrate: "subjects", result: "already_migrated" }));
  process.exit(0);
}

const expected = {
  items: ["id", "source", "external_id", "kind", "state", "workspace_id", "self_repair_count", "payload"],
  tasks: ["id", "item_id", "action", "priority", "reason", "input", "retry_mode", "status", "created_at"],
  events: ["id", "created_at", "type", "operation_id", "item_id", "task_id", "run_id", "data"],
  slack_threads: ["item_id", "channel", "ts", "created_at"],
};
for (const [table, names] of Object.entries(expected)) {
  if (!tables.has(table)) throw new Error(`Missing table: ${table}`);
  const actual = columns(table);
  if (actual.length !== names.length || !names.every((name) => actual.includes(name))) {
    throw new Error(`Unexpected columns on ${table}: ${actual.join(", ")}`);
  }
}

const repositoryOf = (url) => {
  try {
    const parsed = new URL(url);
    return parsed.hostname === "github.com" ? parsed.pathname.split("/").slice(1, 3).join("/") : "";
  } catch { return ""; }
};

const count = (table) => db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;

db.exec("PRAGMA foreign_keys = OFF");
db.exec("BEGIN IMMEDIATE");
try {
  const before = { items: count("items"), tasks: count("tasks"), events: count("events"), slack_threads: count("slack_threads") };

  db.exec(`
    CREATE TABLE subjects (
      id text PRIMARY KEY,
      repository text NOT NULL,
      kind text NOT NULL,
      key text NOT NULL,
      state text DEFAULT 'open' NOT NULL,
      workspace_id text,
      metadata text,
      created_at text NOT NULL,
      CONSTRAINT fk_subjects_workspace_id_workspaces_id_fk FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
      CONSTRAINT subjects_repository_kind_key_unique UNIQUE(repository, kind, key)
    );
    CREATE TEMP TABLE subject_map (item_id text PRIMARY KEY, subject_id text NOT NULL);
  `);

  const insertSubject = db.prepare("INSERT INTO subjects (id, repository, kind, key, state, workspace_id, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  const createdAt = new Date().toISOString();
  let commits = 0;
  for (const row of db.prepare("SELECT id, external_id, kind, state, workspace_id, payload FROM items").all()) {
    const payload = JSON.parse(row.payload);
    const repository = repositoryOf(payload.html_url);
    if (row.kind === "commit") {
      if (!row.external_id.startsWith("commit:")) throw new Error(`Unexpected commit external id: ${row.external_id}`);
      const metadata = JSON.stringify({ title: payload.title ?? "", author: payload.user?.login ?? "", url: payload.html_url });
      insertSubject.run(row.id, repository, "commit", row.external_id.slice("commit:".length), row.state, row.workspace_id, metadata, createdAt);
      commits++;
    } else {
      insertSubject.run(row.id, repository, "item", row.external_id, row.state, row.workspace_id, null, createdAt);
    }
  }
  db.exec("INSERT INTO subject_map (item_id, subject_id) SELECT id, id FROM subjects");

  for (const [table, filter] of [["tasks", ""], ["slack_threads", ""], ["events", "item_id IS NOT NULL AND"]]) {
    const unmapped = db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${filter} item_id NOT IN (SELECT item_id FROM subject_map)`).get().n;
    if (unmapped) throw new Error(`${unmapped} ${table} rows reference an item with no subject`);
  }

  db.exec(`
    CREATE TABLE tasks_new (
      id text PRIMARY KEY,
      subject_id text NOT NULL,
      action text NOT NULL,
      priority integer DEFAULT 0 NOT NULL,
      reason text NOT NULL,
      input text NOT NULL,
      retry_mode text DEFAULT 'repair' NOT NULL,
      retry_count integer,
      available_at text,
      status text DEFAULT 'queued' NOT NULL,
      created_at text NOT NULL,
      CONSTRAINT fk_tasks_subject_id_subjects_id_fk FOREIGN KEY (subject_id) REFERENCES subjects(id)
    );
    INSERT INTO tasks_new (id, subject_id, action, priority, reason, input, retry_mode, status, created_at)
      SELECT t.id, m.subject_id, t.action, t.priority, t.reason, t.input, t.retry_mode, t.status, t.created_at
      FROM tasks t JOIN subject_map m ON m.item_id = t.item_id;
    DROP TABLE tasks;
    ALTER TABLE tasks_new RENAME TO tasks;
    CREATE UNIQUE INDEX tasks_queued_subject_action_unique ON tasks (subject_id, action) WHERE "tasks"."status" = 'queued';

    CREATE TABLE events_new (
      id integer PRIMARY KEY,
      created_at text NOT NULL,
      type text NOT NULL,
      operation_id text,
      subject_id text,
      task_id text,
      run_id text,
      data text NOT NULL,
      CONSTRAINT fk_events_subject_id_subjects_id_fk FOREIGN KEY (subject_id) REFERENCES subjects(id),
      CONSTRAINT fk_events_task_id_tasks_id_fk FOREIGN KEY (task_id) REFERENCES tasks(id),
      CONSTRAINT fk_events_run_id_runs_id_fk FOREIGN KEY (run_id) REFERENCES runs(id)
    );
    INSERT INTO events_new (id, created_at, type, operation_id, subject_id, task_id, run_id, data)
      SELECT e.id, e.created_at, e.type, e.operation_id, m.subject_id, e.task_id, e.run_id, e.data
      FROM events e LEFT JOIN subject_map m ON m.item_id = e.item_id;
    DROP TABLE events;
    ALTER TABLE events_new RENAME TO events;

    CREATE TABLE slack_threads_new (
      subject_id text NOT NULL UNIQUE,
      channel text NOT NULL,
      ts text NOT NULL,
      created_at text NOT NULL,
      CONSTRAINT fk_slack_threads_subject_id_subjects_id_fk FOREIGN KEY (subject_id) REFERENCES subjects(id)
    );
    INSERT INTO slack_threads_new (subject_id, channel, ts, created_at)
      SELECT m.subject_id, s.channel, s.ts, s.created_at FROM slack_threads s JOIN subject_map m ON m.item_id = s.item_id;
    DROP TABLE slack_threads;
    ALTER TABLE slack_threads_new RENAME TO slack_threads;

    CREATE TABLE items_new (
      id text PRIMARY KEY,
      source text NOT NULL,
      external_id text NOT NULL,
      kind text NOT NULL,
      self_repair_count integer DEFAULT 0 NOT NULL,
      payload text NOT NULL,
      CONSTRAINT fk_items_id_subjects_id_fk FOREIGN KEY (id) REFERENCES subjects(id),
      CONSTRAINT items_source_external_id_unique UNIQUE(source, external_id)
    );
    INSERT INTO items_new (id, source, external_id, kind, self_repair_count, payload)
      SELECT id, source, external_id, kind, self_repair_count, payload FROM items WHERE kind != 'commit';
    DROP TABLE items;
    ALTER TABLE items_new RENAME TO items;
  `);

  const after = { items: count("items") + commits, tasks: count("tasks"), events: count("events"), slack_threads: count("slack_threads") };
  for (const table of Object.keys(before)) {
    if (before[table] !== after[table]) throw new Error(`Row count changed for ${table}: ${before[table]} -> ${after[table]}`);
  }
  if (count("subjects") !== before.items) throw new Error(`Expected ${before.items} subjects, found ${count("subjects")}`);
  const violations = db.prepare("PRAGMA foreign_key_check").all();
  if (violations.length) throw new Error(`Foreign key violations after migration: ${JSON.stringify(violations.slice(0, 5))}`);

  db.exec("COMMIT");
  console.log(JSON.stringify({ migrate: "subjects", result: "migrated", subjects: before.items, commits, tasks: before.tasks, events: before.events, slack_threads: before.slack_threads }));
} catch (error) {
  db.exec("ROLLBACK");
  throw error;
} finally {
  db.exec("PRAGMA foreign_keys = ON");
  db.close();
}
