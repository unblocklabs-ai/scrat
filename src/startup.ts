import { access, lstat, mkdir, readFile } from "node:fs/promises";
import { manifests, workflows } from "./actions.ts";
import { type Resolver, publicAnswers, resolveHost, validateBindings } from "./bindings.ts";
import { config, trustLocalWorkflowScripts } from "./config.ts";
import { configError, type ScratConfig } from "./config-schema.ts";
import { type ActionSettings, deploymentDefaults, entryProblems, resolveAction, scheduleProblem, type Manifest } from "./manifests.ts";
import { slugOf } from "./identity.ts";
import { logger } from "./logging.ts";
import { errorMessage } from "./errors.ts";
import { dropModelRuntime, sharedModelRuntime } from "./model-runtime.ts";
import { loadPlaywright } from "./scoped-tools.ts";
import { authTest } from "./slack.ts";
import { loadWorkflowScript } from "./workflow-runner.ts";
import { resolveWorkflow, workflowDeploymentDefaults, type WorkflowDefinition } from "./workflows.ts";

const templateVariables = new Set(["sha", "short_sha", "author", "title", "url", "branch", "count", "bot", "change"]);

type Entry = { provider: string; model: string };

const staticImportPattern = /(?:^|[;\n])\s*(?:import|export)\s+(?!type\b)(?:[^;'"]*?\s+from\s+)?["']([^"']+)["']/g;
const dynamicImportPattern = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
const createRequirePattern = /\bcreateRequire\s*\(/;

async function workflowScriptImportProblems(scriptPath: string): Promise<string[]> {
  const source = await readFile(scriptPath, "utf8");
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const problems: string[] = [];
  if (createRequirePattern.test(stripped)) {
    problems.push("run.ts must not call createRequire (use import type, node:* built-ins, or ctx helpers)");
  }
  for (const pattern of [staticImportPattern, dynamicImportPattern]) {
    pattern.lastIndex = 0;
    for (const match of stripped.matchAll(pattern)) {
      const spec = match[1]!;
      if (!spec.startsWith("node:") && !spec.startsWith("./") && !spec.startsWith("../") && !spec.startsWith("/") && !spec.startsWith("file:")) {
        problems.push(`run.ts must not import bare npm specifier "${spec}" at runtime (use import type or ctx helpers)`);
      }
    }
  }
  return problems;
}

export async function validateWorkflowDefinition(
  wf: WorkflowDefinition,
  settings: Omit<Partial<ScratConfig>, "actions"> & { actions: Record<string, Partial<ActionSettings>> } = config,
  options: { checkDisabled?: boolean; trustLocalScripts?: boolean; checkSlack?: boolean } = {},
) {
  const { checkDisabled = false, trustLocalScripts = trustLocalWorkflowScripts, checkSlack = false } = options;
  const untrustedScript = wf.local && wf.scriptPath !== undefined && !trustLocalScripts;
  const modelRuntime = await sharedModelRuntime();
  const problems: string[] = [];
  const override = settings.workflows?.[wf.name];
  const entry = resolveWorkflow(wf, { ...workflowDeploymentDefaults(wf), ...override });
  for (const key of ["cron", "window"] as const) {
    const value = override?.[key], problem = value === undefined ? undefined : scheduleProblem(key, value);
    if (problem) problems.push(`workflows.${wf.name}.${key}: ${problem}`);
  }
  if (entry.enabled || checkDisabled) {
    if (untrustedScript) {
      problems.push(`${wf.name}: local workflow run.ts requires workflows.trustLocalScripts: true in scrat.local.json`);
    }
    const { provider, model } = entry.defaults;
    if (!modelRuntime.getModel(provider, model)) {
      problems.push(`${wf.name}: no Pi model ${provider}/${model}${modelRuntime.getError() ? ` (${modelRuntime.getError()})` : ""}`);
    }
    if (wf.skillPath && !await access(wf.skillPath).then(() => true, () => false)) {
      problems.push(`${wf.name}: skill file not found: ${wf.skillPath}`);
    }
    if (wf.scriptPath) {
      for (const issue of await workflowScriptImportProblems(wf.scriptPath).catch((error: unknown) => [errorMessage(error)])) {
        problems.push(`${wf.name}: ${issue}`);
      }
      if (!untrustedScript) {
        await loadWorkflowScript(wf.scriptPath).catch((error: unknown) => {
          problems.push(`${wf.name}: failed to load run.ts: ${errorMessage(error)}`);
        });
      }
    }
    const channel = typeof entry.config.channel === "string" ? entry.config.channel.trim() : "";
    if ((entry.enabled || checkSlack) && wf.permissions.slack.includes("post") && channel) {
      if (!process.env.SLACK_BOT_TOKEN) problems.push(`${wf.name}: SLACK_BOT_TOKEN is not set`);
      else await authTest().catch((error: unknown) => { problems.push(`${wf.name}: Slack auth.test failed: ${errorMessage(error)}`); });
    }
  }
  return problems;
}

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
  const resolvedEntry = (manifest: Manifest) => resolveAction(manifest, { ...deploymentDefaults(manifest), ...settings.actions[manifest.name] });
  const checkSlackAuth = (prefix: string) => authTest().catch((error: unknown) => { problems.push(`${prefix} auth.test failed: ${errorMessage(error)}`); });
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
  for (const [key, patterns] of Object.entries({ "workspace.heavyCommands": settings.workspace?.heavyCommands, "workspace.prepareInputs": settings.workspace?.prepareInputs, "relevance.ignoredPaths": settings.relevance?.ignoredPaths, "harness.transientErrors": settings.harness?.transientErrors })) {
    patterns?.forEach((pattern, index) => {
      try { new RegExp(pattern); } catch { problems.push(`${key}[${index}] is not a valid regular expression`); }
    });
  }
  const reviewComments = manifests.filter((manifest) => manifest.mode === "review" && manifest.publish.includes("comment") && resolvedEntry(manifest).enabled !== false);
  for (const item of ["issue", "pr"] as const) {
    const sharing = reviewComments.filter((manifest) => manifest.trigger.item === item).map((manifest) => manifest.name);
    if (sharing.length > 1) problems.push(`${sharing.join(", ")} would share one review comment on each ${item}; enable only one`);
  }
  const changeActions = manifests.filter((manifest) => manifest.mode === "change" && resolvedEntry(manifest).enabled !== false).map((manifest) => manifest.name);
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
    else await checkSlackAuth("slack:");
  }
  const storefront = settings.storefront;
  if (storefront?.enabled) {
    if (!process.env.LOGGIE_API_KEY) problems.push("storefront.enabled is true but LOGGIE_API_KEY is not set");
    if (!settings.workspace?.sandbox) problems.push("storefront.enabled requires workspace.sandbox");
    for (const [key, value] of Object.entries({ "storefront.store": storefront.store, "storefront.publicHost": storefront.publicHost, "storefront.loggie.slug": storefront.loggie.slug })) {
      if (!value.trim()) problems.push(`${key} must not be empty when storefront.enabled is true`);
    }
    if (storefront.model) checkEntry("storefront.model", storefront.model);
    if (storefront.publicHost.trim() && !/^[\w.-]+(?::\d+)?$/.test(storefront.publicHost)) problems.push("storefront.publicHost must be a host name, without a scheme or path");
    if (!URL.canParse(storefront.loggie.url)) problems.push("storefront.loggie.url must be an absolute URL");
    try { new RegExp(storefront.preview.themePaths); } catch { problems.push("storefront.preview.themePaths is not a valid regular expression"); }
    try { new RegExp(storefront.changes.ignoreMetaobjectTypes); } catch { problems.push("storefront.changes.ignoreMetaobjectTypes is not a valid regular expression"); }
    try { new RegExp(storefront.siteMapPaths); } catch { problems.push("storefront.siteMapPaths is not a valid regular expression"); }
    for (const device of storefront.devices) if (!Object.hasOwn(settings.tools?.browser.viewports ?? {}, device)) problems.push(`storefront.devices: ${device} is not a tools.browser.viewports preset`);
  }
  const cloudflare = settings.cloudflare;
  if (cloudflare?.enabled) {
    if (!process.env.LOGGIE_API_KEY) problems.push("cloudflare.enabled is true but LOGGIE_API_KEY is not set");
    for (const [key, value] of Object.entries({ "cloudflare.accountId": cloudflare.accountId, "cloudflare.loggie.slug": cloudflare.loggie.slug })) {
      if (!value.trim()) problems.push(`${key} must not be empty when cloudflare.enabled is true`);
    }
    if (!cloudflare.services.length) problems.push("cloudflare.services must not be empty when cloudflare.enabled is true");
    if (!URL.canParse(cloudflare.loggie.url)) problems.push("cloudflare.loggie.url must be an absolute URL");
  }
  for (const [name, { apiKey }] of Object.entries(settings.providers ?? {})) {
    if (apiKey && !/\$\{\w+\}/.test(apiKey)) logger.warn({ provider: name }, "Provider apiKey is not a ${VAR} placeholder; it will not be redacted from output");
  }
  for (const manifest of manifests) {
    const action = manifest.name, entry = resolvedEntry(manifest);
    checkEntry(action, entry);
    problems.push(...entryProblems(manifest, entry).map((problem) => `${action}: ${problem}`));
    for (const key of ["cron", "window"] as const) {
      const override = settings.actions[action]?.[key], problem = override === undefined ? undefined : scheduleProblem(key, override);
      if (problem) problems.push(`actions.${action}.${key}: ${problem}`);
    }
    entry.reviewers.forEach((reviewer, index) => checkEntry(`${action} reviewer ${index + 1}`, reviewer));
    if (entry.enabled !== false) {
      const slack = [...manifest.start ?? [], ...manifest.publish].some((effect) => effect.startsWith("slack_"));
      if (slack) {
        if (!process.env.SLACK_BOT_TOKEN) problems.push(`${action}: SLACK_BOT_TOKEN is not set`);
        if (!entry.channel?.trim()) problems.push(`${action}: channel must not be empty`);
        if (manifest.trigger.source === "github_commits" && !entry.startMessage?.trim()) problems.push(`${action}: startMessage must not be empty`);
        if (manifest.trigger.source === "github_commits" && !entry.branch?.trim()) problems.push(`${action}: branch must not be empty`);
        const unknown = [...(entry.startMessage ?? "").matchAll(/\{\{(.*?)\}\}/g)].map((match) => match[1]).filter((name) => !templateVariables.has(name));
        if (unknown.length) problems.push(`${action}: unknown startMessage variable ${unknown.map((name) => `{{${name}}}`).join(", ")}`);
      }
      if (manifest.files.includes("storefront") && (manifest.trigger.source === "schedule" || manifest.trigger.source === "shopify") && !storefront?.enabled) problems.push(`${action}: files: storefront requires storefront.enabled`);
      if (slack && process.env.SLACK_BOT_TOKEN) await checkSlackAuth(`${action}: Slack`);
      if (manifest.browser || (storefront?.enabled && manifest.tools.includes("browser"))) await loadPlaywright().catch((error: unknown) => { problems.push(`${action}: ${errorMessage(error)}`); });
      if (storefront?.enabled && manifest.publish.includes("slack_reply")) {
        for (const load of [loadPlaywright, (await import("./lighthouse.ts")).loadLighthouse]) await load().catch((error: unknown) => { problems.push(`${action}: storefront: ${errorMessage(error)}`); });
      }
      if (!await access(entry.skill).then(() => true, () => false)) problems.push(`${action}: skill file not found: ${entry.skill}`);
    }
  }
  for (const wf of workflows) {
    problems.push(...await validateWorkflowDefinition(wf, settings));
  }
  if (problems.length) {
    if (modelRuntime.getError()) dropModelRuntime();
    throw configError(problems);
  }
}
