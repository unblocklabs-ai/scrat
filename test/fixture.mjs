import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { createServer } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function fixture(scenario) {
  const repository = fileURLToPath(new URL("..", import.meta.url));
  const root = mkdtempSync(resolve(tmpdir(), "scrat-integration-"));
  for (const path of ["src", "skills", "scrat.config.json", "package.json"]) cpSync(resolve(repository, path), resolve(root, "app", path), { recursive: true });
  symlinkSync(resolve(repository, "node_modules"), resolve(root, "app/node_modules"));
  process.chdir(root);
  const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const commit = (cwd, message) => git(cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", message);
  execFileSync("git", ["init", "--bare", "remote.git"], { stdio: "ignore" });
  execFileSync("git", ["init", "-b", "main", "seed"], { stdio: "ignore" });
  mkdirSync("seed/src"); writeFileSync("seed/src/app.ts", "export const value = 1;\n");
  if (scenario === "unicode_scope") writeFileSync("seed/src/a b.ts", "export const special = 1;\n");
  if (scenario === "unicode_nfd") writeFileSync("seed/src/caf\u00e9.ts", "export const unicode = 1;\n");
  if (["panel", "relevance", "lockfile_scope", "importer_scope"].includes(scenario)) writeFileSync("seed/.gitignore", "node_modules/\n");
  if (["relevance", "lockfile_scope", "importer_scope"].includes(scenario)) {
    writeFileSync("seed/package.json", JSON.stringify({ devDependencies: { wrangler: "1.0.0", unrelated: "1.0.0" } }));
    writeFileSync("seed/pnpm-lock.yaml", "lockfileVersion: '9.0'\npackages:\n  wrangler@1.0.0:\n    resolution: {integrity: old}\n  unrelated@1.0.0:\n    resolution: {integrity: old}\n");
    if (scenario === "lockfile_scope") writeFileSync("seed/pnpm-lock.yaml", readFileSync("seed/pnpm-lock.yaml", "utf8")
      + "  string-width-cjs@npm:string-width@4.2.2:\n    resolution: {integrity: alias}\nsnapshots:\n  wrangler@1.0.0:\n    dependencies: {nested: 1.0.0}\nimporters:\n  .:\n    devDependencies:\n      wrangler: {specifier: 1.0.0, version: 1.0.0}\n");
    if (scenario === "importer_scope") writeFileSync("seed/pnpm-lock.yaml", JSON.stringify({ lockfileVersion: "9.0",
      importers: { ".": { devDependencies: { wrangler: { specifier: "1.0.0", version: "1.0.0" }, unrelated: { specifier: "1.0.0", version: "1.0.0" } } } },
      packages: { "wrangler@1.0.0": { resolution: { integrity: "wrangler" } }, "unrelated@1.0.0": { resolution: { integrity: "unrelated" } } },
      snapshots: { "wrangler@1.0.0": {}, "unrelated@1.0.0": {} },
    }));
  }
  git(resolve("seed"), "add", "."); commit(resolve("seed"), "Initial source");
  git(resolve("seed"), "push", resolve("remote.git"), "main");
  execFileSync("git", ["--git-dir=" + resolve("remote.git"), "symbolic-ref", "HEAD", "refs/heads/main"]);
  writeFileSync("gitconfig", `[url "${resolve("remote.git")}"]\n insteadOf = https://github.com/fixture/project.git\n`);
  process.env.GIT_CONFIG_GLOBAL = resolve("gitconfig");
  process.env.GITHUB_APP_PRIVATE_KEY = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey;
  process.env.PI_CODING_AGENT_DIR = resolve("pi-agent"); mkdirSync("pi-agent");
  const modes = new Map(), steps = new Map(), requests = [], issues = new Map(), prs = [], comments = new Map(), reviews = new Map(), writes = [];
  const faults = { label: new Set(), comment: new Set(), pr: new Set(), cleanup: new Set() };
  const tokens = new Map();
  let onModel, nextCommentId = 1000;
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    const user = request.messages.findLast((message) => message.role === "user");
    const text = typeof user.content === "string" ? user.content : user.content.map((part) => part.text ?? "").join("\n");
    const start = text.indexOf('{\n  "action"');
    const context = JSON.parse(text.slice(start, text.indexOf("\n}", start) + 2));
    const consolidating = text.includes("Consolidate the two independent reviews below");
    const mode = modes.get(context.item.number) ?? "normal";
    const key = `${context.item.number}/${request.model}/${consolidating}/${context.database?.container ?? ""}`;
    const step = steps.get(key) ?? 0; steps.set(key, step + 1);
    requests.push({ request, text, context, consolidating });
    onModel?.(context, step);
    const review = context.action.startsWith("review");
    let tool;
    if (review && step === 0) tool = mode === "grep" ? { name: "grep", args: { pattern: "value" } } : { name: "read", args: { path: scenario === "unicode_scope" ? "src/a\u00a0b.ts" : scenario === "panel" ? "node_modules/pinned-runtime/package.json" : mode === "helper" ? "src/helper.ts" : mode === "at" ? "@src/app.ts" : "src/app.ts" } };
    if (review && scenario === "unicode_nfd" && step === 0) tool = { name: "read", args: { path: existsSync("seed/src/cafe\u0301.ts") ? "src/cafe\u0301.ts" : "src/caf\u00e9.ts" } };
    if (review && mode === "grep" && step === 1) tool = { name: "read", args: { path: "src/app.ts" } };
    if (review && ["relevance", "lockfile_scope", "importer_scope"].includes(scenario) && step >= 2 && step <= 4) tool = { name: "read", args: { path: ["package.json", "pnpm-lock.yaml", "node_modules/wrangler/package.json"][step - 2] } };
    if (review && scenario === "lockfile_scope" && step === 5) tool = { name: "read", args: { path: "node_modules/string-width-cjs/package.json" } };
    if (review && scenario === "panel" && step === 1) tool = { name: "read_base", args: { path: "src/app.ts" } };
    if (!review && step === 0) {
      tool = mode === "merge-failure" ? { name: "bash", args: { command: `git -c user.name=Fixture -c user.email=fixture@example.invalid merge --no-commit ${git(resolve("seed"), "rev-parse", "main")}` } }
        : context.database ? { name: "bash", args: { command: `${process.execPath} ${resolve("database-command.mjs")} query ${context.item.number}` } }
          : { name: "write", args: { path: "src/app.ts", content: `export const value = ${context.item.number + 10};\n${scenario === "verification" ? "\n" : ""}` } };
    }
    if (!review && context.database && step === 1) tool = { name: "write", args: { path: "migration.sql", content: "ALTER TABLE identities ADD COLUMN IF NOT EXISTS extra integer;\n" } };
    const outcome = ["incomplete", "needs_decision"].includes(mode) ? mode : "complete";
    const output = (review ? consolidating ? "Consolidated source-verified review." : `Independent review from ${request.model}.` : "Implemented the change.")
      + (mode.startsWith("quoted-") ? "\n```\nSCRAT_GRADE: F\nSCRAT_READY\n```" : "")
      + (mode === "ready" ? "\nSCRAT_READY" : "")
      + (context.action === "review_pr" && !["missing-grade", "quoted-only"].includes(mode) ? `\nSCRAT_GRADE: ${["grade-A", "quoted-grade"].includes(mode) ? "A" : "B"}` : "")
      + (mode === "no-status" ? "" : mode === "bare-status" ? "\ncomplete" : `\nSCRAT_STATUS: ${outcome}`);
    const delta = tool ? { role: "assistant", tool_calls: [{ index: 0, id: "call_" + requests.length, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] } : { role: "assistant", content: output };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end("data: " + JSON.stringify({ id: "local_" + requests.length, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: request.model,
      choices: [{ index: 0, delta, finish_reason: tool ? "tool_calls" : (mode === "reviewer-failure" && request.model.includes("deepseek")) || mode === "merge-failure" ? "length" : "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 } }) + "\n\ndata: [DONE]\n\n");
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const config = JSON.parse(readFileSync("app/scrat.config.json", "utf8"));
  config.workspace = {}; config.github.repository = "fixture/project"; config.github.repositoryPath = resolve("checkout");
  config.providers = { fixture: { api: "openai-completions", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "fixture", models: [
    { id: "gpt-6.1-sol", reasoning: true, input: ["text"], contextWindow: 32768, maxTokens: 4096 },
    { id: "deepseek/deepseek-v4.1-flash", reasoning: true, input: ["text"], contextWindow: 32768, maxTokens: 4096 },
  ] } };
  for (const action of Object.values(config.actions)) { action.provider = "fixture"; for (const reviewer of action.reviewers ?? []) reviewer.provider = "fixture"; }
  if (scenario === "panel") {
    writeFileSync("prepare.mjs", 'import{mkdirSync,writeFileSync}from"node:fs";mkdirSync("node_modules/pinned-runtime",{recursive:true});writeFileSync("node_modules/pinned-runtime/package.json",JSON.stringify({name:"pinned-runtime",version:"9.8.7"}));');
    config.workspace.prepare = [[process.execPath, resolve("prepare.mjs")]];
  }
  if (["relevance", "lockfile_scope", "importer_scope"].includes(scenario)) {
    writeFileSync("prepare.mjs", 'import{mkdirSync,writeFileSync}from"node:fs";for(const name of ["wrangler","string-width-cjs"]){mkdirSync("node_modules/"+name,{recursive:true});writeFileSync("node_modules/"+name+"/package.json",JSON.stringify({name,version:"1.0.0"}));}');
    config.workspace.prepare = [[process.execPath, resolve("prepare.mjs")]];
  }
  if (scenario === "verification" || scenario === "validation_mutation") {
    writeFileSync("check.mjs", scenario === "validation_mutation" ? 'import{writeFileSync}from"node:fs";writeFileSync("src/app.ts","unexpected verification change\\n");' : 'import{existsSync}from"node:fs";if(existsSync("fail-validation")){console.log("validation detail ghs_fixture_sensitive");console.error("Verification failed");process.exit(7);}console.log("checked actual source");');
    config.workspace.validate = [[process.execPath, resolve("check.mjs")]];
  }
  if (scenario === "database") {
    const helper = fileURLToPath(new URL("database-command.mjs", import.meta.url)); cpSync(helper, "database-command.mjs");
    config.workspace = { environment: { SCRAT_WORKSPACE_VALUE: "isolated" }, database: { image: "postgres:16-alpine", environment: ["DATABASE_URL", "TEST_DATABASE_URL"], migrate: [process.execPath, resolve("database-command.mjs"), "migrate"] }, validate: [[process.execPath, resolve("database-command.mjs"), "validate"]] };
  }
  writeFileSync("app/scrat.config.json", JSON.stringify(config));
  mkdirSync("data");
  execFileSync(process.execPath, [resolve(repository, "node_modules/drizzle-kit/bin.cjs"), "push", "--dialect=sqlite", "--schema=./app/src/schema.ts", "--url=./data/scrat.sqlite"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  const app = async (path) => import(pathToFileURL(resolve("app/src", path)));
  const { db } = await app("db.ts"), schema = await app("schema.ts"), tasks = await app("tasks.ts"), { runNextTask } = await app("runner.ts");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.hostname === "127.0.0.1") return originalFetch(input, options);
    if (url.hostname !== "api.github.com") throw new Error("External network disabled");
    const path = url.pathname, method = options.method ?? "GET", body = options.body ? JSON.parse(options.body) : {};
    for (const pr of prs) {
      pr.head.sha = git(resolve("remote.git"), "rev-parse", pr.head.ref);
      git(resolve("remote.git"), "update-ref", `refs/pull/${pr.number}/head`, pr.head.sha);
    }
    const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
    if (path.endsWith("/access_tokens")) {
      const token = "ghs_fixture_" + tokens.size; tokens.set(token, body.permissions);
      return reply({ token, expires_at: new Date(Date.now() + 3600000).toISOString() }, 201);
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
      const n = Number(match[1]); if (method === "GET") return reply(comments.get(n) ?? []);
      const token = new Headers(options.headers).get("authorization")?.replace(/^(token|bearer) /i, "");
      const permission = prs.some((pr) => pr.number === n) ? "pull_requests" : "issues";
      if (tokens.get(token)?.[permission] !== "write") return reply({ message: "Resource not accessible by integration" }, 403);
      writes.push({ type: "comment", number: n, body: body.body });
      const comment = { id: ++nextCommentId, body: body.body, user: { login: config.github.botLogin }, updated_at: "2026-10-19T01:00:00Z", html_url: `https://github.com/fixture/project/issues/${n}#comment` };
      comments.set(n, [...(comments.get(n) ?? []), comment]);
      if (faults.cleanup.delete(n)) { const run = db.select().from(schema.runs).all().find((run) => !run.finishedAt); const workspace = db.select().from(schema.workspaces).all().find((w) => w.id === run.workspaceId); writeFileSync(workspace.path + "/keep.txt", "preserve\n"); }
      return faults.comment.delete(n) ? reply({ message: "Lost response" }, 502) : reply(comment, 201);
    }
    match = path.match(/\/issues\/comments\/(\d+)$/);
    if (match && method === "PATCH") {
      const comment = [...comments.values()].flat().find((comment) => comment.id === Number(match[1]));
      if (!comment) return reply({ message: "Not Found" }, 404);
      comment.body = body.body; writes.push({ type: "comment_update", id: comment.id });
      return reply(comment);
    }
    match = path.match(/\/issues\/(\d+)\/labels(?:\/(.+))?$/);
    if (match) {
      const n = Number(match[1]), item = issues.get(n) ?? prs.find((pr) => pr.number === n);
      if (!item) return reply({ message: "Not Found" }, 404);
      writes.push({ type: "label", number: n }); if (faults.label.delete(n)) return reply({ message: "Label failure" }, 503);
      if (method === "GET") return reply(item.labels);
      if (method === "DELETE") {
        const name = decodeURIComponent(match[2]);
        if (!item.labels.some((label) => label.name === name)) return reply({ message: "Label does not exist" }, 404);
        item.labels = item.labels.filter((label) => label.name !== name);
      } else for (const name of body.labels) if (!item.labels.some((label) => label.name === name)) item.labels.push({ name });
      return reply(item.labels);
    }
    if (path.endsWith("/pulls") && method === "GET") return reply(prs.filter((pr) => (!url.searchParams.get("head") || pr.head.ref === url.searchParams.get("head").split(":").slice(1).join(":")) && (url.searchParams.get("state") !== "open" || pr.state === "open")));
    if (path.endsWith("/pulls") && method === "POST") {
      const token = new Headers(options.headers).get("authorization")?.replace(/^(token|bearer) /i, "");
      const permissions = tokens.get(token);
      if (permissions?.pull_requests !== "write" || !["read", "write"].includes(permissions.contents)) {
        return reply({ message: "Validation Failed", errors: [{ resource: "PullRequest", code: "custom", message: "not all refs are readable" }] }, 422);
      }
      const n = Number(body.body.match(/Closes #(\d+)/)[1]); writes.push({ type: "pr", number: n });
      const pr = { id: 200 + n, node_id: "PR_" + n, number: 200 + n, title: body.title, body: body.body, state: "open", html_url: `https://github.com/fixture/project/pull/${200 + n}`, labels: [], updated_at: "2026-10-19T01:00:00Z", user: { login: config.github.botLogin }, head: { ref: body.head, sha: git(resolve("remote.git"), "rev-parse", body.head), repo: { full_name: "fixture/project" } }, base: { ref: "main", repo: { full_name: "fixture/project" } } };
      prs.push(pr); git(resolve("remote.git"), "update-ref", `refs/pull/${pr.number}/head`, pr.head.sha);
      return faults.pr.delete(n) ? reply({ message: "Lost PR response" }, 502) : reply(pr, 201);
    }
    throw new Error(`Unexpected GitHub call: ${method} ${path}`);
  };
  const addIssue = (number, labels = []) => {
    const payload = { id: number, node_id: "ISSUE_" + number, number, title: "Issue " + number, body: "Inspect app.ts", state: "open", html_url: `https://github.com/fixture/project/issues/${number}`, updated_at: "2026-10-19T00:00:00Z", labels: labels.map((name) => ({ name })), user: { login: "human" } };
    issues.set(number, payload); return db.insert(schema.items).values({ id: "issue-" + number, source: "github", externalId: payload.node_id, kind: "issue", payload }).returning().get();
  };
  const enqueue = (number, action = "review_issue", input = {}) => tasks.enqueueTask({ itemId: "issue-" + number, action, reason: "Integration", input });
  const row = (table, id) => db.select().from(table).all().find((entry) => entry.id === id);
  return { root, app, db, schema, tasks, runNextTask, git, commit, config, modes, requests, issues, prs, comments, reviews, writes, faults, addIssue, enqueue, row,
    set onModel(value) { onModel = value; },
    reset(number, mode) { modes.set(number, mode); for (const key of steps.keys()) if (key.startsWith(number + "/")) steps.delete(key); },
    async close() { globalThis.fetch = originalFetch; db.$client.close(); server.closeAllConnections(); await new Promise((done) => server.close(done)); },
  };
}
