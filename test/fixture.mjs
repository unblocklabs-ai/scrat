import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { createServer } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";

export async function fixture(scenario) {
  const repository = fileURLToPath(new URL("..", import.meta.url));
  const root = mkdtempSync(resolve(tmpdir(), "scrat-integration-"));
  for (const path of ["src", "skills", "actions", "scrat.config.json", "package.json"]) cpSync(resolve(repository, path), resolve(root, "app", path), { recursive: true });
  symlinkSync(resolve(repository, "node_modules"), resolve(root, "app/node_modules"));
  process.chdir(root);
  const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const pulled = new Map();
  const headOf = (ref) => {
    try { return readFileSync(resolve("remote.git/refs/heads", ref), "utf8").trim(); } catch {}
    try { const packed = readFileSync(resolve("remote.git/packed-refs"), "utf8").split("\n").find((line) => line.endsWith(" refs/heads/" + ref)); if (packed) return packed.split(" ")[0]; } catch {}
    return git(resolve("remote.git"), "rev-parse", ref);
  };
  const commit = (cwd, message) => git(cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", message);
  execFileSync("git", ["init", "--bare", "remote.git"], { stdio: "ignore" });
  execFileSync("git", ["init", "-b", "main", "seed"], { stdio: "ignore" });
  mkdirSync("seed/src"); writeFileSync("seed/src/app.ts", "export const value = 1;\n");
  if (["validation_resume", "validation_guards", "resume_migration"].includes(scenario)) writeFileSync("seed/.gitignore", "node_modules/\n");
  if (scenario === "scope_snapshots") {
    writeFileSync("seed/.gitignore", "/src/generated.ts\n");
    writeFileSync("seed/src/deleted.ts", "export const deleted = 1;\n");
    writeFileSync("seed/src/renamed.ts", "export const renamed = 1;\n");
    writeFileSync("seed/ leading.ts", "export const leading = 1;\n");
  }
  if (scenario === "isolation") { writeFileSync("outside-secret.txt", "outside-secret-content\n"); symlinkSync(resolve("outside-secret.txt"), "seed/src/link.txt"); mkdirSync("outside-dir"); symlinkSync(resolve("outside-dir"), "seed/linkdir"); }
  if (scenario === "git_paging") {
    writeFileSync("seed/src/mid.txt", Array.from({ length: 200_000 }, (_, n) => `line ${n}`).join("\n") + "\n");
    writeFileSync("seed/src/utf.txt", "é".repeat(3000));
    writeFileSync("seed/src/huge.txt", ("a".repeat(63) + "\n").repeat(17 * 16384 + 10));
  }
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
  const patMode = scenario === "pat_auth", pat = "ghp_" + "a1B2c3D4e".repeat(4), user = { login: "Agent-Account", status: 200 };
  if (patMode) delete process.env.GITHUB_APP_PRIVATE_KEY;
  else process.env.GITHUB_APP_PRIVATE_KEY = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey;
  if (patMode || scenario === "isolation") process.env.GITHUB_PAT = pat;
  const scoped = ["scoped_http", "scoped_github_search", "scoped_browser", "bindings_startup"].includes(scenario);
  if (scoped) process.env.SCOUT_TOKEN = "scout-" + "k9Xq2LmPz7".repeat(3);
  if (scenario.startsWith("commit_review") || scenario === "publish_effects") process.env.SLACK_BOT_TOKEN = ["xoxb", "1234567890", "fixtureSlackToken"].join("-");
  process.env.PI_CODING_AGENT_DIR = resolve("pi-agent"); mkdirSync("pi-agent");
  const modes = new Map(), steps = new Map(), requests = [], calls = [], rate = { limit: 5000, remaining: 5000, reset: Math.floor(Date.now() / 1000) + 3600 }, issues = new Map(), prs = [], comments = new Map(), reviews = new Map(), writes = [];
  const faults = { label: new Set(), comment: new Set(), pr: new Set(), cleanup: new Set(), issue: new Set() };
  const tokens = new Map(patMode ? [[pat, { issues: "write", pull_requests: "write", contents: "write" }]] : []);
  let onModel, script, nextCommentId = 1000, nextIssueNumber = 500;
  const external = [], searches = [];
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    const texts = request.messages.filter((message) => message.role === "user")
      .map((message) => typeof message.content === "string" ? message.content : message.content.map((part) => part.text ?? "").join("\n"));
    const text = texts.findLast((entry) => entry.includes('{\n  "action"'));
    const corrected = texts.at(-1).startsWith("Your previous final answer was not accepted");
    const feedback = texts.at(-1).startsWith(`${config.github.botName}'s validation failed`), turnStart = request.messages.at(-1).role === "user";
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
    if (review && step === 0) tool = mode === "grep" ? { name: "grep", args: { pattern: "value" } } : { name: "read", args: { path: scenario === "unicode_scope" ? "src/a\u00a0b.ts" : scenario === "panel" ? "node_modules/pinned-runtime/package.json" : mode.startsWith("helper") ? "src/helper.ts" : mode === "at" ? "@src/app.ts" : "src/app.ts" } };
    if (review && scenario === "unicode_nfd" && step === 0) tool = { name: "read", args: { path: existsSync("seed/src/cafe\u0301.ts") ? "src/cafe\u0301.ts" : "src/caf\u00e9.ts" } };
    if (review && mode === "grep" && step === 1) tool = { name: "read", args: { path: "src/app.ts" } };
    if (review && ["relevance", "lockfile_scope", "importer_scope"].includes(scenario) && step >= 2 && step <= 4) tool = { name: "read", args: { path: ["package.json", "pnpm-lock.yaml", "node_modules/wrangler/package.json"][step - 2] } };
    if (review && scenario === "lockfile_scope" && step === 5) tool = { name: "read", args: { path: "node_modules/string-width-cjs/package.json" } };
    if (review && scenario.startsWith("commit_review") && step === 1) tool = { name: "read_base", args: { path: "src/app.ts" } };
    if (review && scenario.startsWith("commit_review") && step === 2) tool = { name: "git", args: { operation: "diff_stat", from: "base", to: "head" } };
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
    if (script && review) tool = script[step];
    const fumble = !corrected && (mode === "format-once" || (mode === "reviewer-grade-once" && review && !consolidating && request.model.includes("deepseek"))
      || (mode === "consolidation-grade-once" && consolidating));
    const outcome = ["incomplete", "needs_decision"].includes(mode) ? mode : "complete";
    const output = (review ? consolidating ? "Consolidated source-verified review." : `Independent review from ${request.model}.` : feedback ? "Fixed the validation failure." : "Implemented the change.")
      + (scenario === "commit_review_e2e" ? " <!channel>" : "")
      + (mode === "leak-report" ? "\n" + process.env.GITHUB_APP_PRIVATE_KEY : "")
      + (mode.startsWith("quoted-") ? "\n```\nSCRAT_GRADE: F\nSCRAT_READY\n```" : "")
      + (mode.startsWith("issues") ? '\n```\nSCRAT_ISSUE_BEGIN\ntitle: Quoted\nfingerprint: quoted:one\n\nQuoted only.\nSCRAT_ISSUE_END\n```' : "")
      + (mode === "issues" ? '\nSCRAT_ISSUE_BEGIN\ntitle: Broken link\nfingerprint: link:docs-a\n\nThe link on docs/a is broken.\nSCRAT_ISSUE_END\nSCRAT_ISSUE_BEGIN\ntitle: Slow page\nfingerprint: perf:home\n\nHome takes 9s.\n\n```\ntrace\n```\nSCRAT_ISSUE_END' : "")
      + (mode === "issues-bad" ? '\nSCRAT_ISSUE_BEGIN\ntitle: Bad\nfingerprint: a --> <!-- b\n\nBad fingerprint.\nSCRAT_ISSUE_END' : "")
      + (mode === "ready" ? "\nSCRAT_READY" : "")
      + (["review_pr", "my_pr_review"].includes(context.action) && !["missing-grade", "quoted-only"].includes(mode) && !(fumble && mode === "consolidation-grade-once") ? `\nSCRAT_GRADE: ${fumble ? "C+" : ["grade-A", "helper-grade-A", "quoted-grade"].includes(mode) ? "A" : mode === "grade-C" ? "C" : "B"}` : "")
      + (mode === "no-status" || (fumble && mode === "format-once" && !review) ? "" : mode === "bare-status" ? "\ncomplete" : `\nSCRAT_STATUS: ${outcome}`);
    const delta = tool ? { role: "assistant", tool_calls: [{ index: 0, id: "call_" + requests.length, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] } : { role: "assistant", content: output };
    if (mode === "stall") {
      await new Promise((done) => { const timer = setTimeout(done, 60_000); res.on("close", () => { clearTimeout(timer); done(); }); });
      if (res.destroyed) return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end("data: " + JSON.stringify({ id: "local_" + requests.length, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: request.model,
      choices: [{ index: 0, delta, finish_reason: tool ? "tool_calls" : (mode === "reviewer-failure" && request.model.includes("deepseek")) || mode === "merge-failure" ? "length" : "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 } }) + "\n\ndata: [DONE]\n\n");
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const config = JSON.parse(readFileSync("app/scrat.config.json", "utf8"));
  const heavyCommands = config.workspace.heavyCommands;
  if (scenario !== "config_overrides") config.workspace = scenario === "bash_guard" ? { heavyCommands: [...heavyCommands, "^touch \\.scrat/heavy-"] } : {};
  config.harness.maxConcurrency = 6; config.github.repository = "fixture/project"; config.github.repositoryPath = resolve("checkout");
  config.providers = { fixture: { api: "openai-completions", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "fixture", models: [
    { id: "gpt-6.1-sol", reasoning: true, input: ["text"], contextWindow: 32768, maxTokens: 4096 },
    { id: "deepseek/deepseek-v4.1-flash", reasoning: true, input: ["text"], contextWindow: 32768, maxTokens: 4096 },
  ] } };
  if (scenario === "commit_review_no_start") writeFileSync("app/actions/review_base_change.yaml", readFileSync("app/actions/review_base_change.yaml", "utf8").replace("start: [slack_post]\n", ""));
  if (scenario === "history_file") writeFileSync("app/actions/review_issue.yaml", readFileSync("app/actions/review_issue.yaml", "utf8").replace("files: [discussion]", "files: [discussion, history]"));
  config.actions = Object.fromEntries(readdirSync("app/actions").map((file) => parseYaml(readFileSync("app/actions/" + file, "utf8")))
    .map(({ name, reviewers = [] }) => [name, { provider: "fixture", ...reviewers.length && { reviewers: reviewers.map((reviewer) => ({ ...reviewer, provider: "fixture" })) } }]));
  if (scenario === "panel") {
    writeFileSync("prepare.mjs", 'import{mkdirSync,writeFileSync}from"node:fs";mkdirSync("node_modules/pinned-runtime",{recursive:true});writeFileSync("node_modules/pinned-runtime/package.json",JSON.stringify({name:"pinned-runtime",version:"9.8.7"}));');
    config.workspace.prepare = [[process.execPath, resolve("prepare.mjs")]];
  }
  if (scenario === "scope_snapshots") {
    writeFileSync("prepare.mjs", 'import{writeFileSync}from"node:fs";writeFileSync("src/generated.ts","export const generated = 1;\\n");');
    config.workspace.prepare = [[process.execPath, resolve("prepare.mjs")]];
  }
  if (["relevance", "lockfile_scope", "importer_scope"].includes(scenario)) {
    writeFileSync("prepare.mjs", 'import{mkdirSync,writeFileSync}from"node:fs";for(const name of ["wrangler","string-width-cjs"]){mkdirSync("node_modules/"+name,{recursive:true});writeFileSync("node_modules/"+name+"/package.json",JSON.stringify({name,version:"1.0.0"}));}');
    config.workspace.prepare = [[process.execPath, resolve("prepare.mjs")]];
  }
  if (scenario.startsWith("stale_branch")) {
    writeFileSync("prepare.mjs", 'import{existsSync}from"node:fs";for(const name of ["needed.txt","needed2.txt","needed3.txt","needed4.txt"]){if(existsSync(' + JSON.stringify(resolve(".") + "/require-") + '+name)&&!existsSync(name)){console.error("ERR_MISSING "+name);process.exit(1);}}');
    writeFileSync("validate.mjs", 'import{existsSync}from"node:fs";if(existsSync(' + JSON.stringify(resolve(".") + "/require-validation") + ')&&existsSync("bad.txt")){console.error("bad.txt must not exist");process.exit(7);}');
    config.workspace.prepare = [[process.execPath, resolve("prepare.mjs")]];
    config.workspace.validate = [[process.execPath, resolve("validate.mjs")]];
  }
  if (scenario === "isolation") {
    writeFileSync("probe.mjs", 'import{appendFileSync}from"node:fs";const leaked=Object.entries(process.env).filter(([name,value])=>/PRIVATE_KEY|API_KEY|GITHUB_PAT/.test(name)||value.includes("PRIVATE KEY-----")||value.includes("ghp_")).map(([name])=>name);'
      + 'appendFileSync(' + JSON.stringify(resolve("isolation.jsonl")) + ',JSON.stringify({phase:process.argv[2],leaked,configured:process.env.SCRAT_WORKSPACE_VALUE})+"\\n");');
    config.workspace = { environment: { SCRAT_WORKSPACE_VALUE: "isolated" }, prepare: [[process.execPath, resolve("probe.mjs"), "prepare"]], validate: [[process.execPath, resolve("probe.mjs"), "validate"]] };
  }
  if (["verification", "validation_mutation", "implement_base_moved"].includes(scenario)) {
    writeFileSync("check.mjs", scenario === "validation_mutation" ? 'import{writeFileSync}from"node:fs";writeFileSync("src/app.ts","unexpected verification change\\n");' : 'import{existsSync}from"node:fs";if(existsSync("fail-validation")){console.log("validation detail ghs_fixture_sensitive");console.error("Verification failed");process.exit(7);}console.log("checked actual source");');
    config.workspace.validate = [[process.execPath, resolve("check.mjs")]];
  }
  if (["validation_feedback", "validation_feedback_cap", "validation_slots", "self_repair", "bot_name", "crash_before_publishing", "deploy_stop_boundary"].includes(scenario)) {
    const flag = (name) => JSON.stringify(resolve(name));
    writeFileSync("validate.mjs", 'import{appendFileSync,existsSync}from"node:fs";const s=Date.now();await new Promise((r)=>setTimeout(r,existsSync(' + flag("slow") + ')?300:0));'
      + 'appendFileSync(' + flag("validations.log") + ',JSON.stringify({s,e:Date.now()})+"\\n");if(existsSync(' + flag("kill-validation") + '))process.kill(process.pid,"SIGKILL");if(existsSync(' + flag("exit-137") + '))process.exit(137);'
      + 'if(existsSync(' + flag("slot-fail") + ')||existsSync("fail-validation")){console.log("validation detail ghs_fixture_sensitive");console.error("Verification failed: marker present");process.exit(7);}');
    config.workspace.validate = [[process.execPath, resolve("validate.mjs")]];
  }
  if (scenario === "command_timeout") {
    writeFileSync("validate.mjs", 'await new Promise((r)=>setTimeout(r,30000));');
    config.workspace.validate = [[process.execPath, resolve("validate.mjs")]];
    config.harness.commandTimeoutSeconds = 1;
  }
  if (scenario === "agent_timeout") config.harness.agentTimeoutSeconds = 1;
  if (scenario === "deploy_stop_agent_timeout") config.harness.drainTimeoutSeconds = 1;
  if (["validation_resume", "validation_guards", "resume_migration"].includes(scenario)) {
    writeFileSync("prepare.mjs", 'import{appendFileSync,mkdirSync,writeFileSync}from"node:fs";appendFileSync(' + JSON.stringify(resolve("prepare.log")) + ',"prepare\\n");mkdirSync("node_modules",{recursive:true});writeFileSync("node_modules/prepared","ready");');
    config.workspace.prepare = [[process.execPath, resolve("prepare.mjs")]];
  }
  if (["validation_guards", "resume_migration"].includes(scenario)) {
    writeFileSync("block-validation", "transient failure\n");
    writeFileSync("validate.mjs", 'import{existsSync}from"node:fs";if(existsSync(' + JSON.stringify(resolve("block-validation")) + ')){console.error("transient validation failure");process.exit(7);}console.log("validated saved source");');
    config.workspace.validate = [[process.execPath, resolve("validate.mjs")]];
  }
  if (["database", "validation_resume"].includes(scenario)) {
    const helper = fileURLToPath(new URL("database-command.mjs", import.meta.url)); cpSync(helper, "database-command.mjs");
    config.workspace = { ...config.workspace, environment: { SCRAT_WORKSPACE_VALUE: "isolated" }, database: { image: "postgres:16-alpine", environment: ["DATABASE_URL", "TEST_DATABASE_URL"], migrate: [process.execPath, resolve("database-command.mjs"), "migrate"] }, validate: [[process.execPath, resolve("database-command.mjs"), scenario === "validation_resume" ? "validate-resume" : "validate", resolve("database-receipts.jsonl")]] };
  }
  if (scenario === "commits_source" || scenario === "commits_source_modes" || scenario === "publish_effects" || scenario.startsWith("commit_review")) Object.assign(config.actions.review_base_change, { enabled: true, channel: "C0123456789" });
  if (scenario === "commit_review_panel") Object.assign(config.actions.review_base_change, { agent: "panel", reviewers: structuredClone(config.actions.review_pr.reviewers) });
  if (scenario === "commit_review_isolation") {
    writeFileSync("prepare.mjs", 'import{appendFileSync}from"node:fs";appendFileSync(' + JSON.stringify(resolve("prepare.log")) + ',"prepare\\n");');
    config.workspace = { prepare: [[process.execPath, resolve("prepare.mjs")]], validate: [[process.execPath, resolve("prepare.mjs")]] };
  }
  if (scenario === "bot_name") config.github.botName = "Mocha";
  if (scenario === "bot_identity_names") config.github.botName = "Mocha Agent";
  if (scoped) config.bindings = { scout: { secret: "${SCOUT_TOKEN}", hosts: ["api.example.test", "other.example.test"], header: "Authorization", prefix: "Bearer " } };
  if (patMode) { config.github.auth = "pat"; config.github.botLogin = "agent-account"; }
  if (["scoped_http", "scoped_github_search", "scoped_browser", "bindings_startup"].includes(scenario)) {
    const scopedTools = { scoped_http: ["[read, grep, http]", "http: { binding: scout, methods: [GET] }"], bindings_startup: ["[read, grep, http]", "http: { binding: scout }"], scoped_github_search: ["[read, grep, github_search]", ""],
      scoped_browser: ["[read, grep, browser]", "browser: { navigationHosts: [shop.example.test], resourceHosts: [cdn.example.test], binding: scout }"] }[scenario];
    mkdirSync("deployment"); config.actions.directory = resolve("deployment");
    writeFileSync("deployment/review_issue.yaml", readFileSync("app/actions/review_issue.yaml", "utf8").replace(/^tools: .*$/m, "tools: " + scopedTools[0]).replace(/^skill: .*$/m, "skill: " + resolve("app/skills/review_issue/SKILL.md")).trimEnd() + "\n" + scopedTools[1] + "\n");
  }
  if (["manifest_directory", "manifest_tools_files"].includes(scenario)) {
    const directory = resolve("deployment"), shipped = (name) => readFileSync(`app/actions/${name}.yaml`, "utf8"), field = (text, key, value) => text.replace(new RegExp(`^${key}: .*$`, "m"), `${key}: ${value}`);
    mkdirSync(directory); config.actions.directory = directory;
    if (scenario === "manifest_directory") {
      mkdirSync("deployment/skills/review_triage", { recursive: true }); cpSync("app/skills/review_issue/SKILL.md", "deployment/skills/review_triage/SKILL.md");
      writeFileSync("deployment/review_triage.yaml", field(field(shipped("review_issue"), "name", "review_triage"), "skill", "skills/review_triage/SKILL.md"));
      config.actions.review_issue.enabled = false;
      config.actions.review_triage = { provider: "fixture" };
      writeFileSync("deployment/my_pr_review.yaml", field(field(shipped("review_pr"), "name", "my_pr_review"), "skill", resolve("app/skills/review_pr/SKILL.md")));
      config.actions.my_pr_review = { provider: "fixture", reviewers: structuredClone(config.actions.review_pr.reviewers) };
      config.actions.review_pr.enabled = false;
    } else {
      const skill = (name) => resolve("app/skills", name, "SKILL.md");
      writeFileSync("deployment/review_issue.yaml", field(field(field(shipped("review_issue"), "tools", "[read, grep]"), "files", "[]"), "skill", skill("review_issue")));
      writeFileSync("deployment/implement.yaml", field(field(field(shipped("implement"), "tools", "[read, grep, find, ls, edit, write]"), "files", "[discussion, history]"), "skill", skill("implement")));
    }
  }
  if (["schedule_source", "window_review"].includes(scenario)) {
    const directory = resolve("deployment"), skill = resolve("app/skills/review_issue/SKILL.md");
    mkdirSync(directory); config.actions.directory = directory;
    const sweep = (name, cron, window, tools) => writeFileSync(`deployment/${name}.yaml`, [
      `name: ${name}`, `trigger: { source: schedule, kind: tick, cron: "${cron}", window: ${window} }`, "mode: review", "agent: single", "context: all",
      `tools: [${tools}]`, "files: [history]", "publish: [issue]", `skill: ${skill}`,
      "model: { provider: codex-lb, model: gpt-6.1-sol, thinkingLevel: high }", "priority: 20", "",
    ].join("\n"));
    sweep("error_sweep", "0 */6 * * *", "6h", "read, grep, find, ls");
    config.actions.error_sweep = { provider: "fixture" };
    if (scenario === "schedule_source") { sweep("slow_sweep", "30 3 * * 1", "24h", "read, grep"); config.actions.slow_sweep = { provider: "fixture" }; }
  }
  const { actions, ...fileSettings } = config;
  writeFileSync("app/scrat.config.json", JSON.stringify(fileSettings));
  writeFileSync("app/scrat.local.json", JSON.stringify({ actions }));
  mkdirSync("data");
  execFileSync(process.execPath, [resolve(repository, "node_modules/drizzle-kit/bin.cjs"), "push", "--dialect=sqlite", "--schema=./app/src/schema.ts", "--url=./data/scrat.sqlite"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  const app = async (path) => import(pathToFileURL(resolve("app/src", path)));
  const { db } = await app("db.ts"), schema = await app("schema.ts"), tasks = await app("tasks.ts"), { runNextTask } = await app("runner.ts");
  const slack = { calls: [], down: false, rateLimitOnce: false, fail: null, sequence: 0 };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.hostname === "127.0.0.1") return originalFetch(input, options);
    if (url.hostname === "slack.com") {
      const slackBody = options.body ? JSON.parse(options.body) : {};
      slack.calls.push({ method: url.pathname.replace("/api/", ""), body: slackBody, token: new Headers(options.headers).get("authorization")?.replace(/^bearer /i, "") });
      const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });
      if (slack.down) return json({ ok: false, error: "service_unavailable" }, 503);
      if (slack.rateLimitOnce) { slack.rateLimitOnce = false; return json({ ok: false, error: "ratelimited" }, 429, { "retry-after": "0" }); }
      if (slack.fail) return json({ ok: false, error: slack.fail });
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
      pr.head.sha = sha;
      if (pulled.get(pr.number) !== sha) { pulled.set(pr.number, sha); git(resolve("remote.git"), "update-ref", `refs/pull/${pr.number}/head`, sha); }
    }
    const bearer = new Headers(options.headers).get("authorization")?.replace(/^(token|bearer) /i, "");
    const call = { method, path: path + url.search, token: bearer }; calls.push(call);
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
    if (patMode && bearer !== pat) return reply({ message: "Bad credentials" }, 401);
    if (path === "/user") return user.status === 200 ? reply({ login: user.login }) : reply({ message: "Bad credentials" }, user.status);
    if (path.endsWith("/access_tokens")) {
      const token = "ghs_fixture_" + tokens.size; tokens.set(token, body.permissions);
      return reply({ token, expires_at: new Date(Date.now() + 3600000).toISOString() }, 201);
    }
    if (path.endsWith("/issues") && method === "POST") {
      const token = new Headers(options.headers).get("authorization")?.replace(/^(token|bearer) /i, "");
      if (tokens.get(token)?.issues !== "write") return reply({ message: "Resource not accessible by integration" }, 403);
      const number = ++nextIssueNumber;
      const created = { id: number, node_id: "ISSUE_" + number, number, title: body.title, body: body.body, state: "open", html_url: `https://github.com/fixture/project/issues/${number}`, updated_at: "2026-10-19T02:00:00Z", labels: [], user: { login: config.github.botLogin } };
      issues.set(number, created); writes.push({ type: "issue", number, title: body.title });
      return faults.issue.delete(body.title) ? reply({ message: "Lost issue response" }, 502) : reply(created, 201);
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
      const number = [...comments].find(([, entries]) => entries.some((comment) => comment.id === Number(match[1])))?.[0];
      const comment = [...comments.values()].flat().find((comment) => comment.id === Number(match[1]));
      if (!comment) return reply({ message: "Not Found" }, 404);
      comment.body = body.body; writes.push({ type: "comment_update", id: comment.id });
      return faults.comment.delete(number) ? reply({ message: "Lost update response" }, 502) : reply(comment);
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
    issues.set(number, payload); db.insert(schema.subjects).values({ id: "issue-" + number, repository: "fixture/project", kind: "item", key: payload.node_id }).run();
    return db.insert(schema.items).values({ id: "issue-" + number, source: "github", externalId: payload.node_id, kind: "issue", payload }).returning().get();
  };
  const enqueue = (number, action = "review_issue", input = {}) => tasks.enqueueTask({ subjectId: "issue-" + number, action, reason: "Integration", input });
  const row = (table, id) => db.select().from(table).all().find((entry) => entry.id === id);
  return { app, db, schema, tasks, runNextTask, git, commit, config, external, searches, pat, user, modes, requests, calls, slack, rate, issues, prs, comments, reviews, writes, faults, addIssue, enqueue, row,
    set onModel(value) { onModel = value; },
    set script(value) { script = value; },
    reset(number, mode) { modes.set(number, mode); for (const key of steps.keys()) if (key.startsWith(number + "/")) steps.delete(key); },
    async close() { globalThis.fetch = originalFetch; db.$client.close(); server.closeAllConnections(); await new Promise((done) => server.close(done)); },
  };
}
