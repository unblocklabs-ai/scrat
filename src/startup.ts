import { access } from "node:fs/promises";
import { manifests } from "./actions.ts";
import { type Resolver, publicAnswers, resolveHost, validateBindings } from "./bindings.ts";
import { type ActionSettings, config, thinkingLevels } from "./config.ts";
import { deploymentDefaults, findTriggerConflicts, skillPath } from "./manifests.ts";
import { slugOf } from "./identity.ts";
import { logger } from "./logging.ts";
import { dropModelRuntime, sharedModelRuntime } from "./model-runtime.ts";
import { loadPlaywright } from "./scoped-tools.ts";
import { authTest } from "./slack.ts";
import { ensureRunSequences } from "./tasks.ts";

const templateVariables = new Set(["sha", "short_sha", "author", "title", "url", "branch", "count", "bot"]);

type Entry = { provider: string; model: string; thinkingLevel: string };

// @public: exported for the scenario tests, which validate alternative configurations directly.
export async function validateStaticConfig(settings: {
  harness?: { maxConcurrentValidations?: number; commandTimeoutSeconds?: number; agentTimeoutSeconds?: number; drainTimeoutSeconds?: number }; github?: { auth?: string; botLogin?: string; botName?: string }; providers?: Record<string, { apiKey?: string }>; bindings?: Record<string, unknown>; resolve?: Resolver; slack?: { enabled?: boolean; channel?: string }; workspace?: { heavyCommands?: string[]; validate?: string[][] };
  actions: Record<string, Partial<ActionSettings>>;
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
  for (const key of ["commandTimeoutSeconds", "agentTimeoutSeconds", "drainTimeoutSeconds"] as const) {
    const seconds = settings.harness?.[key];
    if (seconds !== undefined && !(Number.isSafeInteger(seconds) && seconds > 0)) problems.push(`harness.${key} must be a positive integer`);
  }
  settings.workspace?.heavyCommands?.forEach((pattern, index) => {
    try { new RegExp(pattern); } catch { problems.push(`workspace.heavyCommands[${index}] is not a valid regular expression`); }
  });
  const changeActions = manifests().filter((manifest) => manifest.mode === "change" && ({ ...deploymentDefaults(manifest), ...settings.actions[manifest.name] }).enabled !== false).map((manifest) => manifest.name);
  if (changeActions.length && !settings.workspace?.validate?.length) {
    problems.push(`workspace.validate is empty but ${changeActions.join(", ")} publish commits; list the target repository's check commands, or use [["true"]] if it has nothing to check`);
  }
  const bindingProblems = validateBindings(settings.bindings);
  problems.push(...bindingProblems);
  if (!bindingProblems.length) {
    for (const [name, binding] of Object.entries(settings.bindings ?? {})) {
      for (const host of (binding as { hosts: string[] }).hosts) {
        await publicAnswers(host, settings.resolve ?? resolveHost).then(
          (answers) => { if (!answers) logger.warn({ event: "bindings.unresolved", binding: name, host }, "Binding host does not resolve; the http tool will refuse it"); },
          (error: Error) => { problems.push(`bindings.${name}: hosts: ${error.message.replace(/^Refused: /, "")}`); },
        );
      }
    }
  }
  if (settings.slack?.enabled) {
    if (!settings.slack.channel?.trim()) problems.push("slack.channel must not be empty when slack.enabled is true");
    if (!process.env.SLACK_BOT_TOKEN) problems.push("slack.enabled is true but SLACK_BOT_TOKEN is not set");
    else await authTest().catch((error: unknown) => { problems.push(`slack: auth.test failed: ${error instanceof Error ? error.message : String(error)}`); });
  }
  for (const [name, { apiKey }] of Object.entries(settings.providers ?? {})) {
    if (apiKey && !/\$\{\w+\}/.test(apiKey)) logger.warn({ provider: name }, "Provider apiKey is not a ${VAR} placeholder; it will not be redacted from output");
  }
  for (const manifest of manifests()) {
    const action = manifest.name, entry = { ...deploymentDefaults(manifest), ...settings.actions[action] };
    checkEntry(action, entry);
    if (manifest.trigger.kind === "low_grade" && entry.maxSelfRepairs !== undefined && !(Number.isSafeInteger(entry.maxSelfRepairs) && entry.maxSelfRepairs >= 0)) {
      problems.push(`${action}: maxSelfRepairs must be a non-negative integer`);
    }
    if (manifest.trigger.kind === "low_grade" && entry.exhaustedLabel != null && typeof entry.exhaustedLabel !== "string") {
      problems.push(`${action}: exhaustedLabel must be a string, or null or "" to disable it`);
    }
    entry.reviewers?.forEach((reviewer, index) => checkEntry(`${action} reviewer ${index + 1}`, reviewer));
    if (entry.enabled !== false) {
      const slack = [...manifest.start ?? [], ...manifest.publish].some((effect) => effect.startsWith("slack_"));
      if (slack) {
        if (!process.env.SLACK_BOT_TOKEN) problems.push(`${action}: SLACK_BOT_TOKEN is not set`);
        if (!entry.channel?.trim()) problems.push(`${action}: channel must not be empty`);
        if (!entry.startMessage?.trim()) problems.push(`${action}: startMessage must not be empty`);
        if (!entry.branch?.trim()) problems.push(`${action}: branch must not be empty`);
        const unknown = [...(entry.startMessage ?? "").matchAll(/\{\{(.*?)\}\}/g)].map((match) => match[1]).filter((name) => !templateVariables.has(name));
        if (unknown.length) problems.push(`${action}: unknown startMessage variable ${unknown.map((name) => `{{${name}}}`).join(", ")}`);
      }
      if (entry.agent !== "single" && entry.agent !== "panel") problems.push(`${action}: agent must be "single" or "panel"`);
      else if (entry.agent === "panel" && entry.reviewers?.length !== 2) problems.push(`${action}: agent "panel" requires exactly two reviewers`);
      if (slack && process.env.SLACK_BOT_TOKEN) await authTest().catch((error: unknown) => { problems.push(`${action}: Slack auth.test failed: ${error instanceof Error ? error.message : String(error)}`); });
      if (manifest.browser) await loadPlaywright().catch((error: unknown) => { problems.push(`${action}: ${error instanceof Error ? error.message : String(error)}`); });
      const skill = skillPath(manifest, entry.skill);
      if (!await access(skill).then(() => true, () => false)) problems.push(`${action}: skill file not found: ${skill}`);
    }
  }
  problems.push(...findTriggerConflicts(manifests(), (manifest) => ({ ...deploymentDefaults(manifest), ...settings.actions[manifest.name] }).enabled !== false));
  if (problems.length) {
    if (modelRuntime.getError()) dropModelRuntime();
    throw new Error(`Invalid Scrat configuration:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
  }
}

export async function prepareService() {
  await validateStaticConfig();
  ensureRunSequences();
}
