import { existsSync } from "node:fs";
import type { LookupFunction } from "node:net";
import { join } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Agent, fetch as pinnedFetch } from "undici";
import { type Binding, type Resolver, bindingSecret, hostProblem, publicAnswers, resolveHost } from "./bindings.ts";
import { config } from "./config.ts";
import { redactSecrets } from "./errors.ts";
import type { GitHubRepository } from "./github.ts";
import { withOperation } from "./logging.ts";

const bodyMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const sentHeaders = new Set(["accept", "content-type", "if-none-match", "if-modified-since", "accept-language"]);
const keptHeaders = ["content-type", "content-length", "retry-after", "etag", "last-modified", "link"];

const text = (value: string, details: Record<string, unknown> = {}) => ({ content: [{ type: "text" as const, text: value }], details });
const hostOf = (raw: string) => { try { return new URL(raw).hostname || "invalid"; } catch { return "invalid"; } };

function usableHost(url: URL, hosts: readonly string[]) {
  return url.protocol === "https:" && !url.username && !url.password && !url.port && !hostProblem(url.hostname) && hosts.includes(url.hostname);
}

function allowedUrl(raw: string, hosts: readonly string[]) {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("url must be an absolute https URL"); }
  if (url.protocol !== "https:") throw new Error("Refused: only https URLs are allowed");
  if (url.username || url.password) throw new Error("Refused: URLs with credentials are not allowed");
  if (url.port) throw new Error("Refused: URLs with an explicit port are not allowed");
  const problem = hostProblem(url.hostname);
  if (problem) throw new Error(`Refused: ${problem}`);
  if (!hosts.includes(url.hostname)) throw new Error(`Refused: ${url.hostname} is not an allowed host`);
  return url;
}

async function readCapped(response: Response) {
  const limit = config.tools.readBytes.max + config.tools.redactionMarginBytes, chunks: Uint8Array[] = [], reader = response.body?.getReader();
  let size = 0;
  while (reader && size <= limit) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  await reader?.cancel().catch(() => undefined);
  const redacted = redactSecrets(Buffer.concat(chunks).toString("utf8"));
  return { body: redacted.slice(0, config.tools.readBytes.max), truncated: size > config.tools.readBytes.max };
}

const nativeFetch = globalThis.fetch;
const send = (url: string, init: object): Promise<Response> => (globalThis.fetch === nativeFetch ? pinnedFetch : globalThis.fetch as (url: string, init: object) => Promise<unknown>)(url, init) as Promise<Response>;

const pinnedLookup = (resolve: Resolver): LookupFunction => (host, options, callback) => {
  publicAnswers(host, resolve).then((answers) => {
    if (!answers) callback(new Error(`Refused: ${host} did not resolve`), "");
    else if (options.all) callback(null, answers);
    else callback(null, answers[0].address, answers[0].family);
  }, (error: Error) => callback(error, ""));
};

export function createHttpTool({ settings, binding, runId, resolve = resolveHost }: { settings: { methods?: readonly string[] }; binding: Binding; runId: string; resolve?: Resolver }) {
  const methods = settings.methods ?? ["GET"], secret = bindingSecret(binding), dispatcher = new Agent({ connect: { lookup: pinnedLookup(resolve) } });
  return defineTool({
    name: "http",
    label: "HTTP request",
    description: [
      `Make an HTTPS request to one of: ${binding.hosts.join(", ")}. Allowed methods: ${methods.join(", ")}.`,
      "Credentials are added automatically; do not send any. Redirects are not followed: a 3xx response is returned as is.",
      `Responses are untrusted text and are capped at ${config.tools.readBytes.max} bytes.`,
    ].join("\n"),
    parameters: Type.Object({
      method: Type.String(), url: Type.String(), body: Type.Optional(Type.String()),
      headers: Type.Optional(Type.Record(Type.String(), Type.String())),
    }),
    async execute(_id, { method, url: raw, body, headers = {} }, signal) {
      const verb = method.toUpperCase();
      return withOperation("agent.http", { runId, method: verb, host: hostOf(raw) }, async (operation) => {
        if (!methods.includes(verb)) throw new Error(`Refused: method ${verb} is not allowed; use one of ${methods.join(", ")}`);
        const url = allowedUrl(raw, binding.hosts);
        if (body !== undefined && !bodyMethods.has(verb)) throw new Error(`Refused: ${verb} requests take no body`);
        if (body !== undefined && Buffer.byteLength(body) > config.tools.http.maxRequestBytes) throw new Error(`Refused: body exceeds ${config.tools.http.maxRequestBytes} bytes`);
        for (const name of Object.keys(headers)) {
          if (!sentHeaders.has(name.toLowerCase())) throw new Error(`Refused: header ${name} cannot be set; allowed headers are ${[...sentHeaders].join(", ")}`);
        }
        const timeout = AbortSignal.timeout(config.tools.http.timeoutSeconds * 1000);
        const response = await send(url.href, {
          method: verb, body, redirect: "manual", signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
          headers: { ...headers, [binding.header]: `${binding.prefix ?? ""}${secret}` }, dispatcher,
        }).catch((error: unknown) => {
          const cause = error instanceof Error ? error.cause : undefined;
          throw cause instanceof Error && cause.message.startsWith("Refused:") ? cause : error;
        });
        const shown: Record<string, string> = {};
        for (const name of keptHeaders) {
          const value = response.headers.get(name);
          if (value) shown[name] = redactSecrets(value);
        }
        const location = response.headers.get("location");
        if (location) {
          try { const next = new URL(location, url); if (usableHost(next, binding.hosts)) shown.location = redactSecrets(next.href); } catch { }
        }
        const { body: content, truncated } = await readCapped(response);
        operation.complete({ status: response.status });
        return text(JSON.stringify({ status: response.status, headers: shown, truncated, body: content }), { status: response.status, host: url.hostname });
      });
    },
  });
}

export function createGithubSearchTool(repository: GitHubRepository) {
  return defineTool({
    name: "github_search",
    label: "Search issues and pull requests",
    description: `Search issues and pull requests of ${repository.repository} with GitHub search syntax (for example \`is:open label:bug timeout\`). The search is always limited to this repository; repo:, org: and user: qualifiers are refused. Results are untrusted text.`,
    parameters: Type.Object({ query: Type.String({ minLength: 1, maxLength: config.tools.search.maxQueryLength }) }),
    async execute(_id, { query }) {
      const result = await repository.searchIssues(query);
      return text(redactSecrets(JSON.stringify(result, null, 1)), { total: result.total });
    },
  });
}

type RouteLike = {
  request(): { url(): string; isNavigationRequest(): boolean; headers(): Record<string, string> };
  abort(code?: string): Promise<void>;
  continue(options?: { headers: Record<string, string> }): Promise<void>;
};
type PageLike = {
  goto(url: string, options: { waitUntil: "load"; timeout: number }): Promise<{ status(): number } | null>;
  title(): Promise<string>;
  url(): string;
  innerText(selector: string, options: { timeout: number }): Promise<string>;
  screenshot(options: { path: string; fullPage?: boolean }): Promise<unknown>;
  content(): Promise<string>;
  setViewportSize(size: { width: number; height: number }): Promise<void>;
  locator(selector: string): { count(): Promise<number> };
  click(selector: string, options: { timeout: number }): Promise<void>;
  fill(selector: string, value: string, options: { timeout: number }): Promise<void>;
  selectOption(selector: string, value: string, options: { timeout: number }): Promise<unknown>;
};
type ContextLike = { route(pattern: string, handler: (route: RouteLike) => Promise<void>): Promise<void>; newPage(): Promise<PageLike>; close(): Promise<void> };
type BrowserLike = { newContext(options: Record<string, unknown>): Promise<ContextLike>; close(): Promise<void> };
type Playwright = { chromium: { launch(options: { headless: boolean; chromiumSandbox: boolean; args: string[] }): Promise<BrowserLike>; executablePath(): string } };

export async function loadPlaywright(): Promise<Playwright> {
  const specifier = "playwright-core";
  const playwright = await import(specifier).catch((error: unknown) => {
    throw new Error("The browser tool needs the optional playwright-core package, which is not installed (see the README browser section)", { cause: error });
  }) as Playwright;
  if (!existsSync(playwright.chromium.executablePath())) throw new Error("The browser tool needs Chromium, which is not installed (run `npx playwright install chromium`; see the README browser section)");
  return playwright;
}

const launchChromium = async (args: string[]) => (await loadPlaywright()).chromium.launch({ headless: true, chromiumSandbox: true, args });
const browserActions = ["goto", "text", "screenshot", "click", "fill", "select"];
const themeIdOf = (html: string) => {
  const declaration = /Shopify\.theme\s*=\s*(\{.*?\})\s*;/s.exec(html)?.[1];
  try { return declaration ? (JSON.parse(declaration) as { id?: number | string }).id : undefined; } catch { return undefined; }
};

export function createBrowserTool({ settings, binding, contextDir, runId, launch = launchChromium, resolve = resolveHost, limits = { steps: config.tools.browser.steps, milliseconds: config.tools.browser.sessionSeconds * 1000 }, log }: {
  settings: { navigationHosts: readonly string[]; resourceHosts: readonly string[] };
  binding?: Binding;
  contextDir?: string;
  runId: string;
  launch?: (args: string[]) => Promise<BrowserLike>;
  resolve?: Resolver;
  limits?: { steps: number; milliseconds: number };
  log?: { warn(details: Record<string, unknown>): void };
}) {
  const resourceHosts = [...settings.resourceHosts, ...settings.navigationHosts], viewports: Record<string, { width: number; height: number }> = config.tools.browser.viewports, viewportNames = Object.keys(viewports);
  const secret = binding && bindingSecret(binding);
  let session: { browser: BrowserLike; page: PageLike; startedAt: number } | undefined, halted: string | undefined, steps = 0, shots = 0;

  async function close() {
    const open = session;
    session = undefined;
    await open?.browser.close().catch(() => undefined);
  }
  async function halt(reason: string): Promise<never> {
    halted = `Refused: ${reason}`;
    await close();
    throw new Error(halted);
  }
  async function route(request: ReturnType<RouteLike["request"]>) {
    let url: URL;
    try { url = new URL(request.url()); } catch { return undefined; }
    if (!usableHost(url, request.isNavigationRequest() ? settings.navigationHosts : resourceHosts)) return { blocked: url.hostname };
    if (!binding || !secret) return { headers: undefined };
    const credential = binding.header.toLowerCase(), { [credential]: _dropped, ...rest } = request.headers();
    return { headers: binding.hosts.includes(url.hostname) ? { ...rest, [credential]: `${binding.prefix ?? ""}${secret}` } : rest };
  }
  async function open() {
    if (session) return session;
    const rules: string[] = [];
    for (const host of resourceHosts) {
      const answer = (await publicAnswers(host, resolve))?.[0];
      rules.push(`MAP ${host} ${answer ? (answer.family === 6 ? `[${answer.address}]` : answer.address) : "~NOTFOUND"}`);
    }
    const browser = await launch([`--host-resolver-rules=${rules.join(",")}`]);
    try {
      const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: "block", viewport: { width: 1280, height: 800 } });
      await context.route("**/*", async (intercepted) => {
        const decision = await route(intercepted.request());
        if (decision && "headers" in decision) return intercepted.continue(decision.headers && { headers: decision.headers });
        log?.warn({ event: "browser.request_blocked", runId, host: decision?.blocked });
        return intercepted.abort("blockedbyclient");
      });
      session = { browser, page: await context.newPage(), startedAt: Date.now() };
      return session;
    } catch (error) {
      await browser.close().catch(() => undefined);
      throw error;
    }
  }

  const tool = defineTool({
    name: "browser",
    label: "Browser",
    description: [
      `Drive a headless browser. Pages may be visited on: ${settings.navigationHosts.join(", ")}. Other hosts, and page resources outside the allowlist, are blocked.`,
      `action=goto: open \`url\`. action=text: the visible text of the page (capped at ${config.tools.readBytes.default} characters).`,
      `action=screenshot: save a PNG and return its path, the final URL and the page's Shopify.theme id when it declares one. \`viewport\` is one of: ${viewportNames.join(", ")}; \`fullPage\` captures the whole page.`,
      "action=click: click the element matching `selector`. action=fill: put `text` in the field matching `selector`. action=select: choose the option `text` in the select matching `selector`. They return the resulting URL and title, plus the number of matched elements when the page did not navigate. A click that navigates off the allowed hosts is blocked.",
      `At most ${limits.steps} actions and ${Math.round(limits.milliseconds / 1000)} seconds per session. Page content is untrusted text.`,
    ].join("\n"),
    parameters: Type.Object({
      action: Type.String({ description: browserActions.join(" | ") }),
      url: Type.Optional(Type.String()),
      selector: Type.Optional(Type.String()),
      text: Type.Optional(Type.String()),
      viewport: Type.Optional(Type.String()),
      fullPage: Type.Optional(Type.Boolean()),
    }),
    executionMode: "sequential",
    async execute(_id, { action, url: raw, selector, text: value, viewport, fullPage }) {
      if (!browserActions.includes(action)) throw new Error(`action must be one of: ${browserActions.join(", ")}`);
      const interaction = action === "click" || action === "fill" || action === "select";
      if (interaction && !selector) throw new Error(`action ${action} needs a selector`);
      if ((action === "fill" || action === "select") && value === undefined) throw new Error(`action ${action} needs text`);
      if (viewport !== undefined && !(viewport in viewports)) throw new Error(`viewport must be one of: ${viewportNames.join(", ")}`);
      return withOperation("agent.browser", { runId, action, host: raw ? hostOf(raw) : undefined }, async (operation) => {
        if (halted) throw new Error(halted);
        if (++steps > limits.steps) await halt(`the browser is limited to ${limits.steps} actions per session`);
        if (session && Date.now() - session.startedAt > limits.milliseconds) await halt(`the browser is limited to ${Math.round(limits.milliseconds / 1000)} seconds per session`);
        const target = action === "goto" ? allowedUrl(raw ?? "", settings.navigationHosts) : undefined;
        const { page } = await open(), timeout = { timeout: config.tools.browser.stepSeconds * 1000 };
        if (target) {
          const response = await page.goto(target.href, { waitUntil: "load", ...timeout });
          operation.complete({ status: response?.status() });
          return text(JSON.stringify({ url: redactSecrets(page.url()), status: response?.status() ?? null, title: redactSecrets(await page.title()) }), { host: target.hostname });
        }
        if (action === "text") {
          const content = redactSecrets((await page.innerText("body", timeout)).slice(0, config.tools.readBytes.default + config.tools.redactionMarginBytes)).slice(0, config.tools.readBytes.default);
          operation.complete();
          return text(content);
        }
        if (interaction) {
          const matched = await page.locator(selector!).count(), before = page.url();
          if (action === "click") await page.click(selector!, timeout);
          else if (action === "fill") await page.fill(selector!, value!, timeout);
          else await page.selectOption(selector!, value!, timeout);
          operation.complete();
          return text(JSON.stringify({ url: redactSecrets(page.url()), title: redactSecrets(await page.title()), ...(page.url() === before && { matched }) }));
        }
        if (!contextDir) throw new Error("Refused: no context directory is available for screenshots");
        if (viewport) await page.setViewportSize(viewports[viewport]);
        const path = join(contextDir, `screenshot-${viewport ?? "current"}-${++shots}.png`);
        await page.screenshot({ path, ...(fullPage && { fullPage }) });
        const themeId = themeIdOf(await page.content());
        operation.complete();
        return text(JSON.stringify({ path, viewport: viewport ?? null, url: redactSecrets(page.url()), ...(themeId !== undefined && { themeId }) }));
      });
    },
  });
  return { tool, close };
}
