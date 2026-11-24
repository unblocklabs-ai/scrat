import { existsSync } from "node:fs";
import { appendFile, writeFile } from "node:fs/promises";
import type { LookupFunction } from "node:net";
import { join } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Agent, fetch as pinnedFetch } from "undici";
import { type Binding, type Resolver, bindingSecret, hostProblem, publicAnswers, resolveHost } from "./bindings.ts";
import { config } from "./config.ts";
import { distillBrowserText } from "./d1.ts";
import { redactSecrets } from "./errors.ts";
import type { GitHubRepository } from "./github.ts";
import { withOperation } from "./logging.ts";

const bodyMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const sentHeaders = new Set(["accept", "content-type", "if-none-match", "if-modified-since", "accept-language"]);
const keptHeaders = ["content-type", "content-length", "retry-after", "etag", "last-modified", "link"];

type Hosts = readonly string[] | "any";
export type BrowserScope = { navigationHosts: Hosts; resourceHosts: Hosts; binding?: string; limits?: { steps: number; milliseconds: number } };

const text = (value: string, details: Record<string, unknown> = {}) => ({ content: [{ type: "text" as const, text: value }], details });
const hostOf = (raw: string) => { try { return new URL(raw).hostname || "invalid"; } catch { return "invalid"; } };

function usableHost(url: URL, hosts: Hosts) {
  return url.protocol === "https:" && !url.username && !url.password && !url.port && !hostProblem(url.hostname) && (hosts === "any" || hosts.includes(url.hostname));
}

function allowedUrl(raw: string, hosts: Hosts) {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("url must be an absolute https URL"); }
  if (url.protocol !== "https:") throw new Error("Refused: only https URLs are allowed");
  if (url.username || url.password) throw new Error("Refused: URLs with credentials are not allowed");
  if (url.port) throw new Error("Refused: URLs with an explicit port are not allowed");
  const problem = hostProblem(url.hostname);
  if (problem) throw new Error(`Refused: ${problem}`);
  if (hosts !== "any" && !hosts.includes(url.hostname)) throw new Error(`Refused: ${url.hostname} is not an allowed host`);
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
  evaluate?<R>(expression: string): Promise<R>;
  screenshot(options: { path: string; fullPage?: boolean; timeout: number }): Promise<unknown>;
  innerHTML(selector: string, options: { timeout: number }): Promise<string>;
  waitForLoadState(state: "load", options: { timeout: number }): Promise<void>;
  on(event: "popup", listener: (popup: { close(): Promise<void> }) => void): unknown;
  off(event: "popup", listener: (popup: { close(): Promise<void> }) => void): unknown;
  setViewportSize(size: { width: number; height: number }): Promise<void>;
  locator(selector: string): { count(): Promise<number>; first?(): { isVisible(): Promise<boolean> } };
  click(selector: string, options: { timeout: number }): Promise<void>;
  fill(selector: string, value: string, options: { timeout: number }): Promise<void>;
  selectOption(selector: string, value: string, options: { timeout: number }): Promise<unknown>;
};
type ContextLike = { route(pattern: string, handler: (route: RouteLike) => Promise<void>): Promise<void>; newPage(): Promise<PageLike>; close(): Promise<void> };
type BrowserLike = { newContext(options: Record<string, unknown>): Promise<ContextLike>; close(): Promise<void> };
type Playwright = { chromium: { launch(options: { headless: boolean; channel: string; chromiumSandbox: boolean; args: string[] }): Promise<BrowserLike>; executablePath(): string } };

export async function loadPlaywright(): Promise<Playwright> {
  const specifier = "playwright-core";
  const playwright = await import(specifier).catch((error: unknown) => {
    throw new Error("The browser tool needs the optional playwright-core package, which is not installed (see the README browser section)", { cause: error });
  }) as Playwright;
  if (!existsSync(playwright.chromium.executablePath())) throw new Error("The browser tool needs Chromium, which is not installed (run `npx playwright install chromium`; see the README browser section)");
  return playwright;
}

export const launchChromium = async (args: string[]) => (await loadPlaywright()).chromium.launch({ headless: true, channel: "chromium", chromiumSandbox: true, args });
const browserActions = ["goto", "text", "screenshot", "click", "fill", "select", "reset"];
const xmlSchemaHosts = new Set(["www.sitemaps.org", "sitemaps.org", "www.w3.org", "w3.org", "www.google.com"]);
const isSitemapPathname = (rawUrl: string) => {
  try { return /sitemap[^/]*\.xml(?:\.gz)?$/i.test(new URL(rawUrl).pathname); }
  catch { return false; }
};
const decodeXmlEntities = (value: string) => value
  .replaceAll("&amp;", "&")
  .replaceAll("&lt;", "<")
  .replaceAll("&gt;", ">")
  .replaceAll("&quot;", '"')
  .replaceAll("&apos;", "'");

const domScopingScript = `(() => {
  const isElementVisible = (el, requireInViewport = false) => {
    if (!el || el.nodeType !== 1) return false;
    let cur = el;
    while (cur && cur.nodeType === 1) {
      if (cur.getAttribute("aria-hidden") === "true" || cur.hasAttribute("hidden") || cur.hasAttribute("inert")) return false;
      const style = getComputedStyle(cur);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
      cur = cur.parentElement;
    }
    const rect = el.getBoundingClientRect();
    let hasBox = rect.width > 0 && rect.height > 0;
    let box = rect;
    if (!hasBox) {
      for (const child of Array.from(el.children || [])) {
        const cr = child.getBoundingClientRect();
        if (cr.width > 0 && cr.height > 0) { hasBox = true; box = cr; break; }
      }
    }
    if (!hasBox) return false;
    if (requireInViewport) {
      const vw = window.innerWidth || 0, vh = window.innerHeight || 0;
      if (vw > 0 && vh > 0 && (box.right <= 0 || box.bottom <= 0 || box.left >= vw || box.top >= vh)) return false;
    }
    return true;
  };
  const chromeSelector = "header, nav, footer, [role=banner], [role=navigation], [role=contentinfo]";
  const strictOverlaySelector = "[role=dialog], [role=alertdialog], [aria-modal=true], dialog[open], cart-drawer, [id*=cart-drawer i], [class*=cart-drawer i], [id*=cart_drawer i], [class*=cart_drawer i], [id*=onetrust i], [id*=cookie i], [class*=cookie-banner i], [class*=cookie-consent i]";
  const blocks = [];
  const seen = new Set();
  const includedRoots = [];
  const addText = (text) => {
    const clean = (text || "").trim();
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    blocks.push(clean);
  };
  const main = document.querySelector("main, [role=main]");
  if (main && isElementVisible(main)) {
    includedRoots.push(main);
    addText(main.innerText);
  } else if (document.body) {
    for (const child of Array.from(document.body.children || [])) {
      const tag = (child.tagName || "").toLowerCase();
      if (tag === "script" || tag === "style" || tag === "noscript" || tag === "template") continue;
      if (child.matches(chromeSelector) && !child.matches(strictOverlaySelector)) continue;
      if (isElementVisible(child)) {
        includedRoots.push(child);
        addText(child.innerText);
      }
    }
  }
  const overlays = Array.from(document.querySelectorAll(strictOverlaySelector)).filter((el) => {
    if (includedRoots.some((root) => root === el || root.contains(el))) return false;
    if (el.closest(chromeSelector) && !el.matches("[role=dialog], [role=alertdialog], [aria-modal=true], dialog[open], cart-drawer, [id*=cart-drawer i], [class*=cart-drawer i]")) return false;
    return isElementVisible(el, true);
  });
  const topOverlays = overlays.filter((el) => !overlays.some((other) => other !== el && other.contains(el)));
  for (const overlay of topOverlays) addText(overlay.innerText);
  return blocks.join("\\n\\n");
})()`;

function summarizeXmlSitemap(rawText: string, pageUrl: string, samplesPerGroup: number, maxGroups: number): { text: string; urlCount: number } | undefined {
  let pageHost = "", isSitemapUrl = false;
  try {
    const parsed = new URL(pageUrl);
    pageHost = parsed.hostname.toLowerCase();
    isSitemapUrl = isSitemapPathname(pageUrl) || (/\.xml$/i.test(parsed.pathname) && /<(?:urlset|sitemapindex|loc)\b/i.test(rawText));
  } catch { /* ignore */ }
  const hasXmlMarkers = /<(?:urlset|sitemapindex)\b/i.test(rawText) || /<loc>\s*(?:<!\[CDATA\[)?\s*https?:\/\//i.test(rawText);
  const looksLikeHtml = /<(?:!doctype\s+html|html\b|head\b|body\b)/i.test(rawText);
  if ((!isSitemapUrl && !hasXmlMarkers) || (looksLikeHtml && !hasXmlMarkers)) return undefined;

  const urls: string[] = [];
  const seen = new Set<string>();
  const addUrl = (raw: string, fromLoc: boolean) => {
    const unwrapped = raw.trim().replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, "$1").trim();
    const decoded = fromLoc ? decodeXmlEntities(unwrapped) : unwrapped.replace(/[),.;]+$/, "");
    if (!decoded || seen.has(decoded)) return;
    try {
      const parsed = new URL(decoded);
      if (xmlSchemaHosts.has(parsed.hostname.toLowerCase()) && /\/schemas\/|\/XMLSchema|\/sitemap/i.test(parsed.pathname)) return;
      seen.add(decoded);
      urls.push(decoded);
    } catch { /* ignore */ }
  };
  for (const match of rawText.matchAll(/<loc>\s*([\s\S]*?)\s*<\/loc>/gi)) addUrl(match[1]!, true);
  if (!urls.length && isSitemapUrl) {
    for (const match of rawText.matchAll(/https?:\/\/[^\s<>"']+/gi)) addUrl(match[0]!, false);
  }
  if (urls.length < 2) return undefined;

  const groups = new Map<string, string[]>();
  for (const entry of urls) {
    const parsed = new URL(entry);
    let key: string;
    if (/\.xml(?:\.gz)?$/i.test(parsed.pathname)) {
      key = "sitemaps (*.xml)";
    } else if (pageHost && parsed.hostname.toLowerCase() !== pageHost) {
      key = `external:${parsed.hostname.toLowerCase()}`;
    } else {
      const segs = parsed.pathname.split("/").filter(Boolean);
      if (!segs.length) key = "/";
      else if (segs[0] === "blogs" && segs.length >= 2) key = `/blogs/${segs[1]}/*`;
      else if (segs.length === 1) key = `/${segs[0]}`;
      else key = `/${segs[0]}/*`;
    }
    const list = groups.get(key) ?? [];
    list.push(entry);
    groups.set(key, list);
  }

  const ordered = [...groups.entries()].sort((a, b) => {
    if (a[0] === "sitemaps (*.xml)") return -1;
    if (b[0] === "sitemaps (*.xml)") return 1;
    return b[1].length - a[1].length || a[0].localeCompare(b[0]);
  });
  const shown = ordered.slice(0, maxGroups);
  const lines = [`[sitemap summary: ${urls.length} URLs across ${ordered.length} group(s)]`];
  for (const [group, list] of shown) {
    const sampleCap = group === "sitemaps (*.xml)" ? Math.max(samplesPerGroup, maxGroups) : samplesPerGroup;
    const samples = list.slice(0, sampleCap).join(", ");
    const more = list.length > sampleCap ? ` (+${list.length - sampleCap} more)` : "";
    lines.push(`- ${group}: ${list.length} — ${samples}${more}`);
  }
  if (ordered.length > shown.length) lines.push(`- ... and ${ordered.length - shown.length} more group(s)`);
  return { text: lines.join("\n"), urlCount: urls.length };
}
const themeIdOf = (html: string) => {
  const opening = /Shopify\.theme\s*=\s*\{/.exec(html);
  if (!opening) return undefined;
  const start = opening.index + opening[0].length - 1, end = html.indexOf("}", start);
  try { const id = end < 0 ? undefined : (JSON.parse(html.slice(start, end + 1)) as { id?: unknown }).id; return Number.isSafeInteger(id) ? (id as number) : undefined; } catch { return undefined; }
};

const describeElement = (tag: string) => {
  const id = /\sid="([^"]*)"/.exec(tag)?.[1], classes = /\sclass="([^"]*)"/.exec(tag)?.[1] ?? "";
  return `${/^<([\w-]+)/.exec(tag)?.[1] ?? "?"}${id ? `#${id}` : ""}${classes.split(/\s+/).filter(Boolean).map((name) => `.${name}`).join("")}`;
};

export function createBrowserTool({ settings, binding, contextDir, runId, prefix, sessionTag, launch = launchChromium, resolve = resolveHost, acquire, limits = { steps: config.tools.browser.steps, milliseconds: config.tools.browser.sessionSeconds * 1000 }, log }: {
  settings: { navigationHosts: Hosts; resourceHosts: Hosts };
  binding?: Binding;
  contextDir?: string;
  runId: string;
  prefix?: string;
  sessionTag?: string;
  launch?: (args: string[]) => Promise<BrowserLike>;
  resolve?: Resolver;
  acquire?: () => Promise<() => void>;
  limits?: { steps: number; milliseconds: number };
  log?: { warn(details: Record<string, unknown>): void };
}) {
  const { navigationHosts } = settings, resourceHosts = settings.resourceHosts === "any" || navigationHosts === "any" ? "any" : [...settings.resourceHosts, ...navigationHosts], viewports: Record<string, { width: number; height: number }> = config.tools.browser.viewports, viewportNames = Object.keys(viewports);
  if (!Object.hasOwn(viewports, config.tools.browser.defaultViewport)) throw new Error(`tools.browser.defaultViewport must be one of: ${viewportNames.join(", ")}`);
  let blockedNavigation: string | undefined, size = viewports[config.tools.browser.defaultViewport], pendingGotoViewport: string | null = null;
  const secret = binding && bindingSecret(binding);
  let browser: BrowserLike | undefined, closed = false, release: (() => void) | undefined, session: { context: ContextLike; page: PageLike } | undefined, startedAt: number | undefined, halted: string | undefined, steps = 0, shots = 0, textDumps = 0;
  const answered = new Map<string, Promise<boolean>>();
  const resolvesPublicly = (host: string) => {
    if (!answered.has(host)) answered.set(host, publicAnswers(host, resolve).then(Boolean, () => false));
    return answered.get(host)!;
  };
  const servedTheme = async (page: PageLike, timeout: { timeout: number }) => {
    const themeId = themeIdOf(await page.innerHTML("html", timeout).catch(() => ""));
    return themeId === undefined ? {} : { themeId };
  };

  async function close() {
    closed = true;
    const open = browser;
    browser = undefined;
    session = undefined;
    await open?.close().catch(() => undefined);
    release?.();
    release = undefined;
  }
  async function halt(reason: string): Promise<never> {
    halted = `Refused: ${reason}`;
    await close();
    throw new Error(halted);
  }
  async function route(request: ReturnType<RouteLike["request"]>) {
    let url: URL;
    try { url = new URL(request.url()); } catch { return undefined; }
    const hosts = request.isNavigationRequest() ? navigationHosts : resourceHosts;
    if (!usableHost(url, hosts) || (hosts === "any" && !await resolvesPublicly(url.hostname))) return { blocked: url.hostname };
    if (!binding || !secret) return { headers: undefined };
    const credential = binding.header.toLowerCase(), { [credential]: _dropped, ...rest } = request.headers();
    return { headers: binding.hosts.includes(url.hostname) ? { ...rest, [credential]: `${binding.prefix ?? ""}${secret}` } : rest };
  }
  async function open() {
    if (session) return session;
    if (!browser) {
      release = await acquire?.().catch(() => halt("the worker is stopping"));
      try {
        const rules: string[] = [];
        for (const host of resourceHosts === "any" ? [] : resourceHosts) {
          const answer = (await publicAnswers(host, resolve))?.[0];
          rules.push(`MAP ${host} ${answer ? (answer.family === 6 ? `[${answer.address}]` : answer.address) : "~NOTFOUND"}`);
        }
        browser = await launch(rules.length ? [`--host-resolver-rules=${rules.join(",")}`] : []);
        if (closed) { await browser.close().catch(() => undefined); browser = undefined; throw new Error("Refused: the browser session has ended"); }
      } catch (error) { await close(); throw error; }
    }
    try {
      const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: "block", viewport: size });
      await context.route("**/*", async (intercepted) => {
        const decision = await route(intercepted.request());
        if (decision && "headers" in decision) return intercepted.continue(decision.headers && { headers: decision.headers });
        log?.warn({ event: "browser.request_blocked", runId, host: decision?.blocked });
        if (decision && intercepted.request().isNavigationRequest()) blockedNavigation = intercepted.request().url();
        return intercepted.abort("blockedbyclient");
      });
      session = { context, page: await context.newPage() };
      startedAt ??= Date.now();
      return session;
    } catch (error) {
      await close();
      throw error;
    }
  }

  const tool = defineTool({
    name: "browser",
    label: "Browser",
    description: [
      navigationHosts === "any" ? "Drive a headless browser on public https sites. IP addresses, local host names, explicit ports, URLs with credentials and names that resolve to private addresses are blocked."
        : `Drive a headless browser. Pages may be visited on: ${navigationHosts.join(", ")}. Other hosts, and page resources outside the allowlist, are blocked.`,
      `action=goto: open \`url\` (optionally with \`viewport\`, one of: ${viewportNames.join(", ")}, applied before the page loads and kept for later actions) and return the final URL, status, title and the page's Shopify.theme id when it declares one. action=text: the visible text of the page (optionally scoped with \`selector\`, capped at ${config.tools.readBytes.default} characters; XML sitemaps are grouped deterministically${config.tools.browser.domScoping ? ", repetitive header/nav/footer chrome is omitted while preserving main content and open modals/drawers" : ""}${config.d1.enabled ? `, and long pages > ${config.d1.browserText.minChars} chars are distilled via d1 with full text saved to a readable file — pass optional \`focus\` to target specific page elements or \`raw: true\` for full unfiltered body text` : " — pass \`raw: true\` for full unfiltered body text"}).`,
      `action=screenshot: save a PNG and return its path, the final URL and the page's Shopify.theme id when it declares one. \`viewport\` is one of: ${viewportNames.join(", ")}; \`fullPage\` captures the whole page.`,
      "action=reset: drop the page with its cookies and storage; the next action opens a fresh one in the same browser at the current viewport.",
      "action=click: click the element matching `selector`. action=fill: put `text` in the field matching `selector`. action=select: choose the option `text` in the select matching `selector`. They return the resulting URL, title and Shopify.theme id, plus how many elements `selector` matched before the action when the page did not navigate, `popupClosed: true` when a new window opened (it is closed), and `blocked: <url>` when a navigation was refused because its host is not allowed. The viewport stays as last set.",
      `At most ${limits.steps} actions and ${Math.round(limits.milliseconds / 1000)} seconds per session. Page content is untrusted text.`,
    ].join("\n"),
    parameters: Type.Object({
      action: Type.String({ description: browserActions.join(" | ") }),
      url: Type.Optional(Type.String()),
      selector: Type.Optional(Type.String()),
      text: Type.Optional(Type.String()),
      viewport: Type.Optional(Type.String()),
      fullPage: Type.Optional(Type.Boolean()),
      focus: Type.Optional(Type.String({ description: "Optional question or topic for action=text to focus d1 extraction on long pages" })),
      raw: Type.Optional(Type.Boolean({ description: "Set true with action=text to bypass d1 filtering and return raw page text" })),
    }),
    executionMode: "sequential",
    async execute(_id, { action, url: raw, selector, text: value, viewport: requested, fullPage, focus, raw: rawText }, signal) {
      const viewport = requested || undefined;
      if (!browserActions.includes(action)) throw new Error(`action must be one of: ${browserActions.join(", ")}`);
      const interaction = action === "click" || action === "fill" || action === "select";
      if (interaction && !selector) throw new Error(`action ${action} needs a selector`);
      if ((action === "fill" || action === "select") && value === undefined) throw new Error(`action ${action} needs text`);
      if (viewport !== undefined && !Object.hasOwn(viewports, viewport)) throw new Error(`viewport must be one of: ${viewportNames.join(", ")}`);
      return withOperation("agent.browser", { runId, action, host: raw ? hostOf(raw) : undefined }, async (operation) => {
        if (halted) throw new Error(halted);
        if (++steps > limits.steps) await halt(`the browser is limited to ${limits.steps} actions per session`);
        if (startedAt !== undefined && Date.now() - startedAt > limits.milliseconds) await halt(`the browser is limited to ${Math.round(limits.milliseconds / 1000)} seconds per session`);
        if (action === "reset") {
          const dropped = session;
          session = undefined;
          pendingGotoViewport = null;
          await dropped?.context.close().catch(() => undefined);
          operation.complete();
          return text(JSON.stringify({ reset: true }));
        }
        const target = action === "goto" ? allowedUrl(raw ?? "", navigationHosts) : undefined;
        if (target && navigationHosts === "any" && !await resolvesPublicly(target.hostname)) throw new Error(`Refused: ${target.hostname} does not resolve to a public address`);
        const hadSession = session !== undefined, previousSize = size;
        if (target && viewport && !hadSession) size = viewports[viewport];
        let page: PageLike;
        try { ({ page } = await open()); }
        catch (error) {
          if (target && viewport && !hadSession) size = previousSize;
          throw error;
        }
        const navigation = { timeout: config.tools.browser.navigationSeconds * 1000 }, timeout = { timeout: config.tools.browser.actionSeconds * 1000 };
        if (target) {
          if (viewport && hadSession) {
            await page.setViewportSize(viewports[viewport]);
            size = viewports[viewport];
          }
          pendingGotoViewport = null;
          const response = await page.goto(target.href, { waitUntil: "load", ...navigation });
          pendingGotoViewport = viewport ?? null;
          operation.complete({ status: response?.status() });
          return text(JSON.stringify({ url: redactSecrets(page.url()), status: response?.status() ?? null, title: redactSecrets(await page.title()), ...await servedTheme(page, timeout) }), { host: target.hostname });
        }
        if (action === "text") {
          const currentUrl = redactSecrets(page.url());
          const isXmlPage = isSitemapPathname(currentUrl);
          const actionDeadline = Date.now() + timeout.timeout;
          let rawBody: string | undefined;
          if (selector) {
            rawBody = await page.innerText(selector, timeout);
          } else if (config.tools.browser.domScoping && !rawText && !isXmlPage && typeof page.evaluate === "function") {
            let timer: NodeJS.Timeout | undefined;
            const scoped = await Promise.race([
              page.evaluate<string>(domScopingScript).catch(() => undefined),
              new Promise<undefined>((resolveTimeout) => { timer = setTimeout(() => resolveTimeout(undefined), timeout.timeout); }),
            ]).finally(() => { if (timer) clearTimeout(timer); });
            if (typeof scoped === "string" && scoped.trim()) rawBody = scoped;
          }
          if (rawBody === undefined) {
            const remainingTimeout = { timeout: Math.max(500, actionDeadline - Date.now()) };
            rawBody = await page.innerText("body", remainingTimeout);
          }
          const captureCap = (config.d1.enabled || isXmlPage) && !rawText ? Math.min(config.harness.maxOutputBytes, config.tools.browser.textCaptureBytes) : config.tools.readBytes.default;
          const margin = config.tools.redactionMarginBytes;
          const redacted = redactSecrets(rawBody.slice(0, captureCap + margin));
          const content = rawBody.length > captureCap + margin
            ? redacted.slice(0, Math.min(captureCap, Math.max(0, redacted.length - margin)))
            : redacted.slice(0, captureCap);
          const partialCapture = rawBody.length > captureCap;
          const nameTag = sessionTag ?? prefix;
          const nextArtifactPath = () => contextDir ? join(contextDir, `browser-text-${nameTag ? `${nameTag}-` : ""}${++textDumps}.txt`) : undefined;
          if (!rawText && !selector) {
            const sitemap = summarizeXmlSitemap(content, currentUrl, config.tools.browser.sitemapSamplesPerGroup, config.tools.browser.sitemapMaxGroups);
            if (sitemap && sitemap.text.length < content.length) {
              const candidatePath = nextArtifactPath();
              const savedPath = candidatePath
                ? await writeFile(candidatePath, content, { encoding: "utf8", mode: 0o600 }).then(() => candidatePath, () => undefined)
                : undefined;
              const partialNote = partialCapture ? ` (partial capture: first ${content.length} of ${rawBody.length} chars)` : "";
              const summaryText = partialNote ? sitemap.text.replace(/^\[sitemap summary: ([^\]]+)\]/, `[sitemap summary: $1${partialNote}]`) : sitemap.text;
              const label = partialCapture ? `Partial sitemap text (first ${content.length} of ${rawBody.length} chars)` : "Full sitemap text";
              const suffix = savedPath ? `\n${label} saved to ${savedPath} (use read to inspect).` : "";
              const inlineCap = config.tools.readBytes.default;
              const fullRendered = `${summaryText}${suffix}`;
              const outText = fullRendered.length <= inlineCap
                ? fullRendered
                : `${summaryText.slice(0, Math.max(0, inlineCap - suffix.length - 32)).trimEnd()}\n... [truncated]${suffix}`;
              operation.complete();
              return text(outText, { filtered: true, sitemapUrls: sitemap.urlCount, ...(partialCapture ? { partial: true } : {}), ...(savedPath ? { artifactPath: savedPath } : {}) });
            }
          }
          if (config.d1.enabled && !rawText && content.length > config.d1.browserText.minChars) {
            const candidatePath = nextArtifactPath();
            const distilled = await distillBrowserText({
              rawText: content, url: currentUrl, focus, artifactPath: candidatePath,
              partialSource: partialCapture, totalSourceChars: rawBody.length,
              minChars: config.d1.browserText.minChars, maxChars: config.d1.browserText.maxOutputChars,
              signal, log,
            });
            operation.complete();
            return text(distilled.text, { filtered: distilled.filtered, ...(partialCapture ? { partial: true } : {}), ...(distilled.artifactPath ? { artifactPath: distilled.artifactPath } : {}) });
          }
          operation.complete();
          const inlineCap = config.tools.readBytes.default;
          const inlineText = content.length > inlineCap ? content.slice(0, inlineCap) : content;
          const inlineTruncated = rawBody.length > inlineCap || content.length > inlineCap;
          return text(inlineTruncated ? `${inlineText}\n\n[truncated: page text exceeded ${inlineCap} chars (${rawBody.length} total)]` : inlineText);
        }
        if (interaction && selector) {
          pendingGotoViewport = null;
          const locator = page.locator(selector);
          const matched = await locator.count(), before = page.url(), popups: unknown[] = [];
          let targetSelector = selector;
          if (matched > 1 && !/(?:^|>>)\s*visible=/.test(selector) && locator.first && !await locator.first().isVisible().catch(() => true)) {
            const visible = `${selector} >> visible=true`;
            if (await page.locator(visible).count().catch(() => 0) > 0) targetSelector = visible;
          }
          const onPopup = (popup: { close(): Promise<void> }) => { popups.push(popup); void popup.close().catch(() => undefined); };
          blockedNavigation = undefined;
          page.on("popup", onPopup);
          try {
            if (action === "click") await page.click(targetSelector, timeout);
            else if (action === "fill") await page.fill(targetSelector, value ?? "", timeout);
            else await page.selectOption(targetSelector, value ?? "", timeout);
            await page.waitForLoadState("load", navigation);
          } catch (error) {
            const blockers = error instanceof Error && /Timeout/.test(error.message) ? [...new Set([...error.message.matchAll(/^\s*- (<[^>]*>).*?(?: from (<[^>]*>).*? subtree)? intercepts pointer events/gm)].map(([, inner, root]) => describeElement(root ?? inner)))] : [];
            if (blockers.length === 0) throw error;
            throw new Error(redactSecrets(`${action} on ${selector} was blocked after ${config.tools.browser.actionSeconds} s: ${blockers.join(", ")} intercepted pointer events. If one is an overlay such as a popup or consent banner, close it (its close button, Escape or a click outside) and retry; otherwise scroll or use another element.`));
          } finally { page.off("popup", onPopup); }
          operation.complete();
          return text(JSON.stringify({ url: redactSecrets(page.url()), title: redactSecrets(await page.title()), ...await servedTheme(page, timeout), ...(page.url() === before && { matched }), ...(targetSelector !== selector && { visibleMatch: true }), ...(popups.length > 0 && { popupClosed: true }), ...(blockedNavigation !== undefined && { blocked: redactSecrets(blockedNavigation) }) }));
        }
        if (!contextDir) throw new Error("Refused: no context directory is available for screenshots");
        if (viewport) {
          await page.setViewportSize(viewports[viewport]);
          size = viewports[viewport];
        }
        const shotViewport = viewport ?? pendingGotoViewport;
        pendingGotoViewport = null;
        const path = join(contextDir, `screenshot-${prefix ? `${prefix}-` : ""}${shotViewport ?? "current"}-${++shots}.png`);
        await page.screenshot({ path, fullPage, ...timeout });
        operation.complete();
        const shot = { path, viewport: shotViewport, url: redactSecrets(page.url()) };
        await appendFile(join(contextDir, "screenshots.jsonl"), JSON.stringify(shot) + "\n");
        return text(JSON.stringify({ ...shot, ...await servedTheme(page, timeout) }));
      });
    },
  });
  return { tool, close };
}
