import { config } from "./config.ts";

const etags = new Map<string, { etag: string; body: string; headers: [string, string][] }>();
let cachedChars = 0;
const rateLimit = { remaining: Infinity, limit: 5000, reset: 0 };

export function rateLimitLow() {
  return Date.now() < rateLimit.reset * 1000 && rateLimit.remaining < rateLimit.limit * config.github.rateLimitLowFraction;
}
export const rateLimitState = () => ({ remaining: rateLimit.remaining, limit: rateLimit.limit, resetsAt: new Date(rateLimit.reset * 1000).toISOString() });

function forget(key: string) {
  const old = etags.get(key);
  if (old) { cachedChars -= old.body.length; etags.delete(key); }
}

export async function conditionalFetch(input: string | URL | Request, init: RequestInit = {}) {
  const key = typeof input === "string" && (init.method ?? "GET") === "GET" && !new URL(input).pathname.startsWith("/search/") ? input : undefined;
  const hit = key ? etags.get(key) : undefined;
  if (key && hit) { etags.delete(key); etags.set(key, hit); }
  const response = await globalThis.fetch(input, hit
    ? { ...init, headers: { ...(init.headers as Record<string, string>), "if-none-match": hit.etag } } : init);
  const resource = response.headers.get("x-ratelimit-resource");
  if ((!resource || resource === "core") && response.headers.has("x-ratelimit-remaining")) {
    Object.assign(rateLimit, {
      remaining: Number(response.headers.get("x-ratelimit-remaining")), reset: Number(response.headers.get("x-ratelimit-reset")),
      limit: Number(response.headers.get("x-ratelimit-limit")) || rateLimit.limit,
    });
  }
  if (!key) return response;
  if (response.status === 304 && hit) {
    const merged = new Headers(hit.headers);
    for (const name of ["x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset", "x-ratelimit-used", "x-ratelimit-resource"]) {
      const value = response.headers.get(name);
      if (value) merged.set(name, value);
    }
    return new Response(hit.body, { status: 200, headers: merged });
  }
  forget(key);
  const etag = response.headers.get("etag");
  if (response.status === 200 && etag) {
    const body = await response.clone().text();
    let full = false;
    try {
      const data: unknown = JSON.parse(body);
      full = Array.isArray(data) && data.length >= Number(new URL(key).searchParams.get("per_page") ?? 30);
    } catch { }
    if (!full && body.length <= config.github.maxCachedChars) {
      forget(key);
      etags.set(key, { etag, body, headers: [...response.headers].filter(([name]) => name !== "content-length" && name !== "content-encoding") });
      cachedChars += body.length;
      for (const [oldest] of etags) {
        if (etags.size <= config.github.maxCachedResponses && cachedChars <= config.github.maxCachedChars) break;
        forget(oldest);
      }
    }
  }
  return response;
}
