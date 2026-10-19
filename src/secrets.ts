import { config } from "./config.ts";

// Workspace commands, Git hooks and agent shells run repository code. They
// inherit only what toolchains need; anything else belongs in workspace.environment.
const inheritedVariables = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LANGUAGE", "TZ", "TERM", "TMPDIR", "TMP", "TEMP",
  "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "no_proxy", "all_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "DOCKER_HOST", "GIT_CONFIG_GLOBAL",
]);

export function childEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).filter(([name]) => inheritedVariables.has(name) || name.startsWith("LC_")));
}

const secretVariables = ["GITHUB_APP_PRIVATE_KEY", ...Object.values(config.providers)
  .flatMap((provider) => [...provider.apiKey.matchAll(/\$\{(\w+)\}/g)].map((match) => match[1]))];

export function secretValues() {
  return secretVariables.map((name) => process.env[name]).filter((value): value is string => Boolean(value));
}

// Agents can quote or reflow what they read, so compare without whitespace and
// treat any 40-character run of a configured secret as a leak.
export function containsSecret(text: string) {
  if (/\b(?:gh[oprsu]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})/.test(text)) return true;
  const compact = text.replace(/\s+/g, "");
  return secretValues().some((secret) => {
    const value = secret.replace(/-----(?:BEGIN|END) [^-]*-----/g, "").replace(/\s+/g, "");
    if (value.length < 8) return false;
    if (value.length <= 40) return compact.includes(value);
    for (let start = 0; start + 40 <= value.length; start += 20) {
      if (compact.includes(value.slice(start, start + 40))) return true;
    }
    return false;
  });
}

export function assertPublishable(...texts: string[]) {
  if (texts.some(containsSecret)) {
    throw Object.assign(new Error("Refusing to publish content containing credential material"), { code: "SECRET_IN_OUTPUT" });
  }
}
