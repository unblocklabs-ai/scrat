import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { actionIds } from "./actions.ts";
import { config, configUrl, thinkingLevels } from "./config.ts";
import { db } from "./db.ts";
import { dropModelRuntime, sharedModelRuntime } from "./model-runtime.ts";
import { runs } from "./schema.ts";

type Entry = { provider: string; model: string; thinkingLevel: string };

// Fails before any worker claims, so a bad static setting stops startup instead of failing tasks one by one.
// @public: exported for the scenario tests, which validate alternative configurations directly.
export async function validateStaticConfig(settings: {
  harness?: { maxConcurrentValidations?: number }; workspace?: { blockedCommands?: string[] };
  actions: Record<string, Entry & { skill: string; reviewers?: Entry[]; maxSelfRepairs?: number }>;
} = config) {
  const modelRuntime = await sharedModelRuntime();
  const problems: string[] = [];
  const checkEntry = (label: string, { provider, model, thinkingLevel }: Entry) => {
    if (!(thinkingLevels as readonly string[]).includes(thinkingLevel)) problems.push(`${label}: invalid thinking level ${thinkingLevel}`);
    if (!modelRuntime.getModel(provider, model)) problems.push(`${label}: no Pi model ${provider}/${model}${modelRuntime.getError() ? ` (${modelRuntime.getError()})` : ""}`);
  };
  const slots = settings.harness?.maxConcurrentValidations;
  if (slots !== undefined && !(Number.isSafeInteger(slots) && slots > 0)) problems.push("harness.maxConcurrentValidations must be a positive integer");
  settings.workspace?.blockedCommands?.forEach((pattern, index) => {
    try { new RegExp(pattern); } catch { problems.push(`workspace.blockedCommands[${index}] is not a valid regular expression`); }
  });
  for (const action of actionIds) {
    const entry = settings.actions[action];
    if (!entry) { problems.push(`${action}: missing from configuration`); continue; }
    checkEntry(action, entry);
    if (action === "address_review" && entry.maxSelfRepairs !== undefined && !(Number.isSafeInteger(entry.maxSelfRepairs) && entry.maxSelfRepairs >= 0)) {
      problems.push(`${action}: maxSelfRepairs must be a non-negative integer`);
    }
    entry.reviewers?.forEach((reviewer, index) => checkEntry(`${action} reviewer ${index + 1}`, reviewer));
    const skill = fileURLToPath(new URL(entry.skill, configUrl));
    if (!await access(skill).then(() => true, () => false)) problems.push(`${action}: skill file not found: ${skill}`);
  }
  if (problems.length) {
    if (modelRuntime.getError()) dropModelRuntime();
    throw new Error(`Invalid Scrat configuration:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
  }
}

// Everything a claiming entrypoint (serve, work, run-next) does before its first claim.
export async function prepareService() {
  await validateStaticConfig();
  ensureRunSequences();
}

// Idempotent backfill for runs created before runs.sequence. Existing sequences are kept and unsequenced runs continue after the maximum:
// first runs with no run.started event (startedAt, then rowid), so they never outrank an evented run as the old event-id ordering did,
// then the rest in run.started event-id order (the old journal order).
// @public: exported for the run_sequence scenario.
export function ensureRunSequences(database: typeof db = db) {
  return database.transaction((transaction) => {
    const pending = transaction.all<{ id: string }>(sql`
      select r.id from runs r
      left join (select run_id, min(id) as event_id from events where type = 'run.started' group by run_id) e on e.run_id = r.id
      where r.sequence is null
      order by e.event_id is not null, e.event_id, r.started_at is null, r.started_at, r.rowid`);
    const { last } = transaction.get<{ last: number }>(sql`select coalesce(max(sequence), 0) as last from runs`);
    pending.forEach(({ id }, index) => transaction.update(runs).set({ sequence: last + index + 1 }).where(eq(runs.id, id)).run());
    return pending.length;
  }, { behavior: "immediate" });
}
