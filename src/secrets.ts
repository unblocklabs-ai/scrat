import { config } from "./config.ts";
import { SecretLeakError } from "./results.ts";

const inheritedVariables = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LANGUAGE", "TZ", "TERM", "TMPDIR", "TMP", "TEMP",
  "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "no_proxy", "all_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "DOCKER_HOST", "GIT_CONFIG_GLOBAL",
]);

export function childEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).filter(([name]) => inheritedVariables.has(name) || name.startsWith("LC_")));
}

const secretVariables = ["GITHUB_APP_PRIVATE_KEY", "GITHUB_PAT", ...Object.values(config.providers)
  .flatMap((provider) => [...(provider.apiKey ?? "").matchAll(/\$\{(\w+)\}/g)].map((match) => match[1]))];

export const basicCredential = (token: string) => Buffer.from(`x-access-token:${token}`).toString("base64");

export function secretValues() {
  const values = secretVariables.map((name) => process.env[name]).filter((value): value is string => Boolean(value));
  return process.env.GITHUB_PAT ? [...values, basicCredential(process.env.GITHUB_PAT)] : values;
}

export function containsSecret(text: string) {
  if (/\b(?:gh[oprsu]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})/.test(text)) return true;
  const compact = text.replace(/\s+/g, "");
  return secretValues().some((secret) => {
    const value = secret.replace(/-----(?:BEGIN|END) [^-]*-----/g, "").replace(/\s+/g, "");
    if (value.length < 8) return false;
    if (value.length <= 40) return compact.includes(value);
    for (let start = 0; start + 40 <= value.length; start++) {
      if (compact.includes(value.slice(start, start + 40))) return true;
    }
    return false;
  });
}

export function assertPublishable(...texts: string[]) {
  if (texts.some(containsSecret)) {
    throw new SecretLeakError("Refusing to publish content containing credential material");
  }
}
