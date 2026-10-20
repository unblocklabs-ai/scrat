import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
const [phase, owner] = process.argv.slice(2);
assert.equal(process.env.SCRAT_WORKSPACE_VALUE, "isolated");
assert.equal(process.env.DATABASE_URL, process.env.TEST_DATABASE_URL);
const url = new URL(process.env.DATABASE_URL);
assert.equal(url.hostname, "127.0.0.1");
const containers = execFileSync("docker", ["ps", "--format", "{{.ID}} {{.Ports}}"], { encoding: "utf8" });
const id = containers.split("\n").find((line) => line.includes(`127.0.0.1:${url.port}->5432/tcp`))?.split(" ")[0];
assert.ok(id);
const sql = (command) => execFileSync("docker", ["exec", id, "psql", "-U", "postgres", "-d", "scrat_test", "-v", "ON_ERROR_STOP=1", "-At", "-c", command], { encoding: "utf8" }).trim();
if (phase === "migrate") {
  sql("CREATE TABLE IF NOT EXISTS identities (owner integer)");
  if (existsSync("migration.sql")) sql(readFileSync("migration.sql", "utf8"));
} else if (phase === "query") {
  sql(`INSERT INTO identities VALUES (${Number(owner)})`);
  assert.equal(sql("SELECT count(*) FROM identities"), "1");
} else if (phase === "validate") {
  assert.equal(sql("SELECT count(extra) FROM identities"), "0");
  assert.equal(sql("SELECT count(*) FROM identities"), "1");
} else if (phase === "validate-resume") {
  assert.equal(sql("SELECT count(extra) FROM identities"), "0", "Saved migration must be applied to every new database");
  const rows = Number(sql("SELECT count(*) FROM identities"));
  const first = !existsSync(owner);
  appendFileSync(owner, JSON.stringify({ id, rows, url: process.env.DATABASE_URL }) + "\n");
  if (first) { assert.equal(rows, 1); process.kill(process.pid, "SIGKILL"); }
  assert.equal(rows, 0, "Validation-only resume must use a fresh migrated database without rerunning agent inserts");
}
