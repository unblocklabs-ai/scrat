import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fixture } from "./fixture.mjs";

const scenario = process.argv[2];
const f = await fixture(scenario);
const { db, schema: s, tasks, git, commit } = f;
const all = (table) => db.select().from(table).all();
const route = async () => (await f.app("github-sync.ts")).syncGitHub();
const run = async () => { const r = await f.runNextTask(); assert.ok(r); return r; };
const success = async () => { const r = await run(); assert.equal(r.error, null, JSON.stringify(r.error)); return r; };
const implement = async (n) => { f.addIssue(n, ["scrat"]); f.enqueue(n, "implement"); return success(); };
const changeMain = (path, text) => {
  writeFileSync(resolve("seed", path), text); git(resolve("seed"), "add", "."); commit(resolve("seed"), "Change " + path);
  git(resolve("seed"), "push", resolve("remote.git"), "main");
};
try {
  if (scenario === "queue") {
    for (let n = 1; n <= 9; n++) f.addIssue(n);
    f.enqueue(1); f.enqueue(2, "implement"); const first = f.enqueue(3, "review_pr", { version: 1 });
    const coalesced = f.enqueue(3, "review_pr", { version: 2 });
    assert.equal(coalesced.id, first.id); assert.equal(coalesced.input.version, 2);
    assert.equal(tasks.claimTask().task.action, "review_pr");
    assert.equal(tasks.claimTask().task.action, "implement");
    for (let n = 4; n <= 9; n++) f.enqueue(n);
    for (let n = 0; n < 4; n++) assert.ok(tasks.claimTask());
    assert.equal(tasks.claimTask(), undefined);
    assert.equal(all(s.tasks).filter((t) => t.status === "running").length, 6);
    for (const r of all(s.runs)) tasks.finishRun(r.id, { status: "completed" });
    const { createWorkspace } = await f.app("workspaces.ts");
    const { fetchRepository } = await f.app("git.ts");
    await fetchRepository(f.config.github.repositoryPath, "https://github.com/fixture/project.git", "main");
    const w = await createWorkspace({ repositoryPath: f.config.github.repositoryPath });
    const { eq } = await import("drizzle-orm");
    db.update(s.items).set({ workspaceId: w.id }).where(eq(s.items.id, "issue-8")).run();
    db.update(s.items).set({ workspaceId: w.id }).where(eq(s.items.id, "issue-9")).run();
    const claimed = []; let next; while ((next = tasks.claimTask())) claimed.push(next);
    assert.equal(claimed.filter((c) => ["issue-8", "issue-9"].includes(c.item.id)).length, 1);
  } else if (scenario === "panel") {
    await implement(1); f.prs[0].labels.push({ name: "human-label" }); await route();
    const review = await success();
    assert.equal(review.reviewers.length, 2);
    assert.deepEqual(review.reviewers.map((r) => r.model), ["gpt-6.1-sol", "deepseek/deepseek-v4.1-flash"]);
    assert.equal(new Set([...review.reviewers.map((r) => r.piSessionId), review.piSessionId]).size, 3);
    assert.ok(review.reviewers.every((r) => r.result?.outcome === "complete"));
    for (const model of ["gpt-6.1-sol", "deepseek/deepseek-v4.1-flash"]) {
      assert.ok(f.requests.some((r) => r.context.action === "review_pr" && !r.consolidating && r.request.model === model
        && r.request.messages.some((m) => m.role === "tool" && JSON.stringify(m.content).includes("9.8.7"))), "Reviewer must read the prepared dependency in its own workspace");
      assert.ok(f.requests.some((r) => r.context.action === "review_pr" && !r.consolidating && r.request.model === model
        && r.request.messages.some((m) => m.role === "tool" && JSON.stringify(m.content).includes("export const value = 1;"))), "Reviewer must read the immutable base file, not the modified head");
    }
    for (const request of f.requests.filter((r) => r.context.action === "review_pr")) {
      assert.deepEqual(request.context.diffPaths, ["src/app.ts"]); assert.match(request.context.diffBaseSha, /^[a-f0-9]{40}$/);
    }
    assert.equal(f.writes.filter((w) => w.type === "comment" && w.number === 201).length, 1);
    assert.match(f.comments.get(201)[0].body, /Consolidated/);
    assert.equal(review.result.grade, "B");
    assert.deepEqual(f.prs[0].labels.map((label) => label.name).sort(), ["B · Solid", "human-label"]);
    for (const req of f.requests.filter((r) => r.context.action === "review_pr" && !r.consolidating)) assert.ok(!req.text.includes("Independent review from"));
    // Adopt a pre-upgrade review comment too, without deleting its historical run.
    f.comments.get(201)[0].body = f.comments.get(201)[0].body.replace("<!-- scrat-review -->\n", "");
    f.modes.set(201, "grade-A");
    changeMain("src/app.ts", "export const value = 99;\n"); await route();
    assert.deepEqual(f.prs[0].labels.map((label) => label.name), ["human-label"]);
    f.faults.label.add(201); const failed = await run(); assert.ok(failed.error); const calls = f.requests.length;
    tasks.retryTask(failed.taskId); const rereview = await success(); assert.equal(f.requests.length, calls);
    assert.equal(rereview.publication.commentId, review.publication.commentId);
    assert.equal(f.comments.get(201).length, 1);
    assert.equal(f.writes.filter((w) => w.type === "comment_update").length, 1);
    assert.deepEqual(f.prs[0].labels.map((label) => label.name).sort(), ["A · Strong", "human-label"]);
    const itemId = f.row(s.tasks, review.taskId).itemId;
    f.reset(201, "normal"); tasks.enqueueTask({ itemId, action: "review_pr", reason: "Manual review", input: {} });
    f.faults.label.add(201); const older = await run(); assert.ok(older.error);
    f.reset(201, "grade-A"); tasks.enqueueTask({ itemId, action: "review_pr", reason: "Newer manual review", input: {} });
    await success(); const writes = f.writes.length, inferences = f.requests.length;
    tasks.retryTask(older.taskId); const superseded = await success();
    assert.equal(superseded.publication.status, "not_needed");
    assert.equal(f.writes.length, writes); assert.equal(f.requests.length, inferences);
    assert.deepEqual(f.prs[0].labels.map((label) => label.name).sort(), ["A · Strong", "human-label"]);
  } else if (scenario === "canonical") {
    await implement(1); await route(); f.faults.comment.add(201);
    const lost = await run(); assert.ok(lost.error); assert.equal(lost.stage, "publishing");
    const original = f.comments.get(201)[0];
    const feedback = { ...original, id: 9000, body: "Feedback quoting the review:\n```\n" + original.body + "\n```\n<!-- scrat-task:feedback -->" };
    f.comments.get(201).push(feedback);
    const calls = f.requests.length; tasks.retryTask(lost.taskId); const recovered = await success();
    assert.equal(f.requests.length, calls); assert.equal(recovered.publication.commentId, original.id);
    f.reset(201, "grade-A");
    tasks.enqueueTask({ itemId: f.row(s.tasks, lost.taskId).itemId, action: "review_pr", reason: "New assessment", input: {} });
    const updated = await success(); assert.equal(updated.publication.commentId, original.id);
    assert.equal(f.comments.get(201).length, 2); assert.equal(f.comments.get(201)[1].body, feedback.body);
    assert.deepEqual(f.prs[0].labels.map((label) => label.name), ["A · Strong"]);
  } else if (scenario === "deleted_review" || scenario === "unreceipted_review") {
    await implement(1); await route(); f.faults.label.add(201);
    const older = await run(); assert.ok(older.error); assert.ok(older.publication.commentId);
    const itemId = f.row(s.tasks, older.taskId).itemId;
    f.reset(201, "grade-A"); tasks.enqueueTask({ itemId, action: "review_pr", reason: "New assessment", input: {} });
    if (scenario === "unreceipted_review") f.faults.comment.add(201);
    const newer = await run();
    if (scenario === "deleted_review") {
      assert.equal(newer.error, null);
      f.comments.set(201, []);
    } else {
      assert.ok(newer.error); assert.equal(newer.publication.commentId, undefined);
      assert.match(f.comments.get(201)[0].body, new RegExp(newer.taskId));
    }
    const calls = f.requests.length, updates = f.writes.filter((w) => w.type === "comment_update").length;
    tasks.retryTask(older.taskId); const superseded = await success();
    assert.equal(superseded.publication.status, "not_needed");
    assert.equal(f.requests.length, calls); assert.equal(f.comments.get(201).length, 1);
    assert.match(f.comments.get(201)[0].body, new RegExp(newer.taskId));
    assert.deepEqual(f.prs[0].labels.map((label) => label.name), ["A · Strong"]);
    assert.equal(f.row(s.runs, newer.id).publication.commentId, f.comments.get(201)[0].id);
    const delivered = all(s.events).findLast((event) => scenario === "deleted_review"
      ? event.type === "github.comment_created" && event.data.commentId === f.comments.get(201)[0].id
      : event.type === "github.labels_added" && event.data.labels.includes("A · Strong"));
    assert.equal(delivered.runId, newer.id);
    if (scenario === "deleted_review") {
      f.comments.set(201, []); await route();
      assert.equal(f.requests.length, calls); assert.equal(f.comments.get(201).length, 1);
      assert.match(f.comments.get(201)[0].body, new RegExp(newer.taskId));
    } else {
      assert.equal(f.writes.filter((w) => w.type === "comment_update").length, updates);
      tasks.retryTask(newer.taskId); await success(); assert.equal(f.requests.length, calls);
    }
  } else if (scenario === "grade_race") {
    await implement(1); await route(); const reviewed = await success();
    tasks.enqueueTask({ itemId: f.row(s.tasks, reviewed.taskId).itemId, action: "review_pr", reason: "Fresh review", input: {} });
    f.reset(201, "normal"); changeMain("src/app.ts", "export const value = 99;\n");
    let unblock, sawRemoval, sawPublicationContext;
    const blocked = new Promise((resolve) => { unblock = resolve; });
    const removal = new Promise((resolve) => { sawRemoval = resolve; });
    const context = new Promise((resolve) => { sawPublicationContext = resolve; });
    const fetch = globalThis.fetch, before = f.requests.length;
    let held = false;
    globalThis.fetch = async (input, options = {}) => {
      const url = new URL(typeof input === "string" ? input : input.url);
      if (!held && options.method === "DELETE" && url.pathname.includes("/issues/201/labels/")) {
        held = true; sawRemoval(); await blocked;
      }
      const response = await fetch(input, options);
      if (url.pathname.endsWith("/pulls/201") && f.requests.slice(before).some((r) => r.consolidating)) sawPublicationContext();
      return response;
    };
    try {
      const syncing = route(); await removal;
      const working = run(); await context; unblock();
      const [, published] = await Promise.all([syncing, working]);
      assert.equal(published.error, null, JSON.stringify(published.error));
      assert.deepEqual(f.prs[0].labels.map((label) => label.name), ["B · Solid"]);
    } finally { unblock(); globalThis.fetch = fetch; }
  } else if (scenario === "grade_failure") {
    await implement(1); await implement(2); await route(); await success(); await success();
    changeMain("src/app.ts", "export const value = 99;\n");
    f.faults.label.add(201); await route();
    for (const number of [201, 202]) assert.ok(all(s.tasks).some((t) => t.status === "queued" && f.row(s.items, t.itemId).payload.number === number));
    assert.deepEqual(f.prs[0].labels.map((label) => label.name), ["B · Solid"]);
    await route(); assert.deepEqual(f.prs[0].labels, []);
  } else if (scenario === "absent_labels") {
    f.addIssue(1); const { reconcileLabels } = await f.app("labels.ts");
    const request = () => reconcileLabels("fixture/project", 1, { current: ["scrat"], desired: [], managed: ["scrat"] });
    await request();
    assert.equal(all(s.events).filter((e) => e.type === "github.label_removed").length, 0);
    f.issues.get(1).labels = [{ name: "scrat" }];
    const fetch = globalThis.fetch;
    globalThis.fetch = async (input, options = {}) => options.method === "DELETE"
      ? new Response(JSON.stringify({ message: "Not Found" }), { status: 404, headers: { "content-type": "application/json" } }) : fetch(input, options);
    try { await assert.rejects(request(), (error) => error.status === 404); }
    finally { globalThis.fetch = fetch; }
    f.issues.delete(1);
    await assert.rejects(request(), (error) => error.status === 404);
  } else if (scenario === "footer") {
    await implement(1); f.modes.set(201, "quoted-grade"); await route();
    const reviewed = await success();
    assert.equal(reviewed.result.grade, "A");
    assert.match(f.comments.get(201)[0].body, /```\nSCRAT_GRADE: F\nSCRAT_READY\n```/);
    assert.deepEqual(f.prs[0].labels.map((label) => label.name), ["A · Strong"]);
    f.reset(201, "quoted-only");
    tasks.enqueueTask({ itemId: f.row(s.tasks, reviewed.taskId).itemId, action: "review_pr", reason: "Review again", input: {} });
    const invalid = await run(); assert.match(invalid.error.message, /grade/i);
    assert.deepEqual(f.prs[0].labels.map((label) => label.name), ["A · Strong"]);
    f.addIssue(2); f.modes.set(2, "quoted-only"); f.enqueue(2);
    const issue = await success(); assert.equal(issue.result.ready, false);
    assert.deepEqual(f.issues.get(2).labels, []);
  } else if (scenario === "reviewer_failure") {
    await implement(2); await route(); f.modes.set(202, "reviewer-failure");
    const r = await run(); assert.ok(r.error); assert.ok(r.reviewers.some((r) => r.error));
    assert.equal(f.requests.filter((r) => r.consolidating).length, 0);
    assert.equal(f.writes.filter((w) => w.type === "comment").length, 0);
    assert.ok(f.row(s.workspaces, r.workspaceId).removedAt);
    f.reset(202, "missing-grade"); tasks.retryTask(r.taskId);
    const invalid = await run(); assert.match(invalid.error.message, /grade/i);
    assert.equal(f.writes.filter((w) => w.type === "comment").length, 0);
  } else if (scenario === "incomplete") {
    for (const [i, mode] of ["incomplete", "needs_decision", "no-status", "bare-status"].entries()) {
      f.addIssue(i + 1); f.enqueue(i + 1, "implement"); f.modes.set(i + 1, mode);
      const r = await run(); assert.ok(r.error); assert.equal(f.row(s.tasks, r.taskId).status, "failed");
      assert.ok(existsSync(f.row(s.workspaces, r.workspaceId).path + "/src/app.ts"));
    }
    assert.equal(f.prs.length, 0); assert.equal(f.writes.length, 0);
  } else if (scenario === "verification") {
    const r = await implement(1);
    assert.equal(r.verification.headSha, r.publication.publishedCommitSha);
    assert.match(r.verification.commands[0].stdout, /checked actual source/);
    assert.equal(git(resolve("remote.git"), "rev-parse", f.prs[0].head.ref), r.verification.headSha);
    changeMain("fail-validation", "fail\n");
    f.addIssue(2); f.enqueue(2, "implement"); const failed = await run();
    assert.ok(failed.error); assert.equal(f.prs.length, 1); assert.equal(failed.verification, null);
    assert.equal(failed.error.exitCode, 7);
    assert.match(failed.error.stdout, /validation detail \[redacted\]/);
    assert.match(failed.error.stderr, /Verification failed/);
    assert.ok(!JSON.stringify(failed.error).includes("ghs_fixture_sensitive"));
  } else if (scenario === "validation_mutation") {
    f.addIssue(1); f.enqueue(1, "implement"); const r = await run();
    assert.match(r.error.message, /Validation changed/); assert.equal(f.prs.length, 0);
  } else if (scenario === "retry") {
    for (const [n, fault] of [[1, "label"], [2, "comment"]]) {
      f.addIssue(n, ["human-label"]); f.modes.set(n, "ready"); f.enqueue(n); f.faults[fault].add(n);
      const failed = await run(); assert.ok(failed.error); const calls = f.requests.length;
      tasks.retryTask(failed.taskId); const completed = await success();
      assert.equal(completed.retryOfRunId, failed.id); assert.equal(f.requests.length, calls);
      assert.equal(f.writes.filter((w) => w.type === "comment" && w.number === n).length, 1);
      assert.deepEqual(f.issues.get(n).labels.map((label) => label.name).sort(), ["human-label", "scrat"]);
    }
    f.modes.set(1, "normal"); f.enqueue(1); await success();
    assert.deepEqual(f.issues.get(1).labels.map((label) => label.name), ["human-label"]);
  } else if (scenario === "ambiguous_pr") {
    f.addIssue(1); f.enqueue(1, "implement"); f.faults.pr.add(1);
    const failed = await run(); assert.ok(failed.error); assert.equal(f.prs.length, 1); const calls = f.requests.length;
    tasks.retryTask(failed.taskId); const completed = await success();
    assert.equal(completed.publication.pullRequestNumber, 201); assert.equal(f.prs.length, 1); assert.equal(f.requests.length, calls);
  } else if (scenario === "freshness") {
    f.addIssue(1); await route(); f.modes.set(1, "ready");
    f.onModel = () => { f.issues.get(1).body = "New requirements"; };
    const r = await run(); assert.match(r.error.message, /context changed/); assert.equal(f.writes.length, 0);
    f.onModel = undefined; await route(); assert.ok(all(s.tasks).some((t) => t.status === "queued"));
    f.addIssue(2); f.enqueue(2, "implement"); f.onModel = () => { f.issues.get(2).body = "Changed implementation requirements"; };
    const stale = await run(); assert.match(stale.error.message, /context changed/); assert.equal(f.prs.length, 0);
  } else if (scenario === "relevance") {
    f.addIssue(1); f.modes.set(1, "grep"); await route(); const r = await success();
    assert.ok(r.result.paths.includes("src/app.ts")); assert.ok(!r.result.paths.includes("."));
    changeMain("notes.md", "new docs\n"); await route(); assert.ok(!all(s.tasks).some((t) => t.status === "queued"));
    changeMain("package.json", JSON.stringify({ devDependencies: { wrangler: "1.0.0", unrelated: "2.0.0" } }));
    changeMain("pnpm-lock.yaml", "lockfileVersion: '9.0'\npackages:\n  wrangler@1.0.0:\n    resolution: {integrity: old}\n  unrelated@2.0.0:\n    resolution: {integrity: new}\n");
    await route(); assert.ok(!all(s.tasks).some((t) => t.status === "queued"), "Unrelated dev dependencies must not trigger review");
    changeMain("package.json", JSON.stringify({ devDependencies: { wrangler: "2.0.0", unrelated: "2.0.0" } }));
    await route(); assert.ok(all(s.tasks).some((t) => t.status === "queued"), "Inspected dependency changes must trigger review");
  } else if (scenario === "lockfile_scope") {
    f.addIssue(1); f.modes.set(1, "grep"); await route(); await success();
    let lock = readFileSync("seed/pnpm-lock.yaml", "utf8");
    for (const update of [
      (text) => text.replace("integrity: old", "integrity: changed").replace("unrelated@1.0.0", "unrelated@2.0.0"),
      (text) => text.replace("npm:string-width@4.2.2", "npm:string-width@4.2.3").replace("unrelated@2.0.0", "unrelated@3.0.0"),
      (text) => text.replace("nested: 1.0.0", "nested: 2.0.0").replace("unrelated@3.0.0", "unrelated@4.0.0"),
      (text) => text.replace("version: 1.0.0}", "version: 2.0.0}").replace("unrelated@4.0.0", "unrelated@5.0.0"),
      (text) => text + "unknownSetting: changed\n",
    ]) {
      lock = update(lock); changeMain("pnpm-lock.yaml", lock); await route();
      assert.ok(all(s.tasks).some((t) => t.itemId === "issue-1" && t.status === "queued"), lock);
      f.reset(1, "grep"); await success();
    }
    changeMain("pnpm-lock.yaml", lock.replace("unrelated@5.0.0", "unrelated@6.0.0")); await route();
    assert.ok(!all(s.tasks).some((t) => t.itemId === "issue-1" && t.status === "queued"));
  } else if (scenario === "importer_scope") {
    f.addIssue(1); f.modes.set(1, "grep"); await route(); await success();
    const lock = JSON.parse(readFileSync("seed/pnpm-lock.yaml", "utf8"));
    const bump = (name, version) => {
      const entry = lock.importers["."].devDependencies[name];
      const old = name + "@" + entry.version, next = name + "@" + version;
      delete lock.packages[old]; delete lock.snapshots[old];
      lock.packages[next] = { resolution: { integrity: version } }; lock.snapshots[next] = {};
      entry.specifier = version; entry.version = version;
    };
    bump("unrelated", "2.0.0");
    changeMain("package.json", JSON.stringify({ devDependencies: { wrangler: "1.0.0", unrelated: "2.0.0" } }));
    changeMain("pnpm-lock.yaml", JSON.stringify(lock)); await route();
    assert.ok(!all(s.tasks).some((t) => t.itemId === "issue-1" && t.status === "queued"));
    for (const update of [
      () => bump("wrangler", "2.0.0"),
      () => { lock.importers["."].devDependencies.alternate = { specifier: "npm:wrangler@2.0.0", version: "wrangler@2.0.0" }; },
      () => { lock.importers["."].devDependencies.unrelated = { specifier: "workspace:*", version: "link:../unrelated" }; },
      () => { lock.importers["."].injectedSetting = true; },
      () => { lock.importers["."].devDependencies.unrelated = "3.0.0"; },
      () => { lock.importers["packages/new"] = {}; },
    ]) {
      update(); changeMain("pnpm-lock.yaml", JSON.stringify(lock)); await route();
      assert.ok(all(s.tasks).some((t) => t.itemId === "issue-1" && t.status === "queued"));
      f.reset(1, "grep"); await success();
    }
  } else if (scenario === "unicode_scope") {
    f.addIssue(1); await route(); await success();
    assert.ok(f.requests.some((r) => r.request.messages.some((m) => m.role === "tool" && JSON.stringify(m.content).includes("export const special = 1;"))));
    changeMain("src/a b.ts", "export const special = 2;\n"); await route();
    assert.ok(all(s.tasks).some((t) => t.itemId === "issue-1" && t.status === "queued"));
    f.reset(1, "normal");
    let changed = false;
    f.onModel = (_context, step) => { if (step === 1 && !changed) { changed = true; changeMain("src/a b.ts", "export const special = 3;\n"); } };
    const stale = await run(); assert.match(stale.error.message, /Reviewed code changed/);
  } else if (scenario === "unicode_nfd") {
    f.addIssue(1); await route(); const reviewed = await success();
    assert.ok(f.requests.some((r) => r.request.messages.some((m) => m.role === "tool" && JSON.stringify(m.content).includes("export const unicode = 1;"))));
    assert.ok(reviewed.result.paths.includes("src/caf\u00e9.ts"));
    const { eq } = await import("drizzle-orm");
    db.update(s.runs).set({ result: { ...reviewed.result, paths: ["src/cafe\u0301.ts"] } }).where(eq(s.runs.id, reviewed.id)).run();
    changeMain("src/caf\u00e9.ts", "export const unicode = 2;\n"); await route();
    assert.ok(all(s.tasks).some((t) => t.itemId === "issue-1" && t.status === "queued"));
    f.reset(1, "normal"); let changed = false;
    f.onModel = (_context, step) => { if (step === 1 && !changed) { changed = true; changeMain("src/caf\u00e9.ts", "export const unicode = 3;\n"); } };
    const stale = await run(); assert.match(stale.error.message, /Reviewed code changed/);
  } else if (scenario === "legacy_scope") {
    f.addIssue(1); await route(); let reviewed = await success();
    const { eq } = await import("drizzle-orm");
    for (const paths of [[".", "src/app.ts"], ["."]]) {
      db.update(s.runs).set({ result: { ...reviewed.result, paths } }).where(eq(s.runs.id, reviewed.id)).run();
      changeMain("notes.md", JSON.stringify(paths)); await route();
      assert.ok(all(s.tasks).some((t) => t.itemId === "issue-1" && t.status === "queued"));
      reviewed = await success();
    }
  } else if (scenario === "review_scope") {
    f.addIssue(1); f.modes.set(1, "at"); await route();
    const reviewed = await success(); assert.ok(reviewed.result.paths.includes("src/app.ts"));
    changeMain("src/app.ts", "export const value = 9;\n"); await route();
    assert.ok(all(s.tasks).some((t) => t.itemId === "issue-1" && t.status === "queued"));
    changeMain("src/helper.ts", "export const helper = 1;\n");
    await implement(2); await route(); f.modes.set(202, "helper");
    let changed = false;
    f.onModel = (context) => {
      if (!changed && context.item.number === 202) { changed = true; changeMain("src/app.ts", "export const value = 99;\n"); }
    };
    const stale = await run(); assert.match(stale.error.message, /Reviewed code changed/);
    assert.ok(stale.result.paths.includes("src/app.ts")); assert.ok(stale.result.paths.includes("src/helper.ts"));
    assert.equal(f.writes.filter((w) => w.type === "comment" && w.number === 202).length, 0);
  } else if (scenario === "merge") {
    const original = await implement(1); changeMain("src/app.ts", "export const value = 200;\n");
    await route(); f.modes.set(201, "merge-failure");
    // Conflict repair and reviews share the item; explicitly take repair first here.
    const { eq } = await import("drizzle-orm");
    for (const t of all(s.tasks).filter((t) => t.action === "review_pr")) db.update(s.tasks).set({ status: "cancelled" }).where(eq(s.tasks.id, t.id)).run();
    const failed = await run(); assert.ok(failed.error);
    const w = f.row(s.workspaces, original.workspaceId);
    assert.ok(await (await f.app("git.ts")).hasPendingMerge(w.path));
    f.reset(201, "normal"); tasks.retryTask(failed.taskId); const recovered = await success();
    assert.equal(f.requests.findLast((r) => r.context.action === "resolve_conflicts").context.workspace.mergeInProgress, true);
    assert.equal(git(w.path, "show", "-s", "--format=%P").split(" ").length, 2);
    assert.equal(recovered.workspaceId, original.workspaceId);
  } else if (scenario === "reopen") {
    const original = await implement(1); await route();
    f.prs[0].state = "closed"; await route(); assert.ok(f.row(s.workspaces, original.workspaceId).removedAt);
    f.prs[0].state = "open"; await (await f.app("github-sync.ts")).syncGitHub(undefined, false); await route();
    const pr = all(s.items).find((i) => i.kind === "pr"); assert.equal(pr.workspaceId, null);
    assert.ok(all(s.tasks).some((t) => t.itemId === pr.id && t.status === "queued"));
  } else if (scenario === "existing_pr") {
    await implement(1); f.addIssue(2, ["scrat"]); f.prs[0].body += "\nFixes #2";
    f.enqueue(2, "implement"); await route();
    assert.ok(!all(s.tasks).some((t) => t.itemId === "issue-2" && t.status === "queued"));
    assert.ok(all(s.tasks).some((t) => t.action === "review_pr" && t.status === "queued"));
  } else if (scenario === "recovery") {
    f.addIssue(1); f.enqueue(1); const claim = tasks.claimTask();
    const { eq } = await import("drizzle-orm");
    db.update(s.runs).set({ stage: "publishing", result: { text: "Saved", ready: false, paths: [], outcome: "complete" }, publication: { status: "pending", commentId: 123 } }).where(eq(s.runs.id, claim.run.id)).run();
    execFileSync(process.execPath, [resolve("app/src/recover.ts"), claim.run.id], { stdio: "pipe" });
    const r = f.row(s.runs, claim.run.id); assert.equal(r.error.code, "RUN_INTERRUPTED"); assert.equal(r.result.text, "Saved"); assert.equal(r.publication.commentId, 123);
    tasks.retryTask(r.taskId); assert.ok(tasks.claimTask());
  } else if (scenario === "cleanup") {
    f.addIssue(1); f.enqueue(1); f.faults.cleanup.add(1); const r = await success();
    assert.equal(f.row(s.tasks, r.taskId).status, "completed"); const w = f.row(s.workspaces, r.workspaceId);
    assert.equal(w.removedAt, null); assert.equal(readFileSync(w.path + "/keep.txt", "utf8"), "preserve\n");
    unlinkSync(w.path + "/keep.txt"); execFileSync(process.execPath, [resolve("app/src/cleanup.ts")], { stdio: "pipe" });
    assert.ok(f.row(s.workspaces, r.workspaceId).removedAt);
  } else if (scenario === "identity") {
    const original = await implement(1); const w = f.row(s.workspaces, original.workspaceId);
    const { removeWorkspace } = await f.app("workspaces.ts");
    git(w.path, "switch", "-c", "replacement");
    f.enqueue(1, "implement"); const calls = f.requests.length;
    const failed = await run(); assert.match(failed.error.message, /identity changed/);
    assert.equal(f.requests.length, calls); await assert.rejects(removeWorkspace(w.id), /identity changed/);
    git(w.path, "switch", w.branch); writeFileSync(w.path + "/unpublished.txt", "retain\n");
    git(w.path, "add", "."); commit(w.path, "Unpublished work");
    await assert.rejects(removeWorkspace(w.id), /unpublished commits/);
    assert.equal(readFileSync(w.path + "/unpublished.txt", "utf8"), "retain\n");
    f.prs[0].state = "closed"; f.addIssue(2); await route();
    assert.ok(all(s.tasks).some((t) => t.itemId === "issue-2" && t.status === "queued"));
  } else if (scenario === "feedback") {
    await implement(1); await route(); await success();
    const summary = { id: 55, body: "Please change the implementation", user: { login: "human" }, submitted_at: "2026-10-19T00:00:00Z", html_url: "https://github.com/fixture/project/pull/201#review" };
    f.reviews.set(201, [summary]); await route(); await success(); await success();
    summary.body = "Edited request with different requirements"; await route();
    assert.ok(all(s.tasks).some((t) => t.action === "address_pr_feedback" && t.status === "queued"));
    const before = all(s.tasks).find((t) => t.action === "review_pr" && t.status === "queued").input.triggerKey;
    git(resolve("remote.git"), "update-ref", "refs/heads/alternate", git(resolve("remote.git"), "rev-parse", "main"));
    f.prs[0].base.ref = "alternate"; await route();
    const after = all(s.tasks).find((t) => t.action === "review_pr" && t.status === "queued").input.triggerKey;
    assert.notEqual(after, before);
  } else if (scenario === "commit_hook") {
    f.addIssue(1); f.enqueue(1, "implement");
    f.onModel = (_context, step) => {
      if (step) return;
      const hook = resolve(f.config.github.repositoryPath, ".git/hooks/pre-commit");
      copyFileSync(hook + ".sample", hook);
      writeFileSync(hook, '#!/bin/sh\nprintf "export const value = 909;\\n" > src/app.ts\ngit add src/app.ts\n');
    };
    const r = await run(); assert.match(r.error.message, /Committed tree differs/);
    assert.equal(r.verification, null); assert.equal(f.prs.length, 0);
  } else if (scenario === "database") {
    const original = process.env.DATABASE_URL; f.addIssue(1); f.addIssue(2); f.enqueue(1, "implement"); f.enqueue(2, "implement");
    const runs = await Promise.all([f.runNextTask(), f.runNextTask()]);
    for (const r of runs) assert.equal(r.error, null, JSON.stringify(r.error));
    const urls = new Set(f.requests.map((r) => r.context.database.url)); assert.equal(urls.size, 2);
    assert.equal(process.env.DATABASE_URL, original);
    for (const r of runs) assert.equal(execFileSync("docker", ["ps", "-a", "--filter", `name=^/scrat-v2-db-${r.id}$`, "--format", "{{.ID}}"], { encoding: "utf8" }).trim(), "");
  } else throw new Error("Unknown scenario " + scenario);
  console.log("SCENARIO_PASSED " + scenario);
} finally { await f.close(); }
