import { and, desc, eq, isNotNull, isNull, ne, sql } from "drizzle-orm";
import type { Action } from "./actions.ts";
import { db } from "./db.ts";
import { type Run, runs, tasks } from "./schema.ts";

type Database = Pick<typeof db, "select">;

export const getRun = (id: string, database: Database = db) =>
  database.select().from(runs).where(eq(runs.id, id)).get();

export const updateRun = (id: string, patch: Partial<typeof runs.$inferInsert>, database: Pick<typeof db, "update"> = db) =>
  database.update(runs).set(patch).where(eq(runs.id, id)).run();

export const latestRunOfTask = (taskId: string, database: Database = db) =>
  database.select().from(runs).where(eq(runs.taskId, taskId))
    .orderBy(sql`${runs.sequence} is null desc`, desc(runs.sequence)).limit(1).get();

export const runHistory = (subjectId: string, action: Action) =>
  db.select({ run: runs, task: tasks }).from(runs)
    .innerJoin(tasks, eq(runs.taskId, tasks.id))
    .where(and(eq(tasks.subjectId, subjectId), eq(tasks.action, action)))
    .orderBy(desc(runs.sequence)).all();

export const completedRunsOfAction = (subjectId: string, action: Action): Run[] =>
  db.select({ run: runs }).from(runs).innerJoin(tasks, eq(runs.taskId, tasks.id))
    .where(and(eq(tasks.subjectId, subjectId), eq(tasks.action, action), eq(tasks.status, "completed"), isNull(runs.error)))
    .orderBy(desc(runs.sequence)).all().map(({ run }) => run);

export const latestFinishedRun = (subjectId: string) =>
  db.select({ run: runs }).from(runs).innerJoin(tasks, eq(runs.taskId, tasks.id))
    .where(and(eq(tasks.subjectId, subjectId), isNotNull(runs.finishedAt))).orderBy(desc(runs.sequence)).limit(1).get()?.run;

export const latestSessionRun = (workspaceId: string, excludeRunId: string) =>
  db.select().from(runs).where(and(
    eq(runs.workspaceId, workspaceId), ne(runs.id, excludeRunId), isNotNull(runs.piSessionFile),
  )).orderBy(desc(runs.sequence)).limit(1).get();
