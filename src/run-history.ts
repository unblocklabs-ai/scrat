import { and, desc, eq, getTableColumns, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import type { Action } from "./actions.ts";
import { db } from "./db.ts";
import { items, type Run, runs, type Subject, subjects, tasks } from "./schema.ts";

type Database = Pick<typeof db, "select">;

export const getRun = (id: string, database: Database = db) =>
  database.select().from(runs).where(eq(runs.id, id)).get();

export const updateRun = (id: string, patch: Partial<typeof runs.$inferInsert>, database: Pick<typeof db, "update"> = db) =>
  database.update(runs).set(patch).where(eq(runs.id, id)).run();

export const inferenceRunOf = (run: Run): Run => run.inferenceFromRunId ? inferenceRunOf(getRun(run.inferenceFromRunId)!) : run;

export const latestRunOfTask = (taskId: string, database: Database = db) =>
  database.select().from(runs).where(eq(runs.taskId, taskId))
    .orderBy(desc(runs.sequence)).limit(1).get();

type RunContext = NonNullable<Run["context"]>;
type HistoryRun = Omit<Run, "context" | "verification"> & { context: Pick<RunContext, "revision" | "baseBranch" | "commentRevisions"> | null };

const { context: _context, verification: _verification, ...historyColumns } = getTableColumns(runs);
const historyContext = sql<string | null>`case when ${runs.context} is null then null else json_object('revision', json_extract(${runs.context}, '$.revision'), 'baseBranch', json_extract(${runs.context}, '$.baseBranch'), 'commentRevisions', json_extract(${runs.context}, '$.commentRevisions')) end`
  .mapWith((value: string | null) => value === null ? null : JSON.parse(value) as HistoryRun["context"]);

export const runHistory = (subjectId: string, actions: Action | readonly Action[]) =>
  db.select({ run: { ...historyColumns, context: historyContext }, task: tasks }).from(runs)
    .innerJoin(tasks, eq(runs.taskId, tasks.id))
    .where(and(eq(tasks.subjectId, subjectId), inArray(tasks.action, typeof actions === "string" ? [actions] : [...actions])))
    .orderBy(desc(runs.sequence)).all();

export const completedRunsOfAction = (subjectId: string, actions: Action | readonly Action[], limit = Number.MAX_SAFE_INTEGER): Run[] =>
  db.select({ run: runs }).from(runs).innerJoin(tasks, eq(runs.taskId, tasks.id))
    .where(and(eq(tasks.subjectId, subjectId), inArray(tasks.action, typeof actions === "string" ? [actions] : [...actions]), eq(tasks.status, "completed"), isNull(runs.error)))
    .orderBy(desc(runs.sequence)).limit(limit).all().map(({ run }) => run);

export const issueImplementedBy = (repository: string, pullRequestNumber: number) =>
  db.select({ payload: items.payload }).from(runs).innerJoin(tasks, eq(runs.taskId, tasks.id))
    .innerJoin(subjects, eq(tasks.subjectId, subjects.id)).innerJoin(items, eq(items.id, subjects.id))
    .where(and(eq(subjects.repository, repository), eq(items.kind, "issue"), sql`json_extract(${runs.publication}, '$.pullRequestNumber') = ${pullRequestNumber}`))
    .get()?.payload;

export const completedRunsOfActionInRepository = (repository: string, action: Action, limit: number): { run: Run; subject: Subject; number?: number }[] =>
  db.select({ run: runs, subject: subjects, payload: items.payload }).from(runs)
    .innerJoin(tasks, eq(runs.taskId, tasks.id)).innerJoin(subjects, eq(tasks.subjectId, subjects.id)).leftJoin(items, eq(items.id, subjects.id))
    .where(and(eq(subjects.repository, repository), eq(tasks.action, action), eq(tasks.status, "completed"), isNull(runs.error)))
    .orderBy(desc(runs.sequence)).limit(limit).all().map(({ run, subject, payload }) => ({ run, subject, number: payload?.number }));

export const verificationOfCommit = (headSha: string) =>
  db.select({ verification: runs.verification }).from(runs)
    .where(and(eq(runs.headSha, headSha), isNotNull(runs.verification))).orderBy(desc(runs.sequence)).limit(1).get()?.verification ?? undefined;

export const latestFinishedRun = (subjectId: string) =>
  db.select({ error: runs.error, stage: runs.stage, headSha: runs.headSha }).from(runs).innerJoin(tasks, eq(runs.taskId, tasks.id))
    .where(and(eq(tasks.subjectId, subjectId), isNotNull(runs.finishedAt))).orderBy(desc(runs.sequence)).limit(1).get();

export const latestSessionRun = (workspaceId: string, excludeRunId: string) =>
  db.select().from(runs).where(and(
    eq(runs.workspaceId, workspaceId), ne(runs.id, excludeRunId), isNotNull(runs.piSessionFile),
  )).orderBy(desc(runs.sequence)).limit(1).get();
