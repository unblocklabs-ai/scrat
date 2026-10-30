import { and, desc, eq, getTableColumns, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { db } from "./db.ts";
import type { ErrorDetails } from "./errors.ts";
import type { AgentResult } from "./results.ts";
import { items, type Run, runs, type Subject, subjects, tasks } from "./schema.ts";

type Database = Pick<typeof db, "select">;

export const getRun = (id: string, database: Database = db) =>
  database.select().from(runs).where(eq(runs.id, id)).get();

export const updateRun = (id: string, patch: Partial<typeof runs.$inferInsert>, database: Pick<typeof db, "update"> = db) =>
  database.update(runs).set(patch).where(eq(runs.id, id)).run();

export const getTask = (id: string, database: Database = db) =>
  database.select().from(tasks).where(eq(tasks.id, id)).get();

export const inferenceRunOf = (run: Run): Run => run.inferenceFromRunId ? inferenceRunOf(getRun(run.inferenceFromRunId)!) : run;

export const latestRunOfTask = (taskId: string, database: Database = db) =>
  database.select().from(runs).where(eq(runs.taskId, taskId))
    .orderBy(desc(runs.sequence)).limit(1).get();

type RunContext = NonNullable<Run["context"]>;
type HistoryRun = Omit<Run, "context" | "verification" | "reviewers" | "result" | "error"> & {
  context: Pick<RunContext, "revision" | "baseBranch" | "commentRevisions"> | null;
  result: Pick<AgentResult, "outcome" | "paths" | "grade"> | null;
  error: Pick<ErrorDetails, "code"> | null;
};

const { context: _context, verification: _verification, reviewers: _reviewers, result: _result, error: _error, ...historyColumns } = getTableColumns(runs);
const historyContext = sql<string | null>`case when ${runs.context} is null then null else json_object('revision', json_extract(${runs.context}, '$.revision'), 'baseBranch', json_extract(${runs.context}, '$.baseBranch'), 'commentRevisions', json_extract(${runs.context}, '$.commentRevisions')) end`
  .mapWith((value: string | null) => value === null ? null : JSON.parse(value) as HistoryRun["context"]);

const historyResult = sql<string | null>`case when ${runs.result} is null then null else json_object('outcome', json_extract(${runs.result}, '$.outcome'), 'paths', json_extract(${runs.result}, '$.paths'), 'grade', json_extract(${runs.result}, '$.grade')) end`
  .mapWith((value: string | null) => {
    if (value === null) return null;
    const { grade, ...result } = JSON.parse(value) as NonNullable<HistoryRun["result"]>;
    return { ...result, grade: grade ?? undefined };
  });
const historyError = sql<string | null>`case when ${runs.error} is null then null else json_object('code', json_extract(${runs.error}, '$.code')) end`
  .mapWith((value: string | null) => {
    if (value === null) return null;
    const { code } = JSON.parse(value) as { code: string | null };
    return { code: code ?? undefined };
  });

export const runText = (id: string) =>
  db.select({ text: sql<string>`json_extract(${runs.result}, '$.text')` }).from(runs).where(eq(runs.id, id)).get()!.text;

const completedOnly = and(eq(tasks.status, "completed"), isNull(runs.error));

export const runHistory = (subjectId: string, actions: string | readonly string[]) =>
  db.select({ run: { ...historyColumns, context: historyContext, result: historyResult, error: historyError }, task: tasks }).from(runs)
    .innerJoin(tasks, eq(runs.taskId, tasks.id))
    .where(and(eq(tasks.subjectId, subjectId), inArray(tasks.action, [actions].flat())))
    .orderBy(desc(runs.sequence)).all();

export const latestCompletedRun = (subjectId: string, actions: string | readonly string[]): Run | undefined =>
  db.select({ run: runs }).from(runs).innerJoin(tasks, eq(runs.taskId, tasks.id))
    .where(and(eq(tasks.subjectId, subjectId), inArray(tasks.action, [actions].flat()), completedOnly))
    .orderBy(desc(runs.sequence)).limit(1).get()?.run;

export const issueOfPullRequest = (repository: string, pullRequestNumber: number) =>
  db.select({ payload: items.payload }).from(runs).innerJoin(tasks, eq(runs.taskId, tasks.id))
    .innerJoin(subjects, eq(tasks.subjectId, subjects.id)).innerJoin(items, eq(items.id, subjects.id))
    .where(and(eq(subjects.repository, repository), eq(items.kind, "issue"), sql`json_extract(${runs.publication}, '$.pullRequestNumber') = ${pullRequestNumber}`))
    .get()?.payload;

export const completedRunsOfActionInRepository = (repository: string, action: string, limit: number): { run: Run; subject: Subject; number?: number }[] =>
  db.select({ run: runs, subject: subjects, payload: items.payload }).from(runs)
    .innerJoin(tasks, eq(runs.taskId, tasks.id)).innerJoin(subjects, eq(tasks.subjectId, subjects.id)).leftJoin(items, eq(items.id, subjects.id))
    .where(and(eq(subjects.repository, repository), eq(tasks.action, action), completedOnly))
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
