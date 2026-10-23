import { execFile } from "node:child_process";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { config } from "./config.ts";
import { recordEvent, type EventReferences } from "./events.ts";
import { withOperation } from "./logging.ts";

const executeFile = promisify(execFile);
const runLabel = "ai.unblock.scrat.v2.database";
const containerName = (runId: string) => `scrat-v2-db-${runId}`;

async function docker(args: string[]) {
  const { stdout } = await executeFile("docker", args, { maxBuffer: config.harness.maxOutputBytes });
  return stdout.trim();
}

export async function createRunDatabase(runId: string, image: string, references: EventReferences = {}) {
  const container = containerName(runId);
  const password = randomBytes(24).toString("hex");
  return withOperation("database.create", { ...references, runId, container, image }, async (operation) => {
    await docker(["create", "--name", container, "--label", `${runLabel}=${runId}`,
      "--publish", "127.0.0.1::5432", "--env", `POSTGRES_PASSWORD=${password}`, "--env", "POSTGRES_DB=scrat_test",
      "--health-cmd", "pg_isready -h 127.0.0.1 -U postgres -d scrat_test",
      "--health-interval", "1s", "--health-timeout", "3s", "--health-retries", "30", image]);
    await docker(["start", container]);
    while (true) {
      const [state, health] = (await docker(["inspect", "--format", "{{.State.Status}} {{.State.Health.Status}}", container])).split(" ");
      if (state === "running" && health === "healthy") break;
      if (state !== "running" || health === "unhealthy") {
        const { stdout, stderr } = await executeFile("docker", ["logs", "--tail", "50", container]);
        throw new Error(`Run database failed to start (${state}/${health}): ${stdout}${stderr}`);
      }
      await setTimeout(500);
    }
    const address = await docker(["port", container, "5432/tcp"]);
    recordEvent({ ...references, runId, operationId: operation.operationId, type: "database.created", data: { container, image } });
    operation.complete();
    return { container, url: `postgresql://postgres:${password}@${address}/scrat_test` };
  });
}

export async function removeRunDatabase(runId: string, references: EventReferences = {}) {
  const container = containerName(runId);
  return withOperation("database.remove", { ...references, runId, container }, async (operation) => {
    const id = await docker(["ps", "--all", "--filter", `name=^/${container}$`, "--filter", `label=${runLabel}=${runId}`, "--format", "{{.ID}}"]);
    if (!id) { operation.complete({ alreadyRemoved: true }); return; }
    await docker(["rm", "--force", "--volumes", id]);
    recordEvent({ ...references, runId, operationId: operation.operationId, type: "database.removed", data: { container } });
    operation.complete();
  });
}

export async function listRunDatabases() {
  const ids = await docker(["ps", "--all", "--filter", `label=${runLabel}`, "--format", `{{.Label "${runLabel}"}}`]);
  return ids.split("\n").filter(Boolean);
}
