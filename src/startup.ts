import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { actionIds } from "./actions.ts";
import { config, configUrl, thinkingLevels } from "./config.ts";
import { db } from "./db.ts";
import { slugOf } from "./identity.ts";
import { logger } from "./logging.ts";
import { dropModelRuntime, sharedModelRuntime } from "./model-runtime.ts";
import { runs } from "./schema.ts";
import { authTest } from "./slack.ts";

const templateVariables = new Set(["sha", "short_sha", "author", "title", "url", "branch", "count", "bot"]);

type Entry = { provider: string; model: string; thinkingLevel: string };

// @public: exported for the scenario tests, which validate alternative configurations directly.
export async function validateStaticConfig(settings: {
  harness?: { maxConcurrentValidations?: number; commandTimeoutSeconds?: number; agentTimeoutSeconds?: number }; github?: { auth?: string; botLogin?: string; botName?: string; baseBranch?: string }; providers?: Record<string, { apiKey?: string }>; workspace?: { heavyCommands?: string[] };
  actions: Record<string, Entry & { skill: string; reviewers?: Entry[]; maxSelfRepairs?: number; exhaustedLabel?: string | null; enabled?: boolean; agent?: string; channel?: string; branch?: string; startMessage?: string }>;
} = config) {
  const modelRuntime = await sharedModelRuntime();
  const problems: string[] = [];
  const checkEntry = (label: string, { provider, model, thinkingLevel }: Entry) => {
    if (!(thinkingLevels as readonly string[]).includes(thinkingLevel)) problems.push(`${label}: invalid thinking level ${thinkingLevel}`);
    if (!modelRuntime.getModel(provider, model)) problems.push(`${label}: no Pi model ${provider}/${model}${modelRuntime.getError() ? ` (${modelRuntime.getError()})` : ""}`);
  };
  const auth = settings.github?.auth;
  if (auth !== undefined && auth !== "app" && auth !== "pat") problems.push('github.auth must be "app" or "pat"');
  else if (auth === "pat" && !process.env.GITHUB_PAT) problems.push('github.auth is "pat" but GITHUB_PAT is not set');
  else if (auth !== "pat" && !process.env.GITHUB_APP_PRIVATE_KEY) problems.push('github.auth is "app" but GITHUB_APP_PRIVATE_KEY is not set');
  if (settings.github?.botLogin !== undefined && !settings.github.botLogin.trim()) problems.push("github.botLogin must not be empty");
  if (settings.github?.botName !== undefined && !/^[a-z0-9][a-z0-9-]*$/.test(slugOf(settings.github.botName))) {
    problems.push("github.botName must contain a letter or digit; its lowercase form names the selection label and the branch prefix");
  }
  const slots = settings.harness?.maxConcurrentValidations;
  if (slots !== undefined && !(Number.isSafeInteger(slots) && slots > 0)) problems.push("harness.maxConcurrentValidations must be a positive integer");
  for (const key of ["commandTimeoutSeconds", "agentTimeoutSeconds"] as const) {
    const seconds = settings.harness?.[key];
    if (seconds !== undefined && !(Number.isSafeInteger(seconds) && seconds > 0)) problems.push(`harness.${key} must be a positive integer`);
  }
  settings.workspace?.heavyCommands?.forEach((pattern, index) => {
    try { new RegExp(pattern); } catch { problems.push(`workspace.heavyCommands[${index}] is not a valid regular expression`); }
  });
  for (const [name, { apiKey }] of Object.entries(settings.providers ?? {})) {
    if (apiKey && !/\$\{\w+\}/.test(apiKey)) logger.warn({ provider: name }, "Provider apiKey is not a ${VAR} placeholder; it will not be redacted from output");
  }
  for (const action of actionIds) {
    const entry = settings.actions[action];
    if (!entry) { problems.push(`${action}: missing from configuration`); continue; }
    checkEntry(action, entry);
    if (action === "address_review" && entry.maxSelfRepairs !== undefined && !(Number.isSafeInteger(entry.maxSelfRepairs) && entry.maxSelfRepairs >= 0)) {
      problems.push(`${action}: maxSelfRepairs must be a non-negative integer`);
    }
    if (action === "address_review" && entry.exhaustedLabel != null && typeof entry.exhaustedLabel !== "string") {
      problems.push(`${action}: exhaustedLabel must be a string, or null or "" to disable it`);
    }
    entry.reviewers?.forEach((reviewer, index) => checkEntry(`${action} reviewer ${index + 1}`, reviewer));
    if (action === "review_base_change" && entry.enabled === true) {
      if (!process.env.SLACK_BOT_TOKEN) problems.push(`${action}: SLACK_BOT_TOKEN is not set`);
      if (!entry.channel?.trim()) problems.push(`${action}: channel must not be empty`);
      if (entry.branch !== settings.github?.baseBranch) problems.push(`${action}: branch must equal github.baseBranch`);
      const unknown = [...(entry.startMessage ?? "").matchAll(/\{\{(.*?)\}\}/g)].map((match) => match[1]).filter((name) => !templateVariables.has(name));
      if (unknown.length) problems.push(`${action}: unknown startMessage variable ${unknown.map((name) => `{{${name}}}`).join(", ")}`);
      if (entry.agent !== "single" && entry.agent !== "panel") problems.push(`${action}: agent must be "single" or "panel"`);
      else if (entry.agent === "panel" && entry.reviewers?.length !== 2) problems.push(`${action}: agent "panel" requires exactly two reviewers`);
      if (process.env.SLACK_BOT_TOKEN) await authTest().catch((error: unknown) => { problems.push(`${action}: Slack auth.test failed: ${error instanceof Error ? error.message : String(error)}`); });
    }
    const skill = fileURLToPath(new URL(entry.skill, configUrl));
    if (entry.enabled !== false && !await access(skill).then(() => true, () => false)) problems.push(`${action}: skill file not found: ${skill}`);
  }
  if (problems.length) {
    if (modelRuntime.getError()) dropModelRuntime();
    throw new Error(`Invalid Scrat configuration:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
  }
}

export async function prepareService() {
  await validateStaticConfig();
  ensureRunSequences();
}

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
