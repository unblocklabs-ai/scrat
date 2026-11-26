import { access, lstat, mkdir, readFile } from "node:fs/promises";
import { workflows } from "./workflow-registry.ts";
import { type Resolver, publicAnswers, resolveHost, validateBindings } from "./bindings.ts";
import { config, trustLocalWorkflowScripts } from "./config.ts";
import { configError, type ScratConfig } from "./config-schema.ts";
import { scheduleProblem } from "./manifests.ts";
import { slugOf } from "./identity.ts";
import { logger } from "./logging.ts";
import { errorMessage } from "./errors.ts";
import { dropModelRuntime, sharedModelRuntime } from "./model-runtime.ts";
import { loadPlaywright } from "./scoped-tools.ts";
import { authTest } from "./slack.ts";
import { loadWorkflowScript } from "./workflow-runner.ts";
import { critiqueProblems, pathPatternProblems, resolveWorkflow, validateWorkflowConfig, validateWorkflowItemLabels, workflowCritique, workflowDeploymentDefaults, type WorkflowDefinition } from "./workflows.ts";

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
  settings: Partial<ScratConfig> = config,
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
  if (override?.paths !== undefined) {
    if (wf.on.event?.role !== "advisory" || wf.on.event.item !== "pr") problems.push(`${wf.name}: paths requires role advisory and item pr`);
    problems.push(...pathPatternProblems(`workflows.${wf.name}.paths`, override.paths));
  }
  if (!wf.on.cron && (override?.cron !== undefined || override?.window !== undefined)) {
    problems.push(`${wf.name}: cron and window are only allowed on scheduled workflows`);
  }
  if (entry.retry && entry.retry.maxDelaySeconds < entry.retry.initialDelaySeconds) {
    problems.push(`${wf.name}: retry.maxDelaySeconds must be at least retry.initialDelaySeconds`);
  }
  for (const issue of validateWorkflowConfig(entry.config, entry.mode, entry.on.event)) {
    problems.push(`${wf.name}: ${issue}`);
  }
  if (wf.on.event?.kind === "item_labels") {
    problems.push(...validateWorkflowItemLabels(entry));
  }
  if (entry.enabled || checkDisabled) {
    if (untrustedScript) {
      problems.push(`${wf.name}: local workflow run.ts requires workflows.trustLocalScripts: true in scrat.local.json`);
    }
    const { provider, model } = entry.defaults;
    if (!modelRuntime.getModel(provider, model)) {
      problems.push(`${wf.name}: no Pi model ${provider}/${model}${modelRuntime.getError() ? ` (${modelRuntime.getError()})` : ""}`);
    }
    if (entry.config.critique !== undefined && !critiqueProblems(entry.config.critique).length) {
      const critique = { provider, model, ...workflowCritique(entry.config) };
      if (!modelRuntime.getModel(critique.provider, critique.model)) {
        problems.push(`${wf.name} critique: no Pi model ${critique.provider}/${critique.model}${modelRuntime.getError() ? ` (${modelRuntime.getError()})` : ""}`);
      }
    }
    if (entry.skillPath && !await access(entry.skillPath).then(() => true, () => false)) {
      problems.push(`${wf.name}: skill file not found: ${entry.skillPath}`);
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
    if (entry.retry && entry.mode !== "review") {
      problems.push(`${wf.name}: retry requires mode review`);
    }
    if ((wf.defaults.reviewers.length > 0 || entry.defaults.reviewers.length > 0) && entry.defaults.reviewers.length !== 2) {
      problems.push(`${wf.name}: reviewers must specify exactly two reviewers`);
    }
    entry.defaults.reviewers.forEach((reviewer, index) => {
      if (!modelRuntime.getModel(reviewer.provider, reviewer.model)) {
        problems.push(`${wf.name} reviewer ${index + 1}: no Pi model ${reviewer.provider}/${reviewer.model}${modelRuntime.getError() ? ` (${modelRuntime.getError()})` : ""}`);
      }
    });
    const startMessage = typeof entry.config.startMessage === "string" ? entry.config.startMessage : "";
    const channel = typeof entry.config.channel === "string" ? entry.config.channel.trim() : "";
    const usesSlack = (entry.enabled || checkSlack) && wf.permissions.slack.includes("post") && (Boolean(channel) || wf.on.event?.source === "github_commits" || wf.on.event?.source === "shopify" || (wf.on.cron !== undefined && wf.defaults.tools.includes("browser")));
    if (usesSlack) {
      if (!process.env.SLACK_BOT_TOKEN) problems.push(`${wf.name}: SLACK_BOT_TOKEN is not set`);
      if (!channel) problems.push(`${wf.name}: channel must not be empty`);
      if (wf.on.event?.source === "github_commits" && !startMessage.trim()) problems.push(`${wf.name}: startMessage must not be empty`);
      if (wf.on.event?.source === "github_commits" && !entry.on.event?.branch?.trim()) problems.push(`${wf.name}: branch must not be empty`);
      if (startMessage) {
        const unknown = [...startMessage.matchAll(/\{\{(.*?)\}\}/g)].map((match) => match[1]).filter((name) => !templateVariables.has(name));
        if (unknown.length) problems.push(`${wf.name}: unknown startMessage variable ${unknown.map((name) => `{{${name}}}`).join(", ")}`);
      }
      if (process.env.SLACK_BOT_TOKEN) await authTest().catch((error: unknown) => { problems.push(`${wf.name}: Slack auth.test failed: ${errorMessage(error)}`); });
    }
    const storefront = settings.storefront;
    if (entry.enabled && (wf.on.cron !== undefined || wf.on.event?.source === "shopify") && wf.defaults.tools.includes("browser") && !wf.browser && !storefront?.enabled) {
      problems.push(`${wf.name}: files: storefront requires storefront.enabled`);
    }
    if (entry.enabled && (wf.browser || (storefront?.enabled && wf.defaults.tools.includes("browser")))) {
      await loadPlaywright().catch((error: unknown) => { problems.push(`${wf.name}: ${errorMessage(error)}`); });
    }
    if (entry.enabled && storefront?.enabled && wf.permissions.slack.includes("post") && (wf.on.event?.source === "github_commits" || wf.on.event?.source === "shopify" || (wf.on.cron !== undefined && wf.defaults.tools.includes("browser")))) {
      for (const load of [loadPlaywright, (await import("./lighthouse.ts")).loadLighthouse]) {
        await load().catch((error: unknown) => { problems.push(`${wf.name}: storefront: ${errorMessage(error)}`); });
      }
    }
  }
  return problems;
}

export async function validateStaticConfig(settings: Partial<ScratConfig> & { resolve?: Resolver } = config) {
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
  const reviewComments = workflows
    .filter((wf) => wf.on.event?.source === "github_items" && wf.on.event.kind === "item_changed" && wf.on.event.role !== "advisory" && wf.permissions.github.includes("comment")
      && resolveWorkflow(wf, { ...workflowDeploymentDefaults(wf), ...settings.workflows?.[wf.name] }).enabled)
    .map((wf) => ({ name: wf.name, item: wf.on.event?.item }));
  for (const item of ["issue", "pr"] as const) {
    const sharing = reviewComments.filter((entry) => entry.item === item).map((entry) => entry.name);
    if (sharing.length > 1) problems.push(`${sharing.join(", ")} would share one review comment on each ${item}; enable only one`);
  }
  const changeActions = workflows
    .filter((wf) => wf.mode === "change" && resolveWorkflow(wf, { ...workflowDeploymentDefaults(wf), ...settings.workflows?.[wf.name] }).enabled)
    .map((wf) => wf.name);
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
  for (const wf of workflows) {
    problems.push(...await validateWorkflowDefinition(wf, settings));
  }
  if (problems.length) {
    if (modelRuntime.getError()) dropModelRuntime();
    throw configError(problems);
  }
}
