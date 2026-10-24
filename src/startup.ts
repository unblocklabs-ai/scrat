import { access, lstat, mkdir } from "node:fs/promises";
import { manifests } from "./actions.ts";
import { type Resolver, publicAnswers, resolveHost, validateBindings } from "./bindings.ts";
import { config } from "./config.ts";
import type { ActionSettings, ScratConfig } from "./config-schema.ts";
import { deploymentDefaults, skillPath } from "./manifests.ts";
import { slugOf } from "./identity.ts";
import { logger } from "./logging.ts";
import { errorMessage } from "./errors.ts";
import { dropModelRuntime, sharedModelRuntime } from "./model-runtime.ts";
import { loadPlaywright } from "./scoped-tools.ts";
import { authTest } from "./slack.ts";

const templateVariables = new Set(["sha", "short_sha", "author", "title", "url", "branch", "count", "bot"]);

type Entry = { provider: string; model: string };

// @public: exported for the scenario tests, which validate alternative configurations directly.
export async function validateStaticConfig(settings: Omit<Partial<ScratConfig>, "actions"> & { resolve?: Resolver; actions: Record<string, Partial<ActionSettings>> } = config) {
  const modelRuntime = await sharedModelRuntime();
  const problems: string[] = [];
  if (settings.workspace?.sandbox) {
    if (process.platform !== "linux") problems.push("workspace.sandbox requires Linux bubblewrap");
    else await access("/usr/bin/bwrap").catch(() => { problems.push("workspace.sandbox requires /usr/bin/bwrap"); });
  }
  const memoryMax = settings.workspace?.commandMemoryMax;
  if (memoryMax) {
    if (!settings.workspace?.sandbox) problems.push("workspace.commandMemoryMax requires workspace.sandbox");
    else if (process.platform === "linux") await access("/usr/bin/systemd-run").catch(() => { problems.push("workspace.commandMemoryMax requires /usr/bin/systemd-run"); });
  }
  const store = settings.workspace?.packageStore;
  if (store) {
    if (!settings.workspace?.sandbox) problems.push("workspace.packageStore requires workspace.sandbox");
    else if (await lstat(store).then((entry) => entry.isSymbolicLink(), () => false)) problems.push("workspace.packageStore must not be a symlink");
    else if (process.platform === "linux") await mkdir(store, { recursive: true, mode: 0o700 }).catch(() => { problems.push(`workspace.packageStore ${store} cannot be created`); });
  }
  const checkEntry = (label: string, { provider, model }: Entry) => {
    if (!modelRuntime.getModel(provider, model)) problems.push(`${label}: no Pi model ${provider}/${model}${modelRuntime.getError() ? ` (${modelRuntime.getError()})` : ""}`);
  };
  if (settings.github?.auth === "pat") { if (!process.env.GITHUB_PAT) problems.push('github.auth is "pat" but GITHUB_PAT is not set'); }
  else if (!process.env.GITHUB_APP_PRIVATE_KEY) problems.push('github.auth is "app" but GITHUB_APP_PRIVATE_KEY is not set');
  if (settings.github?.botLogin !== undefined && !settings.github.botLogin.trim()) problems.push("github.botLogin must not be empty");
  if (settings.github?.botName !== undefined && !/^[a-z0-9][a-z0-9-]*$/.test(slugOf(settings.github.botName))) {
    problems.push("github.botName must contain a letter or digit; its lowercase form names the selection label and the branch prefix");
  }
  if (settings.tools && settings.tools.readBytes.max < settings.tools.readBytes.default) problems.push("tools.readBytes.max must not be less than tools.readBytes.default");
  settings.workspace?.heavyCommands?.forEach((pattern, index) => {
    try { new RegExp(pattern); } catch { problems.push(`workspace.heavyCommands[${index}] is not a valid regular expression`); }
  });
  const changeActions = manifests().filter((manifest) => manifest.mode === "change" && ({ ...deploymentDefaults(manifest), ...settings.actions[manifest.name] }).enabled !== false).map((manifest) => manifest.name);
  if (changeActions.length && !settings.workspace?.validate?.length) {
    problems.push(`workspace.validate is empty but ${changeActions.join(", ")} publish commits; list the target repository's check commands, or use [["true"]] if it has nothing to check`);
  }
  for (const manifest of manifests()) {
    if (manifest.mode === "change" && ({ ...deploymentDefaults(manifest), ...settings.actions[manifest.name] }).agent !== "single") problems.push(`${manifest.name}: mode change requires source github_items and agent: single`);
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
    else await authTest().catch((error: unknown) => { problems.push(`slack: auth.test failed: ${errorMessage(error)}`); });
  }
  for (const [name, { apiKey }] of Object.entries(settings.providers ?? {})) {
    if (apiKey && !/\$\{\w+\}/.test(apiKey)) logger.warn({ provider: name }, "Provider apiKey is not a ${VAR} placeholder; it will not be redacted from output");
  }
  for (const manifest of manifests()) {
    const action = manifest.name, entry = { ...deploymentDefaults(manifest), ...settings.actions[action] };
    checkEntry(action, entry);
    if (entry.retry && manifest.mode !== "review") problems.push(`${action}: retry requires mode review`);
    if (entry.retry && entry.retry.maxDelaySeconds < entry.retry.initialDelaySeconds) problems.push(`${action}: retry.maxDelaySeconds must be at least retry.initialDelaySeconds`);
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
      if (entry.agent === "panel" && entry.reviewers?.length !== 2) problems.push(`${action}: agent "panel" requires exactly two reviewers`);
      if (slack && process.env.SLACK_BOT_TOKEN) await authTest().catch((error: unknown) => { problems.push(`${action}: Slack auth.test failed: ${errorMessage(error)}`); });
      if (manifest.browser) await loadPlaywright().catch((error: unknown) => { problems.push(`${action}: ${errorMessage(error)}`); });
      const skill = skillPath(manifest, entry.skill);
      if (!await access(skill).then(() => true, () => false)) problems.push(`${action}: skill file not found: ${skill}`);
    }
  }
  if (problems.length) {
    if (modelRuntime.getError()) dropModelRuntime();
    throw new Error(`Invalid Scrat configuration:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
  }
}

export async function prepareService() {
  await validateStaticConfig();
}
