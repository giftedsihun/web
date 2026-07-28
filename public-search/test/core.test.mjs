import assert from "node:assert/strict";
import test from "node:test";
import { canonicalize, extractDocument } from "../../dist/public-search/extract.js";
import { robotsPolicy } from "../../dist/public-search/robots.js";
import { SearchStore } from "../../dist/public-search/store.js";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";

test("canonical URLs discard fragments and credentials", () => {
  assert.equal(canonicalize("https://user:pass@example.test/path#part"), "https://example.test/path");
});

test("extractor resolves, filters, and de-duplicates web links", () => {
  const document = extractDocument('<title>Atlas &amp; Search</title><main>Hello <b>world</b></main><a href="/one#x">One</a><a href="https://example.test/one">Duplicate</a><a href="mailto:team@example.test">Mail</a>', "https://example.test/start");
  assert.equal(document.title, "Atlas & Search");
  assert.equal(document.text, "Atlas & Search Hello world One Duplicate Mail");
  assert.deepEqual(document.links, ["https://example.test/one"]);
});

test("robots chooses the most specific matching allow rule", () => {
  const robots = "User-agent: AtlasPublicSearchBot\nDisallow: /private\nAllow: /private/public\nCrawl-delay: 2";
  assert.equal(robotsPolicy(robots, new URL("https://example.test/private/a"), "AtlasPublicSearchBot/0.1").allowed, false);
  const policy = robotsPolicy(robots, new URL("https://example.test/private/public/a"), "AtlasPublicSearchBot/0.1");
  assert.equal(policy.allowed, true);
  assert.equal(policy.crawlDelayMs, 2000);
});

test("jobs retain approved hosts and become due for a configured recrawl", () => {
  const path = join(tmpdir(), `atlas-public-search-${randomUUID()}.sqlite`);
  let store;
  try {
    store = new SearchStore(path);
    const now = new Date().toISOString();
    store.createJob({ id: "job-1", seedUrl: "https://example.test", maxPages: 10, allowedHosts: ["example.test", "docs.example.test"], recrawlMinutes: 15, nextRecrawlAt: 0, status: "complete", indexed: 0, skipped: 0, failed: 0, createdAt: now, updatedAt: now });
    assert.deepEqual(store.getJob("job-1")?.allowedHosts, ["example.test", "docs.example.test"]);
    assert.equal(store.dueRecrawls(Date.now()).length, 1);
    assert.equal(store.restartForRecrawl("job-1"), true);
    assert.equal(store.getJob("job-1")?.status, "queued");
  } finally { store?.close(); rmSync(path, { force: true }); }
});
