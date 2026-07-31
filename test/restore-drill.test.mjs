import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SearchStore } from "../dist/public-search/store.js";

test("isolated restore drill starts a backup and verifies aggregate state", async () => {
  const directory = join(tmpdir(), `atlas-restore-drill-${randomUUID()}`);
  const database = join(directory, "public-search.sqlite");
  const backups = join(directory, "backups");
  let store;
  try {
    mkdirSync(directory, { recursive: true });
    store = new SearchStore(database);
    store.index("https://example.test/guide", undefined, "Atlas guide", "A verified restore drill document.", "restore-drill-document");
    const backup = store.createBackup(backups);
    store.close(); store = undefined;
    const child = spawn(process.execPath, ["scripts/public-search-restore-drill.mjs", "--backup", join(backups, backup.file), "--json"], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
    const [code] = await new Promise((resolveExit) => child.once("exit", (...result) => resolveExit(result)));
    assert.equal(code, 0, stderr);
    const result = JSON.parse(stdout);
    assert.deepEqual({ ok: result.ok, schemaVersion: result.schemaVersion, documents: result.documents, jobs: result.jobs, frontier: result.frontier, domainBlocks: result.domainBlocks }, { ok: true, schemaVersion: 1, documents: 1, jobs: 0, frontier: 0, domainBlocks: 0 });
  } finally { store?.close(); rmSync(directory, { recursive: true, force: true }); }
});
