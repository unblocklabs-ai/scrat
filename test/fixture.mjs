import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { createServer } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";

export const bearer = (options) => new Headers(options.headers).get("authorization")?.replace(/^(token|bearer) /i, "");
const githubItem = (kind, number, extra) => ({ id: number, node_id: `${kind === "pr" ? "PR" : "ISSUE"}_${number}`, number, state: "open", html_url: `https://github.com/fixture/project/${kind === "pr" ? "pull" : "issues"}/${number}`, updated_at: "2026-10-19T00:00:00Z", labels: [], user: { login: "human" }, ...extra });

function schemaTemplate(repository) {
  const kit = resolve(repository, "node_modules/drizzle-kit");
  const key = createHash("sha256").update(readFileSync(resolve(repository, "src/schema.ts"))).update(JSON.parse(readFileSync(resolve(kit, "package.json"), "utf8")).version).digest("hex").slice(0, 16);
  const template = resolve(tmpdir(), `scrat-schema-${key}.sqlite`);
  if (existsSync(template)) return template;
  const work = mkdtempSync(resolve(tmpdir(), "scrat-schema-build-"));
  try {
    execFileSync(process.execPath, [resolve(kit, "bin.cjs"), "push", "--dialect=sqlite", "--schema=" + resolve(repository, "src/schema.ts"), "--url=./template.sqlite"], { cwd: work, stdio: ["ignore", "pipe", "pipe"] });
    renameSync(resolve(work, "template.sqlite"), template);
  } finally { rmSync(work, { recursive: true, force: true }); }
  return template;
}

export async function fixture(scenario, spec) {
  const repository = fileURLToPath(new URL("..", import.meta.url));
  const root = mkdtempSync(resolve(tmpdir(), "scrat-integration-"));
  for (const path of ["src", "skills", "actions", "scrat.config.json", "package.json"]) cpSync(resolve(repository, path), resolve(root, "app", path), { recursive: true });
  symlinkSync(resolve(repository, "node_modules"), resolve(root, "app/node_modules"));
  process.chdir(root);
  const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const pulled = new Map(), frozen = new Set(), forced = new Map();
  const headOf = (ref) => {
    try { return readFileSync(resolve("remote.git/refs/heads", ref), "utf8").trim(); } catch {}
    try { const packed = readFileSync(resolve("remote.git/packed-refs"), "utf8").split("\n").find((line) => line.endsWith(" refs/heads/" + ref)); if (packed) return packed.split(" ")[0]; } catch {}
    return git(resolve("remote.git"), "rev-parse", ref);
  };
  const commit = (cwd, message) => git(cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", message);
  execFileSync("git", ["init", "--bare", "remote.git"], { stdio: "ignore" });
  execFileSync("git", ["init", "-b", "main", "seed"], { stdio: "ignore" });
  mkdirSync("seed/src"); writeFileSync("seed/src/app.ts", "export const value = 1;\n");
  spec.seed?.();
  git(resolve("seed"), "add", "."); commit(resolve("seed"), "Initial source");
  git(resolve("seed"), "push", resolve("remote.git"), "main");
  execFileSync("git", ["--git-dir=" + resolve("remote.git"), "symbolic-ref", "HEAD", "refs/heads/main"]);
  writeFileSync("gitconfig", `[url "${resolve("remote.git")}"]\n insteadOf = https://github.com/fixture/project.git\n`);
  process.env.GIT_CONFIG_GLOBAL = resolve("gitconfig");
  const patMode = scenario === "pat_auth", pat = "ghp_" + "a1B2c3D4e".repeat(4), user = { login: "Agent-Account", status: 200 }, githubApp = { slug: "scrat-unblock" };
  if (patMode) delete process.env.GITHUB_APP_PRIVATE_KEY;
  else process.env.GITHUB_APP_PRIVATE_KEY = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey;
  if (patMode || scenario === "isolation") process.env.GITHUB_PAT = pat;
  const scoped = ["scoped_http", "scoped_github_search", "scoped_browser", "bindings_startup"].includes(scenario);
  if (scoped) process.env.SCOUT_TOKEN = "scout-" + "k9Xq2LmPz7".repeat(3);
  if (scenario.startsWith("commit_review") || scenario === "recovery" || scenario === "isolation" || scenario.startsWith("slack_status") || scenario === "publish_effects") process.env.SLACK_BOT_TOKEN = ["xoxb", "1234567890", "fixtureSlackToken"].join("-");
  process.env.PI_CODING_AGENT_DIR = resolve("pi-agent"); mkdirSync("pi-agent");
  const verdicts = {}, modes = new Map(), steps = new Map(), requests = [], calls = [], rate = { limit: 5000, remaining: 5000, reset: Math.floor(Date.now() / 1000) + 3600 }, issues = new Map(), checkRuns = new Map(), prs = [], comments = new Map(), reviews = new Map(), writes = [], deployments = [];
  const faults = { label: new Set(), comment: new Set(), pr: new Set(), cleanup: new Set(), issue: new Set(), permissions: new Set(), commitComment: new Set() };
  const tokens = new Map(patMode ? [[pat, { issues: "write", pull_requests: "write", contents: "write" }]] : []);
  const transient = { failures: 0, seen: new Map() };
  let onModel, script, nextCommentId = 1000, nextIssueNumber = 500;
  const external = [], searches = [], commitComments = new Map();
  const md5 = (text) => createHash("md5").update(text).digest("hex"), mainTheme = "gid://shopify/OnlineStoreTheme/1";
  const store = (theme, filename, type, value, checksum) => { theme.files.set(filename, checksum ?? md5(Buffer.from(value, type === "TEXT" ? "utf8" : "base64"))); theme.bodies.set(filename, { type, value }); };
  const loggie = { key: "loggie-" + "Z8wQ4nR2tY".repeat(3), slug: "shop-fixture", requests: [], restricted: new Set(), lostDuplicate: false, wrongMd5: new Set(), upsertErrors: new Set(), stuckDeletes: new Set(), processingPolls: 1, nextId: 9000, mainTheme, md5,
    themes: new Map([[mainTheme, { id: mainTheme, name: "live", role: "MAIN", polls: 0, files: new Map(), bodies: new Map() }]]),
    setLive: (entries) => {
      const main = loggie.themes.get(mainTheme); main.files.clear(); main.bodies.clear();
      for (const [filename, content] of Object.entries(entries)) Buffer.isBuffer(content) ? store(main, filename, "URL", content.toString("base64")) : store(main, filename, "TEXT", content);
    } };
  loggie.setLive(Object.fromEntries(["layout/theme.liquid", "assets/app.css", "config/settings_data.json"].map((name) => [name, name])));
  if (scenario.startsWith("storefront")) process.env.LOGGIE_API_KEY = loggie.key;
  const shopify = (req, res, body) => {
    const send = (data, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
    const { query, variables = {} } = JSON.parse(body), field = query.match(/\{\s*(\w+)/)?.[1], key = req.headers["x-api-key"];
    loggie.requests.push({ field, variables, key, path: req.url });
    if (key !== loggie.key) return send({ error: { code: "UNAUTHORIZED", message: "Invalid API key" } }, 401);
    if (req.url !== `/api/proxy/${loggie.slug}/`) return send({ error: { code: "NOT_FOUND", message: "Unknown integration" } }, 404);
    if (!["themes", "theme", "themeDuplicate", "themeFilesUpsert", "themeFilesDelete", "themeDelete"].includes(field) || loggie.restricted.has(field)) {
      return send({ error: { code: "ENDPOINT_RESTRICTED", message: `${field} is not allowed by this profile` } }, 403);
    }
    const theme = loggie.themes.get(variables.id);
    if (field === "themes") return send({ data: { themes: { nodes: [...loggie.themes.values()].filter((entry) => variables.names ? entry.role === "UNPUBLISHED" && variables.names.includes(entry.name) : entry.role === "MAIN").map(({ id, name }) => ({ id, name })) } } });
    if (field === "themeDuplicate") {
      const id = "gid://shopify/OnlineStoreTheme/" + ++loggie.nextId;
      loggie.themes.set(id, { id, name: variables.name, role: "UNPUBLISHED", polls: loggie.processingPolls, files: new Map(theme.files), bodies: new Map(theme.bodies) });
      if (loggie.lostDuplicate) { loggie.lostDuplicate = false; res.writeHead(502, { "content-type": "text/html" }); return res.end("<html>Bad Gateway</html>"); }
      return send({ data: { themeDuplicate: { newTheme: { id, name: variables.name }, userErrors: [] } } });
    }
    if (field === "themeDelete") return send({ data: { themeDelete: loggie.themes.delete(variables.id) ? { deletedThemeId: variables.id, userErrors: [] } : { deletedThemeId: null, userErrors: [{ field: ["id"], message: "Theme does not exist" }] } } });
    const target = loggie.themes.get(variables.themeId);
    if (field === "themeFilesUpsert") {
      if (variables.files.length > 50) return send({ data: { themeFilesUpsert: { upsertedThemeFiles: [], userErrors: [{ field: ["files"], message: "You can only upload 50 files at a time" }] } } });
      const accepted = variables.files.filter(({ filename }) => !loggie.upsertErrors.has(filename));
      for (const { filename, body: { type, value } } of accepted) store(target, filename, type, value, loggie.wrongMd5.has(filename) ? "0".repeat(32) : undefined);
      const userErrors = variables.files.filter(({ filename }) => loggie.upsertErrors.has(filename)).map(({ filename }) => ({ field: ["files", filename], message: `${filename}: Liquid syntax error` }));
      return send({ data: { themeFilesUpsert: { upsertedThemeFiles: accepted.map(({ filename }) => ({ filename })), userErrors } } });
    }
    if (field === "themeFilesDelete") {
      const deleted = variables.files.filter((filename) => !loggie.stuckDeletes.has(filename));
      for (const filename of deleted) { target.files.delete(filename); target.bodies.delete(filename); }
      const userErrors = variables.files.filter((filename) => loggie.stuckDeletes.has(filename)).map((filename) => ({ field: ["files"], message: `${filename} could not be deleted` }));
      return send({ data: { themeFilesDelete: { deletedThemeFiles: deleted.map((filename) => ({ filename })), userErrors } } });
    }
    if (!theme) return send({ data: { theme: null } });
    const processing = theme.polls > 0;
    if (processing && query.includes("processing")) theme.polls--;
    const bodyOf = (filename) => {
      const { type, value } = theme.bodies.get(filename);
      return type === "TEXT" ? { content: value } : type === "BASE64" ? { contentBase64: value } : { url: `http://${req.headers.host}/cdn/${theme.id.split("/").at(-1)}/${filename}` };
    };
    const files = [...theme.files].map(([filename, checksumMd5]) => ({ filename, checksumMd5, ...(query.includes("body") && { body: bodyOf(filename) }) }))
      .filter(({ filename }) => !variables.filenames || variables.filenames.includes(filename));
    const start = Number(variables.after ?? 0), end = start + (variables.first ?? files.length);
    return send({ data: { theme: { id: theme.id, name: theme.name, role: theme.role, processing, files: { nodes: files.slice(start, end), pageInfo: { hasNextPage: end < files.length, endCursor: String(end) } } } } });
  };
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    if (req.url.startsWith("/api/proxy/")) return shopify(req, res, body);
    if (req.url.startsWith("/cdn/")) {
      const [, , number, ...path] = req.url.split("/"), file = loggie.themes.get(`gid://shopify/OnlineStoreTheme/${number}`)?.bodies.get(path.join("/"));
      res.writeHead(file ? 200 : 404); return res.end(file ? Buffer.from(file.value, "base64") : "");
    }
    const request = JSON.parse(body);
    const texts = request.messages.filter((message) => message.role === "user")
      .map((message) => typeof message.content === "string" ? message.content : message.content.map((part) => part.text ?? "").join("\n"));
    const text = texts.findLast((entry) => entry.includes('{\n  "action"'));
    const corrected = texts.at(-1).startsWith("Your previous final answer was not accepted");
    const continued = texts.at(-1).startsWith("Your assessment was returned incomplete");
    const feedback = texts.at(-1).startsWith(`${config.github.botName}'s validation failed`), turnStart = request.messages.at(-1).role === "user";
    const start = text.indexOf('{\n  "action"');
    const context = JSON.parse(text.slice(start, text.indexOf("\n}", start) + 2));
    const consolidating = text.includes("Consolidate the two independent reviews below");
    const mode = modes.get(context.item.number) ?? "normal";
    const seen = transient.seen.get(request.model) ?? 0;
    if ((mode === "transient" || (mode === "transient-mixed" && !request.model.includes("deepseek"))) && seen < transient.failures) {
      transient.seen.set(request.model, seen + 1);
      res.writeHead(503, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "Service temporarily unavailable" } }));
    }
    const key = `${context.item.number}/${request.model === config.storefront.model?.model ? config.providers.fixture.models[0].id : request.model}/${consolidating}/${context.database?.container ?? ""}`;
    const step = steps.get(key) ?? 0; steps.set(key, step + 1);
    requests.push({ request, text, context, consolidating });
    onModel?.(context, step);
    const review = context.action.startsWith("review") || context.action === "storefront_discover";
    let tool;
    if (review && step === 0) tool = mode === "grep" ? { name: "grep", args: { pattern: "value" } } : { name: "read", args: { path: mode === "nbsp" ? "src/a\u00a0b.ts" : scenario === "panel" ? "node_modules/pinned-runtime/package.json" : mode.startsWith("helper") ? "src/helper.ts" : mode === "at" ? "@src/app.ts" : "src/app.ts" } };
    if (review && scenario === "unicode_nfd" && step === 0) tool = { name: "read", args: { path: existsSync("seed/src/cafe\u0301.ts") ? "src/cafe\u0301.ts" : "src/caf\u00e9.ts" } };
    if (review && mode === "grep" && step === 1) tool = { name: "read", args: { path: "src/app.ts" } };
    if (review && scenario === "relevance" && step >= 2 && step <= 5) tool = { name: "read", args: { path: ["package.json", "pnpm-lock.yaml", "node_modules/wrangler/package.json", "assets/.vite/manifest.json"][step - 2] } };
    if (review && context.action === "review_base_change" && step === 1) tool = { name: "read_base", args: { path: "src/app.ts" } };
    if (review && context.action === "review_base_change" && step === 2) tool = { name: "git", args: { operation: "diff_stat", from: "base", to: "head" } };
    if (review && scenario === "panel" && step === 1) tool = { name: "read_base", args: { path: "src/app.ts" } };
    if (review && scenario === "panel" && step >= 2) {
      const dir = context.files.directory;
      tool = [{ name: "git", args: { operation: "diff_stat", from: "base", to: "head" } },
        { name: "git", args: { operation: "show", revision: "base", path: ".gitignore" } },
        { name: "git", args: { operation: "diff", from: "base", to: "head", path: "src/app.ts", limit: 20 } },
        { name: "read", args: { path: context.files.discussion } },
        { name: "git", args: { operation: "show", revision: "head", path: "--output=x" } },
        { name: "read", args: { path: resolve(dir, "../../pi-models-store.json") } },
        { name: "git", args: { operation: "show", revision: "head", path: "./src/app.ts" } },
        { name: "git", args: { operation: "show", revision: "head", path: "../outside" } },
        { name: "git", args: { operation: "show", revision: "head", path: "/etc/passwd" } },
        { name: "git", args: { operation: "show", revision: "HEAD@{1}", path: "src/app.ts" } },
        { name: "git", args: { operation: "show", revision: ":/x", path: "src/app.ts" } },
        { name: "git", args: { operation: "show", path: "src/app.ts" } },
        context.previous && { name: "git", args: { operation: "diff_stat", from: "previousMain", to: "main" } },
        consolidating && { name: "read", args: { path: dir + "/reviewer-1.md" } },
      ].filter(Boolean)[step - 2];
    }
    if (review && scenario === "git_paging" && step >= 1) {
      const fileArgs = { operation: "show", revision: "base", path: "src/huge.txt", limit: 1024 }, diffArgs = { operation: "diff", from: "base", to: "head", path: "src/huge.txt", limit: 1024 };
      tool = [{ name: "read_base", args: { path: "src/mid.txt" } },
        { name: "read_base", args: { path: "src/mid.txt", offset: 32768, limit: 1024 } },
        { name: "read_base", args: { path: "src/utf.txt", limit: 1001 } },
        { name: "git", args: fileArgs },
        { name: "git", args: diffArgs },
        { name: "git", args: { ...diffArgs, offset: 1024 } },
        { name: "git", args: { ...fileArgs, revision: "head", offset: 10_000_000 } },
        { name: "git", args: { operation: "diff_stat", from: "base", to: "head" } },
        { name: "git", args: { operation: "show", revision: "base", path: "src/missing.txt" } },
        { name: "git", args: { operation: "diff", from: "base", to: "head", limit: 1024 } },
      ][step - 1];
    }
    if (review && scenario === "scope_snapshots" && step === 0) tool = { name: "read_base", args: { path: "src/deleted.ts" } };
    if (review && scenario === "scope_snapshots" && step === 1) tool = { name: "read", args: { path: " leading.ts" } };
    if (review && scenario === "scope_snapshots" && step === 2) tool = { name: "read", args: { path: "src/generated.ts" } };
    if (!review && step === 0 && mode !== "no-change") {
      const mainSha = () => git(resolve("seed"), "rev-parse", "main");
      tool = mode === "remove-bad" ? { name: "bash", args: { command: "rm -f bad.txt" } }
        : mode === "resolve" ? { name: "bash", args: { command: `git -c user.name=Fixture -c user.email=fixture@example.invalid merge --no-commit ${mainSha()}; printf 'export const value = 300;\\n' > src/app.ts && git add src/app.ts` } }
        : mode === "merge-failure" ? { name: "bash", args: { command: `git -c user.name=Fixture -c user.email=fixture@example.invalid merge --no-commit ${git(resolve("seed"), "rev-parse", "main")}` } }
        : context.database ? { name: "bash", args: { command: `${process.execPath} ${resolve("database-command.mjs")} query ${context.item.number}` } }
          : { name: "write", args: { path: "src/app.ts", content: `export const value = ${context.item.number + 10};\n${scenario === "verification" ? "\n" : ""}` } };
    }
    if (!review && context.database && step === 1) tool = { name: "write", args: { path: "migration.sql", content: "ALTER TABLE identities ADD COLUMN IF NOT EXISTS extra integer;\n" } };
    if (!review && step === 0 && mode.startsWith("feedback-")) tool = { name: "bash", args: { command: `printf 'export const value = ${context.item.number + 10};\\n' > src/app.ts && touch fail-validation` } };
    if (!review && feedback && turnStart && mode === "feedback-fix") tool = { name: "bash", args: { command: "rm -f fail-validation" } };
    if (!review && step === 0 && mode === "heavy") tool = { name: "bash", args: { command: "nohup pnpm verify > log 2>&1 &" } };
    if (!review && step === 0 && mode === "heavy-bg") tool = { name: "bash", args: { command: "mkdir -p .scrat; touch .scrat/heavy-bg &" } };
    if (!review && step === 0 && mode === "heavy-fg") tool = { name: "bash", args: { command: "mkdir -p .scrat; touch .scrat/heavy-fg && printf 'export const value = 11;\\n' > src/app.ts" } };
    if (review && mode === "outside") tool = [{ name: "read", args: { path: resolve("outside-secret.txt") } }, { name: "read", args: { path: "src/link.txt" } },
      { name: "grep", args: { pattern: "outside", path: resolve(".") } }, { name: "ls", args: { path: ".." } }][step];
    if (!review && mode === "probe") tool = [{ name: "bash", args: { command: `${process.execPath} ${resolve("probe.mjs")} bash` } },
      { name: "write", args: { path: "src/app.ts", content: "export const value = 3;\n" } }][step];
    if (!review && mode === "outside-write") tool = [{ name: "write", args: { path: "../outside.txt", content: "escaped\n" } },
      { name: "write", args: { path: resolve("outside-new.txt"), content: "escaped\n" } },
      { name: "edit", args: { path: resolve("outside-secret.txt"), edits: [{ oldText: "outside-secret-content", newText: "escaped" }] } },
      { name: "write", args: { path: "linkdir/new/x.txt", content: "escaped\n" } },
      { name: "edit", args: { path: "linkdir/secret.txt", edits: [{ oldText: "a", newText: "b" }] } },
      { name: "write", args: { path: "src/new/file.ts", content: "export const added = 1;\n" } },
      { name: "edit", args: { path: "src/app.ts", edits: [{ oldText: "export const value = 1;", newText: "export const value = 9;" }] } }][step];
    if (!review && mode === "notes") tool = [{ name: "write", args: { path: ".scrat/notes.md", content: "Plan: change value\n" } },
      { name: "write", args: { path: "src/app.ts", content: "export const value = 5;\n" } }][step];
    if (!review && mode === "leak-file") tool = step === 0 ? { name: "write", args: { path: "src/app.ts", content: process.env.GITHUB_APP_PRIVATE_KEY } } : undefined;
    if (script) tool = script[step];
    const corrections = texts.filter((entry) => entry.startsWith("Your previous final answer was not accepted")).length, regressionGrade = (cleared) => cleared ? "C" : "A";
    const storefrontModes = { "storefront-verified": ["verified", "A"], "storefront-unavailable": ["unavailable", "A"], "storefront-regression": ["regression", regressionGrade(corrections > 0)],
      "storefront-missing-once": [corrections ? "verified" : "", "A"], "storefront-flip": [["regression", "verified", "regression"][corrections], regressionGrade(corrections > 1)],
      "storefront-split": [consolidating || !request.model.includes("deepseek") ? "regression" : "verified", regressionGrade(consolidating)] };
    const [storefrontLine = "verified", storefrontGrade] = storefrontModes[mode] ?? [];
    const scriptedReply = typeof tool === "string" ? tool : undefined;
    if (scriptedReply !== undefined) tool = undefined;
    const fumble = !corrected && (mode === "format-once" || (mode === "reviewer-grade-once" && review && !consolidating && request.model.includes("deepseek"))
      || (mode === "consolidation-grade-once" && consolidating));
    const outcome = ["incomplete", "needs_decision"].includes(mode) ? mode : mode === "incomplete-once" && !continued ? "incomplete" : "complete";
    const verdict = scenario.startsWith("commit_review") ? (consolidating && verdicts.consolidating) || verdicts[request.model] || verdicts.default : undefined;
    const output = (context.action === "storefront_discover" ? "- `/products/<handle>`: product page with add to cart." : review ? consolidating ? "Consolidated source-verified review." : `Independent review from ${request.model}.` : feedback ? "Fixed the validation failure." : "Implemented the change.")
      + (review && mode.startsWith("grade-") ? ` (${mode})` : "")
      + (scenario === "commit_review_e2e" ? " <!channel>" : "")
      + (mode === "leak-report" ? "\n" + process.env.GITHUB_APP_PRIVATE_KEY : "")
      + (mode.startsWith("quoted-") ? "\n```\nSCRAT_GRADE: F\nSCRAT_READY\n```" : "")
      + (mode.startsWith("issues") ? '\n```\nSCRAT_ISSUE_BEGIN\ntitle: Quoted\nfingerprint: quoted:one\n\nQuoted only.\nSCRAT_ISSUE_END\n```' : "")
      + (mode === "issues" ? '\nSCRAT_ISSUE_BEGIN\ntitle: Broken link\nfingerprint: link:docs-a\n\nThe link on docs/a is broken.\nSCRAT_ISSUE_END\nSCRAT_ISSUE_BEGIN\ntitle: Slow page\nfingerprint: perf:home\n\nHome takes 9s.\n\n```\ntrace\n```\nSCRAT_ISSUE_END' : "")
      + (mode === "issues-bad" ? '\nSCRAT_ISSUE_BEGIN\ntitle: Bad\nfingerprint: a --> <!-- b\n\nBad fingerprint.\nSCRAT_ISSUE_END' : "")
      + (mode === "revised" ? "\nRevised after the latest changes." : "")
      + (mode === "ready" ? "\nSCRAT_READY" : "")
      + (text.includes("\n## Storefront preview\n") && storefrontLine ? `\nSCRAT_STOREFRONT: ${storefrontLine}` : "")
      + (["review_pr", "my_pr_review"].includes(context.action) && !["missing-grade", "quoted-only"].includes(mode) && !(fumble && mode === "consolidation-grade-once") ? `\nSCRAT_GRADE: ${fumble ? "C+" : storefrontGrade ?? (["grade-A", "helper-grade-A", "quoted-grade"].includes(mode) ? "A" : mode === "grade-C" ? "C" : "B")}` : "")
      + (verdict ? `\nSCRAT_VERDICT: ${verdict}` : "")
      + (mode === "no-status" || (fumble && mode === "format-once" && !review) ? "" : mode === "bare-status" ? "\ncomplete" : `\nSCRAT_STATUS: ${outcome}`);
    const delta = tool ? { role: "assistant", tool_calls: [{ index: 0, id: "call_" + requests.length, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] } : { role: "assistant", content: scriptedReply ?? output };
    if (mode === "stall") {
      await new Promise((done) => { const timer = setTimeout(done, 60_000); res.on("close", () => { clearTimeout(timer); done(); }); });
      if (res.destroyed) return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end("data: " + JSON.stringify({ id: "local_" + requests.length, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: request.model,
      choices: [{ index: 0, delta, finish_reason: tool ? "tool_calls" : (["reviewer-failure", "transient-mixed"].includes(mode) && request.model.includes("deepseek")) || mode === "merge-failure" ? "length" : "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 } }) + "\n\ndata: [DONE]\n\n");
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const config = JSON.parse(readFileSync("app/scrat.config.json", "utf8"));
  const heavyCommands = config.workspace.heavyCommands;
  if (scenario !== "config_overrides") config.workspace = { ...config.workspace, environment: {}, prepare: [], database: null, validate: [["true"]], heavyCommands: scenario === "bash_guard" ? [...heavyCommands, "^touch \\.scrat/heavy-"] : [] };
  config.harness.agentRetry = { maxRetries: 0, baseDelayMs: 0 }; config.slack.minimumGapMs = 0;
  config.harness.maxConcurrency = 6; config.github.repository = "fixture/project"; config.github.repositoryPath = resolve("checkout");
  config.providers = { fixture: { api: "openai-completions", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "fixture", models: [
    { id: "gpt-6.1-sol", reasoning: true, input: ["text"], contextWindow: 32768, maxTokens: 4096 },
    { id: "gpt-6.1-terra", reasoning: true, input: ["text"], contextWindow: 32768, maxTokens: 4096 },
    { id: "deepseek/deepseek-v4.1-flash", reasoning: true, input: ["text"], contextWindow: 32768, maxTokens: 4096 },
  ] } };
  config.storefront.model = { ...config.storefront.model, provider: "fixture" };
  config.storefront.loggie = { ...config.storefront.loggie, url: `http://127.0.0.1:${server.address().port}`, slug: loggie.slug };
  config.actions = Object.fromEntries(readdirSync("app/actions").map((file) => parseYaml(readFileSync("app/actions/" + file, "utf8")))
    .map(({ name, reviewers = [] }) => [name, { provider: "fixture", ...reviewers.length && { reviewers: reviewers.map((reviewer) => ({ ...reviewer, provider: "fixture" })) } }]));
  for (const configure of spec.configure ?? []) configure(config);
  const { actions, ...fileSettings } = config;
  writeFileSync("app/scrat.config.json", JSON.stringify(fileSettings));
  writeFileSync("app/scrat.local.json", JSON.stringify({ actions }));
  mkdirSync("data");
  copyFileSync(schemaTemplate(repository), "data/scrat.sqlite");
  const app = async (path) => import(pathToFileURL(resolve("app/src", path)));
  const { db } = await app("db.ts"), schema = await app("schema.ts"), tasks = await app("tasks.ts"), { runNextTask } = await app("runner.ts");
  const slack = { calls: [], down: false, rateLimitOnce: false, retryAfter: "0", fail: null, reactionFail: null, rejectBlocks: false, sequence: 0 };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.hostname === "127.0.0.1") return originalFetch(input, options);
    if (url.hostname === "slack.com") {
      const slackBody = options.body ? JSON.parse(options.body) : {};
      slack.calls.push({ method: url.pathname.replace("/api/", ""), body: slackBody, token: new Headers(options.headers).get("authorization")?.replace(/^bearer /i, "") });
      const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });
      if (slack.down) return json({ ok: false, error: "service_unavailable" }, 503);
      if (slack.rateLimitOnce) { slack.rateLimitOnce = false; return json({ ok: false, error: "ratelimited" }, 429, { "retry-after": slack.retryAfter }); }
      if (slack.reactionFail && url.pathname.endsWith("/reactions.add")) { const error = slack.reactionFail.shift(); if (!slack.reactionFail.length) slack.reactionFail = null; return json({ ok: false, error }); }
      if (slack.fail) return json({ ok: false, error: slack.fail });
      if (slack.rejectBlocks && JSON.stringify(slackBody.blocks ?? []).includes('"type":"table"')) { slack.rejectBlocks = false; return json({ ok: false, error: "invalid_blocks" }); }
      if (url.pathname.endsWith("/reactions.add")) return json({ ok: true });
      return url.pathname.endsWith("/auth.test") ? json({ ok: true, team: "Fixture", user: "scrat" }) : json({ ok: true, channel: slackBody.channel, ts: `1700000000.${String(++slack.sequence).padStart(6, "0")}` });
    }
    if (/\.example\.(test|net)$/.test(url.hostname) || url.hostname === "169.254.169.254") {
      const headers = Object.fromEntries(new Headers(options.headers)), entry = { host: url.hostname, path: url.pathname + url.search, method: options.method ?? "GET", headers, body: options.body, redirect: options.redirect };
      external.push(entry);
      const text = (body, status = 200, extra = {}) => new Response(body, { status, headers: { "content-type": "text/plain", ...extra } });
      if (url.pathname === "/echo") return text(`you sent ${headers.authorization}`);
      if (url.pathname === "/redirect-off") return text("moved", 302, { location: "https://evil.example.net/steal?code=1" });
      if (url.pathname === "/redirect-on") return text("moved", 302, { location: "https://other.example.test/ok" });
      if (url.pathname === "/big") return text("x".repeat(400_000));
      return text(JSON.stringify({ ok: true, host: url.hostname }));
    }
    if (url.hostname === "api.github.com" && url.pathname === "/search/issues") {
      searches.push({ q: url.searchParams.get("q"), ifNoneMatch: new Headers(options.headers).get("if-none-match") });
      return new Response(JSON.stringify({ total_count: 1, items: [{ number: 7, node_id: "ISSUE_7", title: "Known flake", body: "Seen before. ".repeat(60), state: "open", html_url: "https://github.com/fixture/project/issues/7", updated_at: "2026-10-19T00:00:00Z", user: { login: "someone" }, labels: [{ name: "bug" }] }] }),
        { status: 200, headers: { "content-type": "application/json", etag: '"search"', "x-ratelimit-resource": "search", "x-ratelimit-remaining": "29", "x-ratelimit-limit": "30", "x-ratelimit-reset": String(rate.reset) } });
    }
    if (url.hostname !== "api.github.com") throw new Error("External network disabled");
    const path = url.pathname, method = options.method ?? "GET", body = options.body ? JSON.parse(options.body) : {};
    for (const pr of prs) {
      const sha = headOf(pr.head.ref);
      pr.head.sha = forced.get(pr.number) ?? sha;
      if (!frozen.has(pr.number) && pulled.get(pr.number) !== sha) { pulled.set(pr.number, sha); git(resolve("remote.git"), "update-ref", `refs/pull/${pr.number}/head`, sha); }
    }
    const credential = bearer(options);
    const call = { method, path: path + url.search, token: credential }; calls.push(call);
    const reply = (data, status = 200, extra = {}) => {
      const text = JSON.stringify(data), headers = { "content-type": "application/json", "x-ratelimit-limit": String(rate.limit), "x-ratelimit-reset": String(rate.reset), "x-ratelimit-resource": "core", ...extra };
      if (method === "GET" && status === 200) {
        headers.etag = `"${createHash("sha1").update(url.pathname + url.search + text).digest("hex")}"`;
        if (new Headers(options.headers).get("if-none-match") === headers.etag) {
          call.status = 304; return new Response(null, { status: 304, headers: { ...headers, "x-ratelimit-remaining": String(rate.remaining) } });
        }
      }
      call.status = status; if (!path.endsWith("/access_tokens")) rate.remaining--;
      return new Response(text, { status, headers: { ...headers, "x-ratelimit-remaining": String(rate.remaining) } });
    };
    const can = (permission) => tokens.get(credential)?.[permission] === "write";
    const lostResponse = (set, key, message, ok, status = 201) => set.delete(key) ? reply({ message }, 502) : reply(ok, status);
    if (patMode && credential !== pat) return reply({ message: "Bad credentials" }, 401);
    if (path === "/user") return user.status === 200 ? reply({ login: user.login }) : reply({ message: "Bad credentials" }, user.status);
    if (path === "/app") return reply({ slug: githubApp.slug });
    if (path.endsWith("/access_tokens")) {
      if (Object.keys(body.permissions).some((name) => faults.permissions.has(name))) return reply({ message: "The permissions requested are not granted to this installation." }, 422);
      const token = "ghs_fixture_" + tokens.size; tokens.set(token, body.permissions);
      return reply({ token, expires_at: new Date(Date.now() + 3600000).toISOString() }, 201);
    }
    if (path.endsWith("/issues") && method === "POST") {
      if (!can("issues")) return reply({ message: "Resource not accessible by integration" }, 403);
      const number = ++nextIssueNumber;
      const created = githubItem("issue", number, { title: body.title, body: body.body, updated_at: "2026-10-19T02:00:00Z", user: { login: config.github.botLogin } });
      issues.set(number, created); writes.push({ type: "issue", number, title: body.title });
      return lostResponse(faults.issue, body.title, "Lost issue response", created);
    }
    if (path.endsWith("/issues") && method === "GET") return reply([...issues.values(), ...prs.map((pr) => ({ ...pr, pull_request: {} }))].filter((item) => item.state === "open"));
    let match = path.match(/\/(issues|pulls)\/(\d+)$/);
    if (match && method === "GET") {
      const item = (match[1] === "issues" ? issues.get(Number(match[2])) : undefined) ?? prs.find((pr) => pr.number === Number(match[2]));
      return item ? reply(item) : reply({ message: "Not Found" }, 404);
    }
    match = path.match(/\/pulls\/(\d+)\/reviews$/);
    if (match) return reply(reviews.get(Number(match[1])) ?? []);
    if (/\/pulls\/\d+\/comments$/.test(path)) return reply([]);
    match = path.match(/\/issues\/(\d+)\/comments$/);
    if (match) {
      const n = Number(match[1]); if (method === "GET") {
        const all = comments.get(n) ?? [], size = Number(url.searchParams.get("per_page") ?? 30), page = Number(url.searchParams.get("page") ?? 1);
        const next = page * size < all.length ? { link: `<https://api.github.com${path}?per_page=${size}&page=${page + 1}>; rel="next"` } : {};
        return reply(all.slice((page - 1) * size, page * size), 200, next);
      }
      const permission = prs.some((pr) => pr.number === n) ? "pull_requests" : "issues";
      if (!can(permission)) return reply({ message: "Resource not accessible by integration" }, 403);
      writes.push({ type: "comment", number: n, body: body.body });
      const comment = { id: ++nextCommentId, body: body.body, user: { login: config.github.botLogin }, updated_at: "2026-10-19T01:00:00Z", html_url: `https://github.com/fixture/project/issues/${n}#comment` };
      comments.set(n, [...(comments.get(n) ?? []), comment]);
      if (faults.cleanup.delete(n)) { const run = db.select().from(schema.runs).all().find((run) => !run.finishedAt); const workspace = db.select().from(schema.workspaces).all().find((w) => w.id === run.workspaceId); writeFileSync(workspace.path + "/keep.txt", "preserve\n"); git(workspace.path, "add", "."); commit(workspace.path, "Unpublished"); }
      return lostResponse(faults.comment, n, "Lost response", comment);
    }
    match = path.match(/\/issues\/comments\/(\d+)$/);
    if (match && method === "PATCH") {
      const number = [...comments].find(([, entries]) => entries.some((comment) => comment.id === Number(match[1])))?.[0];
      const comment = [...comments.values()].flat().find((comment) => comment.id === Number(match[1]));
      if (!comment) return reply({ message: "Not Found" }, 404);
      comment.body = body.body; writes.push({ type: "comment_update", id: comment.id });
      return lostResponse(faults.comment, number, "Lost update response", comment, 200);
    }
    match = path.match(/\/issues\/(\d+)\/labels(?:\/(.+))?$/);
    if (match) {
      const n = Number(match[1]), item = issues.get(n) ?? prs.find((pr) => pr.number === n);
      if (!item) return reply({ message: "Not Found" }, 404);
      writes.push({ type: "label", number: n, method, name: match[2] && decodeURIComponent(match[2]) }); if (faults.label.delete(n)) return reply({ message: "Label failure" }, 503);
      if (method === "GET") return reply(item.labels);
      if (method === "DELETE") {
        const name = decodeURIComponent(match[2]);
        if (!item.labels.some((label) => label.name === name)) return reply({ message: "Label does not exist" }, 404);
        item.labels = item.labels.filter((label) => label.name !== name);
      } else for (const name of body.labels) if (!item.labels.some((label) => label.name === name)) item.labels.push({ name });
      return reply(item.labels);
    }
    match = path.match(/\/deployments(?:\/(\d+)\/statuses)?$/);
    if (match && method === "POST") {
      if (!can("deployments")) return reply({ message: "Resource not accessible by integration" }, 403);
      if (!match[1]) {
        const deployment = { id: deployments.length + 1, ref: body.ref, environment: body.environment, description: body.description, statuses: [] };
        deployments.push(deployment); writes.push({ type: "deployment", id: deployment.id, ref: body.ref });
        return reply({ id: deployment.id, ref: body.ref, environment: body.environment }, 201);
      }
      const deployment = deployments.find((entry) => entry.id === Number(match[1]));
      if (!deployment) return reply({ message: "Not Found" }, 404);
      deployment.statuses.push({ state: body.state, environmentUrl: body.environment_url, description: body.description, autoInactive: body.auto_inactive });
      writes.push({ type: "deployment_status", id: deployment.id, state: body.state });
      return reply({ id: deployment.statuses.length, state: body.state }, 201);
    }
    match = path.match(/\/commits\/([0-9a-f]+)\/check-runs$/);
    if (match) { if (tokens.get(credential)?.checks !== "read") return reply({ message: "Resource not accessible by integration" }, 403); const runs = checkRuns.get(match[1]) ?? []; return Object.defineProperty(reply({ total_count: runs.length, check_runs: runs }), "url", { value: url.href }); }
    if (path.endsWith("/pulls") && method === "GET") return reply(prs.filter((pr) => (!url.searchParams.get("head") || pr.head.ref === url.searchParams.get("head").split(":").slice(1).join(":")) && (url.searchParams.get("state") !== "open" || pr.state === "open")));
    if (path.endsWith("/pulls") && method === "POST") {
      if (!can("pull_requests") || !["read", "write"].includes(tokens.get(credential)?.contents)) {
        return reply({ message: "Validation Failed", errors: [{ resource: "PullRequest", code: "custom", message: "not all refs are readable" }] }, 422);
      }
      const n = Number(body.body.match(/Closes #(\d+)/)[1]); writes.push({ type: "pr", number: n });
      const pr = githubItem("pr", 200 + n, { node_id: "PR_" + n, title: body.title, body: body.body, updated_at: "2026-10-19T01:00:00Z", user: { login: config.github.botLogin }, head: { ref: body.head, sha: git(resolve("remote.git"), "rev-parse", body.head), repo: { full_name: "fixture/project" } }, base: { ref: "main", repo: { full_name: "fixture/project" } } });
      prs.push(pr); git(resolve("remote.git"), "update-ref", `refs/pull/${pr.number}/head`, pr.head.sha);
      return lostResponse(faults.pr, n, "Lost PR response", pr);
    }
    match = path.match(/\/commits\/([0-9a-f]+)\/comments$/);
    if (match) {
      if (method === "GET") return reply(commitComments.get(match[1]) ?? []);
      if (!can("contents") || faults.commitComment.delete(match[1])) return reply({ message: "Resource not accessible by integration" }, 403);
      const comment = { id: ++nextCommentId, body: body.body, user: { login: config.github.botLogin }, html_url: `https://github.com/fixture/project/commit/${match[1]}#commitcomment-${nextCommentId}` };
      commitComments.set(match[1], [...(commitComments.get(match[1]) ?? []), comment]); writes.push({ type: "commit_comment", sha: match[1], body: body.body });
      return reply(comment, 201);
    }
    match = path.match(/\/repos\/fixture\/project\/comments\/(\d+)$/);
    if (match && method === "PATCH") {
      const comment = [...commitComments.values()].flat().find((entry) => entry.id === Number(match[1]));
      comment.body = body.body; writes.push({ type: "commit_comment_update", id: comment.id, body: body.body });
      return reply(comment);
    }
    throw new Error(`Unexpected GitHub call: ${method} ${path}`);
  };
  const addIssue = (number, labels = [], title = "Issue " + number) => {
    const payload = githubItem("issue", number, { title, body: "Inspect app.ts", labels: labels.map((name) => ({ name })) });
    issues.set(number, payload); db.insert(schema.subjects).values({ id: "issue-" + number, repository: "fixture/project", kind: "item", key: payload.node_id }).run();
    return db.insert(schema.items).values({ id: "issue-" + number, externalId: payload.node_id, kind: "issue", payload }).returning().get();
  };
  const enqueue = (number, action = "review_issue", input = { source: "github_items", kind: "manual" }) => tasks.enqueueTask({ subjectId: "issue-" + number, action, reason: "Integration", input });
  const row = (table, id) => db.select().from(table).all().find((entry) => entry.id === id);
  const addPr = (number, branch, login, extra = {}) => { prs.push(githubItem("pr", number, { title: "PR " + number, body: "", user: { login }, head: { ref: branch, sha: git(resolve("remote.git"), "rev-parse", branch), repo: { full_name: "fixture/project" } }, base: { ref: "main", repo: { full_name: "fixture/project" } }, ...extra })); };
  const botComments = (number) => (comments.get(number) ?? []).filter((c) => c.user.login !== "human");
  const written = (type, predicate = () => true) => writes.filter((write) => write.type === type && predicate(write));
  return { app, db, schema, tasks, runNextTask, git, commit, config, external, searches, loggie, pat, user, githubApp, modes, verdicts, requests, calls, slack, rate, issues, prs, comments, reviews, writes, deployments, checkRuns, faults, transient, frozen, forced, addIssue, addPr, botComments, enqueue, row, written,
    set onModel(value) { onModel = value; },
    set script(value) { script = value; },
    reset(number, mode) { modes.set(number, mode); for (const key of steps.keys()) if (key.startsWith(number + "/")) steps.delete(key); },
    async close() { globalThis.fetch = originalFetch; db.$client.close(); server.closeAllConnections(); await new Promise((done) => server.close(done)); },
  };
}
