import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
function hasArgument(name) { return process.argv.includes(name); }

async function availablePort() {
  const server = createServer();
  await new Promise((resolvePort, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolvePort); });
  const address = server.address();
  await new Promise((resolveClose) => server.close(resolveClose));
  if (!address || typeof address === "string") throw new Error("Could not allocate an isolated restore-drill port.");
  return address.port;
}

function inspectBackup(path) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const integrity = database.prepare("PRAGMA integrity_check").get().integrity_check;
    if (integrity !== "ok") throw new Error("Backup integrity check failed.");
    const count = (table) => database.prepare(`SELECT count(*) AS count FROM ${table}`).get().count;
    return { schemaVersion: database.prepare("SELECT coalesce(max(version), 0) AS version FROM schema_migrations").get().version, documents: count("documents"), jobs: count("crawl_jobs"), frontier: count("frontier"), domainBlocks: count("domain_blocks") };
  } finally { database.close(); }
}

async function waitForReady(baseUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/ready`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok && (await response.json()).ready === true) return;
    } catch { /* The isolated process may still be starting. */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Restored public-search did not become ready within ${Math.ceil(timeoutMs / 1_000)} seconds.`);
}

const input = argument("--backup");
if (!input) throw new Error("Usage: node scripts/public-search-restore-drill.mjs --backup <snapshot.sqlite> [--timeout-seconds 20] [--json]");
const backup = resolve(input);
if (!/^public-search-[\w-]+\.sqlite$/.test(basename(backup))) throw new Error("Backup must use the generated public-search-*.sqlite filename.");
const timeoutSeconds = Number(argument("--timeout-seconds") || 20);
if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 5 || timeoutSeconds > 120) throw new Error("--timeout-seconds must be an integer from 5 to 120.");
const expected = inspectBackup(backup);
const workdir = await mkdtemp(join(tmpdir(), "atlas-public-search-restore-drill-"));
const restoredDatabase = join(workdir, "public-search.sqlite");
const port = await availablePort();
const token = randomUUID();
const baseUrl = `http://127.0.0.1:${port}`;
let child;
let childExit;

try {
  await copyFile(backup, restoredDatabase);
  child = spawn(process.execPath, [join("dist", "public-search", "server.js")], {
    cwd: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
    env: { ...process.env, PUBLIC_SEARCH_PORT: String(port), PUBLIC_SEARCH_DB: restoredDatabase, PUBLIC_SEARCH_BACKUP_DIR: join(workdir, "backups"), PUBLIC_SEARCH_ADMIN_TOKEN: token },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  childExit = new Promise((resolveExit) => child.once("exit", (code) => { if (code !== 0) stderr ||= `isolated process exited with code ${code}`; resolveExit(); }));
  await waitForReady(baseUrl, timeoutSeconds * 1_000);
  const response = await fetch(`${baseUrl}/v1/admin/metrics`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3_000) });
  if (!response.ok) throw new Error(`Restored service metrics request failed (${response.status}). ${stderr}`);
  const metrics = await response.json();
  const actual = { schemaVersion: metrics.database.schemaVersion, documents: metrics.documents.total, jobs: metrics.jobs.total, frontier: metrics.frontier.total, domainBlocks: (await fetch(`${baseUrl}/v1/admin/domain-blocks`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3_000) }).then(async (result) => result.ok ? (await result.json()).blocks.length : -1)) };
  for (const key of Object.keys(expected)) if (actual[key] !== expected[key]) throw new Error(`Restore drill mismatch for ${key}: expected ${expected[key]}, got ${actual[key]}.`);
  const result = { ok: true, backup: basename(backup), restoredAt: new Date().toISOString(), ...actual };
  process.stdout.write(`${hasArgument("--json") ? JSON.stringify(result) : `Restore drill passed: ${result.backup} · schema v${result.schemaVersion} · documents ${result.documents} · jobs ${result.jobs} · frontier ${result.frontier} · blocks ${result.domainBlocks}`}\n`);
} finally {
  if (child && child.exitCode === null) child.kill();
  if (childExit) await childExit;
  await rm(workdir, { recursive: true, force: true });
}
