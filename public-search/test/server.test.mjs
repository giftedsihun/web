import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

async function waitForServer(baseUrl, child) {
  let output = "";
  child.stderr?.on("data", (chunk) => { output += chunk; });
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch { /* The child process is still starting. */ }
    if (child.exitCode !== null) throw new Error(`Public API exited during startup: ${output}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Public API did not start: ${output}`);
}

test("public API routes enforce HTTP authentication, validation, and CORS", async () => {
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const database = join(tmpdir(), `atlas-public-api-${randomUUID()}.sqlite`);
  const backupDirectory = join(tmpdir(), `atlas-public-backups-${randomUUID()}`);
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["dist/public-search/server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PUBLIC_SEARCH_PORT: String(port),
      PUBLIC_SEARCH_DB: database,
      PUBLIC_SEARCH_BACKUP_DIR: backupDirectory,
      PUBLIC_SEARCH_ADMIN_TOKEN: "integration-token",
      PUBLIC_SEARCH_CORS_ORIGINS: "https://app.example.test",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });

  try {
    await waitForServer(baseUrl, child);
    const origin = { origin: "https://app.example.test" };

    const health = await fetch(`${baseUrl}/health`, { headers: origin });
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);
    assert.equal(health.headers.get("access-control-allow-origin"), "https://app.example.test");
    assert.equal(health.headers.get("x-content-type-options"), "nosniff");
    const ready = await fetch(`${baseUrl}/ready`);
    assert.equal(ready.status, 200);
    assert.equal((await ready.json()).ready, true);

    const unauthenticated = await fetch(`${baseUrl}/v1/crawls`, { headers: origin });
    assert.equal(unauthenticated.status, 401);

    const badQuery = await fetch(`${baseUrl}/v1/search?q=atlas*`, { headers: origin });
    assert.equal(badQuery.status, 400);
    const filteredQuery = await fetch(`${baseUrl}/v1/search?q=atlas&sort=newest&domain=example.test`, { headers: origin });
    assert.equal(filteredQuery.status, 200);
    assert.equal((await filteredQuery.json()).sort, "newest");
    const metadataFilter = await fetch(`${baseUrl}/v1/search?q=atlas&language=ko&documentType=xhtml`, { headers: origin });
    assert.equal(metadataFilter.status, 200);
    const metadataBody = await metadataFilter.json();
    assert.equal(metadataBody.language, "ko");
    assert.equal(metadataBody.documentType, "xhtml");
    const invalidLanguage = await fetch(`${baseUrl}/v1/search?q=atlas&language=fr`, { headers: origin });
    assert.equal(invalidLanguage.status, 400);

    const wrongMediaType = await fetch(`${baseUrl}/v1/crawls`, {
      method: "POST",
      headers: { ...origin, authorization: "Bearer integration-token", "content-type": "text/plain" },
      body: "seedUrl=https://example.test",
    });
    assert.equal(wrongMediaType.status, 415);

    const created = await fetch(`${baseUrl}/v1/crawls`, {
      method: "POST",
      headers: { ...origin, authorization: "Bearer integration-token", "content-type": "application/json" },
      body: JSON.stringify({ seedUrl: "https://crawl-test.invalid", maxPages: 1, allowedHosts: ["docs.crawl-test.invalid"], crawlPolicy: { maxDepth: 1, requestIntervalMs: 5_000, excludePatterns: ["*/logout*"] } }),
    });
    assert.equal(created.status, 202);
    const job = await created.json();
    assert.equal(job.maxPages, 1);
    assert.deepEqual(job.allowedHosts, ["crawl-test.invalid", "docs.crawl-test.invalid"]);
    assert.equal(job.policy.maxDepth, 1);
    assert.equal(job.policy.requestIntervalMs, 5_000);

    const stats = await fetch(`${baseUrl}/v1/admin/stats`, { headers: { ...origin, authorization: "Bearer integration-token" } });
    assert.equal(stats.status, 200);
    assert.equal((await stats.json()).jobs, 1);
    const noMetricsToken = await fetch(`${baseUrl}/v1/admin/metrics`, { headers: origin });
    assert.equal(noMetricsToken.status, 401);
    const metrics = await fetch(`${baseUrl}/v1/admin/metrics`, { headers: { ...origin, authorization: "Bearer integration-token" } });
    assert.equal(metrics.status, 200);
    const metricsBody = await metrics.json();
    assert.equal(typeof metricsBody.generatedAt, "string");
    assert.equal(metricsBody.jobs.total, 1);
    assert.equal(metricsBody.frontier.total, 1);
    assert.equal(metricsBody.database.schemaVersion, 1);
    assert.deepEqual(metricsBody.documents.languages, []);
    const noBackupToken = await fetch(`${baseUrl}/v1/admin/backup`, { method: "POST", headers: origin });
    assert.equal(noBackupToken.status, 401);
    const backup = await fetch(`${baseUrl}/v1/admin/backup`, { method: "POST", headers: { ...origin, authorization: "Bearer integration-token" } });
    assert.equal(backup.status, 201);
    const backupBody = await backup.json();
    assert.match(backupBody.file, /^public-search-.*\.sqlite$/);
    assert.ok(backupBody.bytes > 0);
    const noBackupListToken = await fetch(`${baseUrl}/v1/admin/backups`, { headers: origin });
    assert.equal(noBackupListToken.status, 401);
    const backupList = await fetch(`${baseUrl}/v1/admin/backups`, { headers: { ...origin, authorization: "Bearer integration-token" } });
    assert.equal(backupList.status, 200);
    const backups = await backupList.json();
    assert.equal(backups.backups[0].file, backupBody.file);
    assert.ok(backups.backups[0].modifiedAt);
    const verified = await fetch(`${baseUrl}/v1/admin/backups/verify`, { method: "POST", headers: { ...origin, authorization: "Bearer integration-token", "content-type": "application/json" }, body: JSON.stringify({ file: backupBody.file }) });
    assert.equal(verified.status, 200);
    const verification = await verified.json();
    assert.equal(verification.file, backupBody.file);
    assert.equal(verification.bytes, backupBody.bytes);
    assert.equal(verification.modifiedAt, backups.backups[0].modifiedAt);
    assert.equal(verification.integrity, "ok");
    assert.equal(verification.schemaVersion, 1);
    assert.equal(verification.compatible, true);
    assert.deepEqual({ documents: verification.documents, jobs: verification.jobs, frontier: verification.frontier, domainBlocks: verification.domainBlocks }, { documents: 0, jobs: 1, frontier: 1, domainBlocks: 0 });
    assert.equal(typeof verification.verifiedAt, "string");
    const invalidBackup = await fetch(`${baseUrl}/v1/admin/backups/verify`, { method: "POST", headers: { ...origin, authorization: "Bearer integration-token", "content-type": "application/json" }, body: JSON.stringify({ file: "../public-search.sqlite" }) });
    assert.equal(invalidBackup.status, 400);
    const invalidRetention = await fetch(`${baseUrl}/v1/admin/retention`, { method: "POST", headers: { ...origin, authorization: "Bearer integration-token", "content-type": "application/json" }, body: JSON.stringify({ before: "not-a-date" }) });
    assert.equal(invalidRetention.status, 400);
    assert.equal((await invalidRetention.json()).error, "before must be a valid ISO date.");
    const retentionPreview = await fetch(`${baseUrl}/v1/admin/retention`, { method: "POST", headers: { ...origin, authorization: "Bearer integration-token", "content-type": "application/json" }, body: JSON.stringify({ before: "2999-01-01T00:00:00.000Z" }) });
    assert.equal(retentionPreview.status, 200);
    assert.equal((await retentionPreview.json()).dryRun, true);
    const optimized = await fetch(`${baseUrl}/v1/admin/search/optimize`, { method: "POST", headers: { ...origin, authorization: "Bearer integration-token" } });
    assert.equal(optimized.status, 200);

    const listing = await fetch(`${baseUrl}/v1/crawls?page=1`, { headers: { ...origin, authorization: "Bearer integration-token" } });
    assert.equal(listing.status, 200);
    const listed = await listing.json();
    assert.equal(listed.page, 1);
    assert.equal(listed.pageSize, 20);
    assert.equal(listed.total, 1);
    assert.equal(listed.totalPages, 1);
    assert.equal(listed.jobs[0].id, job.id);

    const initialSummary = await fetch(`${baseUrl}/v1/crawls/summary`, { headers: { ...origin, authorization: "Bearer integration-token" } });
    assert.equal(initialSummary.status, 200);
    assert.deepEqual(await initialSummary.json(), { total: 1, statuses: { queued: 0, running: 1, paused: 0, complete: 0, cancelled: 0, failed: 0 } });

    const progress = await fetch(`${baseUrl}/v1/crawls/${job.id}`, { headers: { ...origin, authorization: "Bearer integration-token" } });
    assert.equal(progress.status, 200);
    const progressBody = await progress.json();
    assert.equal(progressBody.job.id, job.id);
    assert.equal(typeof progressBody.frontier.total, "number");
    assert.deepEqual(Object.keys(progressBody.frontier.states).sort(), ["failed", "fetched", "processing", "queued"]);
    assert.deepEqual({ attempted: progressBody.frontier.attempted, attempts: progressBody.frontier.attempts, retries: progressBody.frontier.retries }, { attempted: 0, attempts: 0, retries: 0 });

    const paused = await fetch(`${baseUrl}/v1/crawls/${job.id}/pause`, { method: "POST", headers: { ...origin, authorization: "Bearer integration-token" } });
    assert.equal(paused.status, 202);
    assert.equal((await paused.json()).status, "paused");
    const resumed = await fetch(`${baseUrl}/v1/crawls/${job.id}/resume`, { method: "POST", headers: { ...origin, authorization: "Bearer integration-token" } });
    assert.equal(resumed.status, 202);
    const scheduled = await fetch(`${baseUrl}/v1/crawls/${job.id}/schedule`, { method: "POST", headers: { ...origin, authorization: "Bearer integration-token", "content-type": "application/json" }, body: JSON.stringify({ recrawlMinutes: 60 }) });
    assert.equal(scheduled.status, 200);
    assert.equal((await scheduled.json()).recrawlMinutes, 60);

    const frontier = await fetch(`${baseUrl}/v1/crawls/${job.id}/frontier?state=queued`, { headers: { ...origin, authorization: "Bearer integration-token" } });
    assert.equal(frontier.status, 200);
    const frontierBody = await frontier.json();
    assert.equal(frontierBody.state, "queued");
    assert.equal(frontierBody.total, 1);
    assert.equal(frontierBody.entries[0].url, "https://crawl-test.invalid/");

    const invalidFrontierState = await fetch(`${baseUrl}/v1/crawls/${job.id}/frontier?state=paused`, { headers: { ...origin, authorization: "Bearer integration-token" } });
    assert.equal(invalidFrontierState.status, 400);

    const cancelled = await fetch(`${baseUrl}/v1/crawls/${job.id}`, { method: "DELETE", headers: { ...origin, authorization: "Bearer integration-token" } });
    assert.equal(cancelled.status, 202);
    assert.equal((await cancelled.json()).status, "cancelled");

    const cancelledProgress = await fetch(`${baseUrl}/v1/crawls/${job.id}`, { headers: { ...origin, authorization: "Bearer integration-token" } });
    assert.equal((await cancelledProgress.json()).job.status, "cancelled");

    const cancelledListing = await fetch(`${baseUrl}/v1/crawls?status=cancelled`, { headers: { ...origin, authorization: "Bearer integration-token" } });
    assert.equal(cancelledListing.status, 200);
    const cancelledJobs = await cancelledListing.json();
    assert.equal(cancelledJobs.status, "cancelled");
    assert.equal(cancelledJobs.total, 1);
    assert.equal(cancelledJobs.jobs[0].id, job.id);

    const cancelledSummary = await fetch(`${baseUrl}/v1/crawls/summary`, { headers: { ...origin, authorization: "Bearer integration-token" } });
    assert.deepEqual(await cancelledSummary.json(), { total: 1, statuses: { queued: 0, running: 0, paused: 0, complete: 0, cancelled: 1, failed: 0 } });

    const restarted = await fetch(`${baseUrl}/v1/crawls/${job.id}/restart`, { method: "POST", headers: { ...origin, authorization: "Bearer integration-token" } });
    assert.equal(restarted.status, 202);
    assert.deepEqual(await restarted.json(), { id: job.id, status: "queued" });

    const restartWhileActive = await fetch(`${baseUrl}/v1/crawls/${job.id}/restart`, { method: "POST", headers: { ...origin, authorization: "Bearer integration-token" } });
    assert.equal(restartWhileActive.status, 409);

    const invalidStatus = await fetch(`${baseUrl}/v1/crawls?status=stopped`, { headers: { ...origin, authorization: "Bearer integration-token" } });
    assert.equal(invalidStatus.status, 400);

    const noBlockToken = await fetch(`${baseUrl}/v1/admin/domain-blocks`, { method: "POST", headers: { ...origin, "content-type": "application/json" }, body: JSON.stringify({ domain: "crawl-test.invalid" }) });
    assert.equal(noBlockToken.status, 401);
    const blocked = await fetch(`${baseUrl}/v1/admin/domain-blocks`, { method: "POST", headers: { ...origin, authorization: "Bearer integration-token", "content-type": "application/json" }, body: JSON.stringify({ domain: "crawl-test.invalid", reason: "Operator removal request" }) });
    assert.equal(blocked.status, 200);
    assert.deepEqual(await blocked.json(), { domain: "crawl-test.invalid", reason: "Operator removal request", documents: 0, frontier: 1 });
    const blocks = await fetch(`${baseUrl}/v1/admin/domain-blocks`, { headers: { ...origin, authorization: "Bearer integration-token" } });
    assert.equal(blocks.status, 200);
    assert.equal((await blocks.json()).blocks[0].domain, "crawl-test.invalid");
    const blockedSubmission = await fetch(`${baseUrl}/v1/crawls`, { method: "POST", headers: { ...origin, authorization: "Bearer integration-token", "content-type": "application/json" }, body: JSON.stringify({ seedUrl: "https://crawl-test.invalid", maxPages: 1 }) });
    assert.equal(blockedSubmission.status, 400);
    const unblocked = await fetch(`${baseUrl}/v1/admin/domain-blocks?domain=crawl-test.invalid`, { method: "DELETE", headers: { ...origin, authorization: "Bearer integration-token" } });
    assert.deepEqual(await unblocked.json(), { domain: "crawl-test.invalid", blocked: false });

    const preflight = await fetch(`${baseUrl}/v1/search`, { method: "OPTIONS", headers: { ...origin, "access-control-request-method": "GET" } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-methods"), "GET, POST, DELETE, OPTIONS");
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await once(child, "exit");
    }
    rmSync(database, { force: true });
    rmSync(`${database}-shm`, { force: true });
    rmSync(`${database}-wal`, { force: true });
    rmSync(backupDirectory, { recursive: true, force: true });
  }
});
