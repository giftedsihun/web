import assert from "node:assert/strict";
import test from "node:test";
import { canonicalize, extractDocument, isPublicIpAddress, isPublicWebUrl, koreanNgrams, sitemapEntries, sitemapUrls } from "../../dist/public-search/extract.js";
import { normalizeMaxConcurrentCrawls, SchedulerConfigError } from "../../dist/public-search/scheduler.js";
import { combineCrawlSignals, crawlFailureMessage, isAllowedCrawlUrl, MAX_HOST_THROTTLES, MAX_RETRY_AFTER_MS, MAX_ROBOTS_CACHE_ENTRIES, normalizeApprovedHost, pruneHostThrottles, pruneRobotsCache, retryAfterMs, scopedCanonicalUrl, waitForCrawl } from "../../dist/public-search/crawler.js";
import { loadOperationsConfig, requireAdminToken } from "../../dist/public-search/config.js";
import { MAX_WEBHOOK_PAYLOAD_BYTES, OperationsReporter, operationPayload } from "../../dist/public-search/operations.js";
import { isAuthorized } from "../../dist/public-search/auth.js";
import { MAX_REQUEST_BODY_BYTES, readJsonBody, RequestBodyTooLargeError, requireJsonContentType, UnsupportedMediaTypeError } from "../../dist/public-search/request.js";
import { MAX_DOCUMENT_BYTES, readResponseText, ResponseBodyTooLargeError } from "../../dist/public-search/response.js";
import { FixedWindowRateLimiter } from "../../dist/public-search/rate-limit.js";
import { applyHttpLimits, HTTP_HEADERS_TIMEOUT_MS, HTTP_KEEP_ALIVE_TIMEOUT_MS, HTTP_MAX_HEADERS, HTTP_REQUEST_TIMEOUT_MS } from "../../dist/public-search/http-limits.js";
import { MAX_SEARCH_QUERY_DEPTH, MAX_SEARCH_QUERY_LENGTH, MAX_SEARCH_QUERY_TERMS, normalizeSearchQuery, SearchQueryError } from "../../dist/public-search/search-query.js";
import { CrawlInputError, MAX_CRAWL_PAGES, MAX_RECRAWL_MINUTES, normalizeCrawlLimits } from "../../dist/public-search/crawl-input.js";
import { allowsContentType, allowsCrawlUrl, CrawlPolicyError, normalizeCrawlPolicy } from "../../dist/public-search/crawl-policy.js";
import { CrawlStatusFilterError, normalizeCrawlStatus, normalizeFrontierState } from "../../dist/public-search/crawl-status.js";
import { API_SECURITY_HEADERS, apiResponseHeaders } from "../../dist/public-search/response-headers.js";
import { publicApiError } from "../../dist/public-search/api-error.js";
import { allowedCorsOrigins, corsResponseHeaders } from "../../dist/public-search/cors.js";
import { ensureSearchDateRange, normalizeSearchDate, normalizeSearchDomain, normalizeSearchSort, SearchOptionsError } from "../../dist/public-search/search-options.js";
import { MaintenanceInputError, normalizeRetentionInput } from "../../dist/public-search/maintenance.js";
import { robotsPolicy, robotsSitemaps } from "../../dist/public-search/robots.js";
import { SearchStore } from "../../dist/public-search/store.js";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";

test("canonical URLs discard fragments and credentials", () => {
  assert.equal(canonicalize("https://user:pass@example.test/path#part"), "https://example.test/path");
  assert.equal(canonicalize("https://example.test/guide?utm_source=newsletter&ref=home&fbclid=abc"), "https://example.test/guide?ref=home");
});

test("public Korean n-grams preserve syllable pairs for fallback search", () => {
  assert.equal(koreanNgrams("한국어 검색"), "한국 국어 검색");
});

test("Korean fallback index can be rebuilt from the primary search index", () => {
  const path = join(tmpdir(), `atlas-public-search-${randomUUID()}.sqlite`);
  let store;
  try {
    store = new SearchStore(path);
    store.index("https://example.test/korean", "https://example.test/korean", "한국어", "검색 품질", "hash");
    assert.deepEqual(store.rebuildNgrams(), { documents: 1 });
    assert.equal(store.searchCount("한국어"), 1);
  } finally { store?.close(); rmSync(path, { force: true }); }
});

test("crawler scheduler has a bounded concurrency setting", () => {
  assert.equal(normalizeMaxConcurrentCrawls(undefined), 2);
  assert.equal(normalizeMaxConcurrentCrawls("3"), 3);
  assert.throws(() => normalizeMaxConcurrentCrawls(0), SchedulerConfigError);
});

test("public crawler administration requires an explicit token", () => {
  assert.equal(requireAdminToken({ PUBLIC_SEARCH_ADMIN_TOKEN: "  secret-token  " }), "secret-token");
  assert.throws(() => requireAdminToken({}));
  assert.throws(() => requireAdminToken({ PUBLIC_SEARCH_ADMIN_TOKEN: " " }));
});

test("optional webhook alerts require validated HTTPS configuration and no default secret", () => {
  assert.deepEqual(loadOperationsConfig({}), {});
  const config = loadOperationsConfig({ PUBLIC_SEARCH_WEBHOOK_URL: "https://alerts.example.test/atlas", PUBLIC_SEARCH_WEBHOOK_SECRET: "a-secure-webhook-secret" });
  assert.equal(config.webhook?.url, "https://alerts.example.test/atlas");
  assert.deepEqual([...config.webhook.events], ["crawl.completed", "crawl.failed", "crawl.cancelled"]);
  for (const environment of [
    { PUBLIC_SEARCH_WEBHOOK_URL: "https://alerts.example.test" },
    { PUBLIC_SEARCH_WEBHOOK_URL: "http://alerts.example.test", PUBLIC_SEARCH_WEBHOOK_SECRET: "a-secure-webhook-secret" },
    { PUBLIC_SEARCH_WEBHOOK_URL: "https://alerts.example.test", PUBLIC_SEARCH_WEBHOOK_SECRET: "short" },
    { PUBLIC_SEARCH_WEBHOOK_URL: "https://alerts.example.test", PUBLIC_SEARCH_WEBHOOK_SECRET: "a-secure-webhook-secret", PUBLIC_SEARCH_WEBHOOK_EVENTS: "crawl.unknown" },
  ]) assert.throws(() => loadOperationsConfig(environment));
});

test("operation logs and signed webhook payloads are structured, bounded, and asynchronous", async () => {
  const job = { id: "job-1", seedUrl: "https://user:password@example.test/private", maxPages: 10, allowedHosts: ["example.test"], status: "complete", indexed: 2, skipped: 1, failed: 0, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", error: "x".repeat(600) };
  const payload = operationPayload("crawl.completed", job, "2026-01-01T00:00:00.000Z");
  const parsed = JSON.parse(payload);
  assert.equal(parsed.job.seedHost, "example.test");
  assert.equal(parsed.job.seedUrl, undefined);
  assert.equal(parsed.job.error.length, 500);
  assert.ok(Buffer.byteLength(payload) <= MAX_WEBHOOK_PAYLOAD_BYTES);
  const logs = [];
  const calls = [];
  const reporter = new OperationsReporter(loadOperationsConfig({ PUBLIC_SEARCH_WEBHOOK_URL: "https://alerts.example.test/atlas", PUBLIC_SEARCH_WEBHOOK_SECRET: "a-secure-webhook-secret", PUBLIC_SEARCH_WEBHOOK_EVENTS: "crawl.completed" }), (entry) => logs.push(entry), async (url, init) => { calls.push({ url, init }); return new Response("", { status: 204 }); });
  reporter.emit("crawl.completed", job);
  assert.equal(calls.length, 0);
  await reporter.flush();
  assert.equal(logs[0].event, "crawl.completed");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers["x-atlas-event"], "crawl.completed");
  assert.match(calls[0].init.headers["x-atlas-signature"], /^sha256=[a-f0-9]{64}$/);
});

test("crawler admin authorization only accepts an exact bearer token", () => {
  assert.equal(isAuthorized("Bearer secret-token", "secret-token"), true);
  for (const value of [undefined, "secret-token", "Bearer secret-token ", "Bearer wrong-token", "Basic secret-token"]) {
    assert.equal(isAuthorized(value, "secret-token"), false);
  }
});

test("API rate limits are per client, expire, and bound retained clients", () => {
  const limiter = new FixedWindowRateLimiter(2, 1_000, 2);
  assert.equal(limiter.check("client-a", 0).allowed, true);
  assert.equal(limiter.check("client-a", 10).allowed, true);
  const blocked = limiter.check("client-a", 20);
  assert.equal(blocked.allowed, false);
  if (!blocked.allowed) assert.equal(blocked.retryAfterSeconds, 1);
  assert.equal(limiter.check("client-b", 20).allowed, true);
  assert.equal(limiter.check("client-a", 1_000).allowed, true);
  assert.equal(limiter.check("client-c", 1_000).allowed, true);
});

test("public HTTP server has bounded headers, requests, and keep-alive connections", () => {
  const server = { headersTimeout: 0, requestTimeout: 0, keepAliveTimeout: 0, maxHeadersCount: null };
  assert.equal(applyHttpLimits(server), server);
  assert.deepEqual(server, {
    headersTimeout: HTTP_HEADERS_TIMEOUT_MS,
    requestTimeout: HTTP_REQUEST_TIMEOUT_MS,
    keepAliveTimeout: HTTP_KEEP_ALIVE_TIMEOUT_MS,
    maxHeadersCount: HTTP_MAX_HEADERS,
  });
});

test("public API responses include strict security headers", () => {
  assert.deepEqual(apiResponseHeaders({ "retry-after": "30" }), { ...API_SECURITY_HEADERS, "retry-after": "30" });
  assert.equal(API_SECURITY_HEADERS["x-content-type-options"], "nosniff");
  assert.equal(API_SECURITY_HEADERS["x-frame-options"], "DENY");
});

test("public API errors expose only expected validation messages", () => {
  assert.deepEqual(publicApiError(new SearchQueryError("q is required")), { status: 400, message: "q is required" });
  assert.deepEqual(publicApiError(new SyntaxError("Unexpected token < in JSON")), { status: 400, message: "Request body must contain valid JSON." });
  assert.deepEqual(publicApiError(new Error("connect ECONNREFUSED 10.0.0.1:5432")), { status: 400, message: "Invalid request." });
  assert.deepEqual(publicApiError("unexpected"), { status: 400, message: "Invalid request." });
  assert.deepEqual(publicApiError(new MaintenanceInputError("before must be a valid ISO date.")), { status: 400, message: "before must be a valid ISO date." });
});

test("retention settings require an explicit valid date and booleans", () => {
  assert.deepEqual(normalizeRetentionInput({ before: "2025-01-01", deleteDocuments: true, dryRun: false }), { before: "2025-01-01T00:00:00.000Z", deleteDocuments: true, dryRun: false });
  for (const value of [{}, { before: "nope" }, { before: "2025-01-01", dryRun: "false" }]) assert.throws(() => normalizeRetentionInput(value), MaintenanceInputError);
});

test("CORS only reflects explicitly configured HTTP(S) origins", () => {
  const origins = allowedCorsOrigins({ PUBLIC_SEARCH_CORS_ORIGINS: " https://app.example.test, http://localhost:3000 " });
  assert.deepEqual(corsResponseHeaders("https://app.example.test", origins), {
    "access-control-allow-origin": "https://app.example.test",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    vary: "Origin",
  });
  assert.deepEqual(corsResponseHeaders("https://untrusted.test", origins), {});
  assert.throws(() => allowedCorsOrigins({ PUBLIC_SEARCH_CORS_ORIGINS: "https://app.example.test/path" }));
});

test("search queries retain documented Boolean syntax while bounding FTS complexity", () => {
  assert.equal(normalizeSearchQuery('atlas AND (browser OR "local search")'), 'atlas AND (browser OR "local search")');
  for (const value of ["", "atlas*", "title:atlas", '"atlas', "(".repeat(MAX_SEARCH_QUERY_DEPTH + 1) + "atlas" + ")".repeat(MAX_SEARCH_QUERY_DEPTH + 1), "word ".repeat(MAX_SEARCH_QUERY_TERMS + 1), "a".repeat(MAX_SEARCH_QUERY_LENGTH + 1)]) {
    assert.throws(() => normalizeSearchQuery(value), SearchQueryError);
  }
});

test("public search dates are valid, ordered, and filter indexed documents inclusively", () => {
  assert.equal(normalizeSearchDate("2026-02-28", "from"), "2026-02-28");
  assert.throws(() => normalizeSearchDate("2026-02-30", "to"), SearchOptionsError);
  assert.throws(() => ensureSearchDateRange("2026-03-02", "2026-03-01"), SearchOptionsError);
  const path = join(tmpdir(), `atlas-public-search-dates-${randomUUID()}.sqlite`); let store;
  try { store = new SearchStore(path); store.index("https://example.test/a", undefined, "Atlas guide", "search", "one"); const today = new Date().toISOString().slice(0, 10); assert.equal(store.searchCount("Atlas", undefined, today, today), 1); assert.equal(store.suggestions("At")[0].value, "Atlas guide"); } finally { store?.close(); rmSync(path, { force: true }); }
});

test("crawl limits reject non-numeric values and remain within service budgets", () => {
  assert.deepEqual(normalizeCrawlLimits(10, 30), { maxPages: 10, recrawlMinutes: 30 });
  assert.deepEqual(normalizeCrawlLimits(99_999, 99_999), { maxPages: MAX_CRAWL_PAGES, recrawlMinutes: MAX_RECRAWL_MINUTES });
  assert.deepEqual(normalizeCrawlLimits(1, 0), { maxPages: 1, recrawlMinutes: undefined });
  for (const [pages, minutes] of [["10", undefined], [NaN, undefined], [1.5, undefined], [1, "15"], [1, -1]]) {
    assert.throws(() => normalizeCrawlLimits(pages, minutes), CrawlInputError);
  }
});

test("crawl policies bound depth and filter URLs before they enter the frontier", () => {
  const policy = normalizeCrawlPolicy({ maxDepth: 2, includePatterns: ["https://example.test/docs/*"], excludePatterns: ["*private*"] });
  assert.equal(allowsCrawlUrl("https://example.test/docs/guide", 2, policy), true);
  assert.equal(allowsCrawlUrl("https://example.test/docs/private", 1, policy), false);
  assert.equal(allowsCrawlUrl("https://example.test/blog", 1, policy), false);
  assert.equal(allowsCrawlUrl("https://example.test/docs/next", 3, policy), false);
  assert.equal(allowsContentType("text/html; charset=utf-8", policy), true);
  assert.equal(allowsContentType("application/pdf", policy), false);
  assert.throws(() => normalizeCrawlPolicy({ maxDepth: -1 }), CrawlPolicyError);
  assert.throws(() => normalizeCrawlPolicy({ includePatterns: [" "] }), CrawlPolicyError);
});

test("public search options only allow safe domain filters and documented sorts", () => {
  assert.equal(normalizeSearchSort("newest"), "newest");
  assert.equal(normalizeSearchDomain("Docs.Example.Test"), "docs.example.test");
  assert.throws(() => normalizeSearchSort("random"), SearchOptionsError);
  assert.throws(() => normalizeSearchDomain("example.test/path"), SearchOptionsError);
});

test("crawl status filters accept known lifecycle states only", () => {
  assert.equal(normalizeCrawlStatus("running"), "running");
  assert.equal(normalizeCrawlStatus(null), undefined);
  assert.equal(normalizeCrawlStatus(""), undefined);
  assert.equal(normalizeCrawlStatus("paused"), "paused");
  assert.throws(() => normalizeCrawlStatus("stopped"), CrawlStatusFilterError);
  assert.equal(normalizeFrontierState("processing"), "processing");
  assert.equal(normalizeFrontierState("failed"), "failed");
  assert.throws(() => normalizeFrontierState("paused"), CrawlStatusFilterError);
});

test("crawl requests have a bounded JSON body", async () => {
  async function* chunks(values) { yield* values; }
  assert.deepEqual(await readJsonBody(chunks(['{"seedUrl":"https://example.test"}'])), { seedUrl: "https://example.test" });
  await assert.rejects(readJsonBody(chunks(["x".repeat(MAX_REQUEST_BODY_BYTES + 1)])), RequestBodyTooLargeError);
  await assert.rejects(readJsonBody(chunks([]), String(MAX_REQUEST_BODY_BYTES + 1)), RequestBodyTooLargeError);
});

test("crawl submissions require a JSON media type", () => {
  for (const value of ["application/json", "application/json; charset=utf-8", "application/problem+json"]) requireJsonContentType(value);
  for (const value of [undefined, "text/plain", "application/x-www-form-urlencoded"]) {
    assert.throws(() => requireJsonContentType(value), UnsupportedMediaTypeError);
  }
});

test("crawler response reads reject oversized declared and streamed bodies", async () => {
  assert.equal(await readResponseText(new Response("atlas"), MAX_DOCUMENT_BYTES), "atlas");
  await assert.rejects(readResponseText(new Response("", { headers: { "content-length": String(MAX_DOCUMENT_BYTES + 1) } }), MAX_DOCUMENT_BYTES), ResponseBodyTooLargeError);
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(MAX_DOCUMENT_BYTES + 1)); controller.close(); } });
  await assert.rejects(readResponseText(new Response(stream), MAX_DOCUMENT_BYTES), ResponseBodyTooLargeError);
});

test("extractor resolves, filters, and de-duplicates web links", () => {
  const document = extractDocument('<title>Atlas &amp; Search</title><main>Hello <b>world</b></main><a href="/one#x">One</a><a href="https://example.test/one">Duplicate</a><a href="mailto:team@example.test">Mail</a>', "https://example.test/start");
  assert.equal(document.title, "Atlas & Search");
  assert.equal(document.text, "Atlas & Search Hello world One Duplicate Mail");
  assert.deepEqual(document.links, ["https://example.test/one"]);
});

test("sitemap discovery keeps valid public URLs and excludes private targets", () => {
  const urls = sitemapUrls("<urlset><url><loc>/guide</loc></url><url><loc>http://127.0.0.1/private</loc></url><url><loc>https://example.test/guide</loc></url></urlset>", "https://example.test");
  assert.deepEqual(urls, ["https://example.test/guide"]);
  assert.equal(isPublicWebUrl("https://example.test"), true);
  assert.equal(isPublicWebUrl("http://10.1.2.3"), false);
  assert.equal(isPublicIpAddress("192.168.1.9"), false);
  assert.equal(isPublicIpAddress("100.64.0.1"), false);
  assert.equal(isPublicIpAddress("::ffff:10.0.0.1"), false);
  assert.equal(isPublicWebUrl("http://[::1]"), false);
});

test("sitemap indexes and robots Sitemap directives support bounded discovery", () => {
  assert.deepEqual(robotsSitemaps("User-agent: *\nSitemap: https://example.test/main.xml\nsitemap: /news.xml\n# Sitemap: https://ignored.test/x.xml"), ["https://example.test/main.xml", "/news.xml"]);
  assert.deepEqual(sitemapEntries("<sitemapindex><sitemap><loc>/nested.xml</loc></sitemap></sitemapindex>", "https://example.test/main.xml"), { urls: [], sitemaps: ["https://example.test/nested.xml"] });
});

test("Retry-After accepts delay seconds or HTTP dates and remains bounded", () => {
  assert.equal(retryAfterMs("2", 1_000), 2_000);
  assert.equal(retryAfterMs("Thu, 01 Jan 1970 00:00:03 GMT", 1_000), 2_000);
  assert.equal(retryAfterMs("invalid", 1_000), undefined);
  assert.equal(retryAfterMs("999999", 0), MAX_RETRY_AFTER_MS);
});

test("approved hosts are normalized and reject URL or private-network input", () => {
  assert.equal(normalizeApprovedHost("Docs.Example.Test:8443"), "docs.example.test:8443");
  for (const value of ["https://example.test", "example.test/path", "127.0.0.1", "10.0.0.1", "localhost"]) {
    assert.throws(() => normalizeApprovedHost(value));
  }
});

test("crawler diagnostics are normalized and bounded", () => {
  assert.equal(crawlFailureMessage(new Error(" request\nfailed ")), "request failed");
  assert.equal(crawlFailureMessage("unexpected"), "Crawler request failed");
  assert.equal(crawlFailureMessage(new Error("x".repeat(600))).length, 500);
});

test("crawler cancellation signal aborts requests before their timeout", () => {
  const timeout = new AbortController();
  const cancellation = new AbortController();
  const signal = combineCrawlSignals(timeout.signal, cancellation.signal);
  assert.equal(signal.aborted, false);
  cancellation.abort();
  assert.equal(signal.aborted, true);
});

test("crawler cancellation interrupts queued retry and throttle waits", async () => {
  const cancellation = new AbortController();
  const waiting = waitForCrawl(60_000, cancellation.signal);
  cancellation.abort();
  await assert.rejects(waiting, (error) => error?.name === "AbortError");
  await assert.rejects(waitForCrawl(1, cancellation.signal), (error) => error?.name === "AbortError");
});

test("host throttle state removes expired entries and remains bounded", () => {
  const throttles = new Map([["expired.test", 99], ["soon.test", 101], ["later.test", 102]]);
  pruneHostThrottles(throttles, 100, 2);
  assert.deepEqual([...throttles.keys()], ["soon.test", "later.test"]);
  const bounded = new Map(Array.from({ length: MAX_HOST_THROTTLES + 1 }, (_, index) => [`host-${index}.test`, 1_000 + index]));
  pruneHostThrottles(bounded, 0);
  assert.equal(bounded.size, MAX_HOST_THROTTLES);
  assert.equal(bounded.has("host-0.test"), false);
});

test("robots policies expire and their cache remains bounded", () => {
  const cache = new Map([["https://expired.test", { text: "", expiresAt: 99 }], ["https://soon.test", { text: "User-agent: *", expiresAt: 101 }], ["https://later.test", { text: "", expiresAt: 102 }]]);
  pruneRobotsCache(cache, 100, 2);
  assert.deepEqual([...cache.keys()], ["https://soon.test", "https://later.test"]);
  const bounded = new Map(Array.from({ length: MAX_ROBOTS_CACHE_ENTRIES + 1 }, (_, index) => [`https://host-${index}.test`, { text: "", expiresAt: 1_000 + index }]));
  pruneRobotsCache(bounded, 0);
  assert.equal(bounded.size, MAX_ROBOTS_CACHE_ENTRIES);
  assert.equal(bounded.has("https://host-0.test"), false);
});

test("canonical URLs stay within the crawl's public approved hosts", () => {
  const fetched = new URL("https://example.test/article?source=crawl");
  const hosts = new Set(["example.test"]);
  assert.equal(scopedCanonicalUrl("https://example.test/article", fetched, hosts), "https://example.test/article");
  assert.equal(scopedCanonicalUrl("https://tracker.test/article", fetched, hosts), "https://example.test/article?source=crawl");
  assert.equal(scopedCanonicalUrl("http://127.0.0.1/admin", fetched, hosts), "https://example.test/article?source=crawl");
  assert.equal(scopedCanonicalUrl("not a url", fetched, hosts), "https://example.test/article?source=crawl");
});

test("crawler requests stay within public approved hosts before redirects are followed", () => {
  const hosts = new Set(["example.test"]);
  assert.equal(isAllowedCrawlUrl(new URL("https://example.test/redirect"), hosts), true);
  assert.equal(isAllowedCrawlUrl(new URL("https://tracker.test/landing"), hosts), false);
  assert.equal(isAllowedCrawlUrl(new URL("http://127.0.0.1/admin"), hosts), false);
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
    store.updateJob("job-1", { failed: 1, error: `request\n${"x".repeat(600)}` });
    const updated = store.getJob("job-1");
    assert.equal(updated?.failed, 1);
    assert.equal(updated?.error?.length, 500);
    assert.equal(updated?.error?.includes("\n"), false);
  } finally { store?.close(); rmSync(path, { force: true }); }
});

test("canonical document keys replace tracking URL variants", () => {
  const path = join(tmpdir(), `atlas-public-search-${randomUUID()}.sqlite`);
  let store;
  try {
    store = new SearchStore(path);
    const url = canonicalize("https://example.test/guide?utm_campaign=launch");
    store.index(url, url, "Guide", "atlas crawler guide", "first");
    store.index(canonicalize("https://example.test/guide?fbclid=click"), url, "Guide", "updated atlas crawler guide", "second");
    assert.equal(store.documentCount(), 1);
    assert.equal(store.searchCount("updated"), 1);
    assert.equal(store.searchCount("first"), 0);
  } finally { store?.close(); rmSync(path, { force: true }); }
});

test("document inspection, deletion, and requeue stay bound to an existing approved frontier", () => {
  const path = join(tmpdir(), `atlas-public-search-${randomUUID()}.sqlite`);
  let store;
  try {
    store = new SearchStore(path);
    const now = new Date().toISOString();
    const url = "https://example.test/guide";
    store.createJob({ id: "quality-job", seedUrl: url, maxPages: 2, allowedHosts: ["example.test"], status: "complete", indexed: 1, skipped: 0, failed: 0, createdAt: now, updatedAt: now });
    store.markProcessing("quality-job", url);
    store.markFetched("quality-job", url);
    store.index(url, url, "Guide", "atlas quality guide", "quality-hash", { etag: "etag-1" });
    assert.deepEqual(store.inspectDocument(url)?.quality, { titleLength: 5, textLength: 19, wordCount: 3, textHash: "quality-hash", hasValidators: true });
    assert.deepEqual(store.requeueDocument(url), { jobId: "quality-job", status: "queued" });
    assert.equal(store.nextUrl("quality-job")?.url, url);
    assert.equal(store.getJob("quality-job")?.indexed, 0);
    assert.equal(store.deleteDocument(url), true);
    assert.equal(store.inspectDocument(url), undefined);
    assert.equal(store.requeueDocument(url), undefined);
  } finally { store?.close(); rmSync(path, { force: true }); }
});

test("search filters by host and retention previews before deleting terminal data", () => {
  const path = join(tmpdir(), `atlas-public-search-${randomUUID()}.sqlite`);
  let store;
  try {
    store = new SearchStore(path);
    store.index("https://docs.example.test/guide", "https://docs.example.test/guide", "Guide", "atlas guide", "one");
    store.index("https://blog.example.test/guide", "https://blog.example.test/guide", "Guide", "atlas guide", "two");
    assert.equal(store.searchCount("atlas", "docs.example.test"), 1);
    assert.equal(store.search("atlas", 0, 20, "newest", "docs.example.test")[0].url, "https://docs.example.test/guide");
    assert.deepEqual(store.searchFacets("atlas").domains.map(({ domain, count }) => ({ domain, count })), [{ domain: "blog.example.test", count: 1 }, { domain: "docs.example.test", count: 1 }]);
    const old = "2000-01-01T00:00:00.000Z";
    store.createJob({ id: "old-job", seedUrl: "https://old.example.test", maxPages: 1, allowedHosts: ["old.example.test"], status: "complete", indexed: 0, skipped: 0, failed: 0, createdAt: old, updatedAt: old });
    assert.deepEqual(store.retention("2001-01-01T00:00:00.000Z", false, true), { cutoff: "2001-01-01T00:00:00.000Z", dryRun: true, jobs: 1, frontier: 1, documents: 0 });
    store.retention("2001-01-01T00:00:00.000Z", false, false);
    assert.equal(store.getJob("old-job"), undefined);
  } finally { store?.close(); rmSync(path, { force: true }); }
});

test("frontier policy exclusions are counted by reason without entering the queue", () => {
  const path = join(tmpdir(), `atlas-public-search-${randomUUID()}.sqlite`);
  let store;
  try {
    store = new SearchStore(path);
    const now = new Date().toISOString();
    store.createJob({ id: "policy-job", seedUrl: "https://example.test", maxPages: 5, allowedHosts: ["example.test"], policy: normalizeCrawlPolicy({ maxDepth: 1, excludePatterns: ["*private*"] }), status: "queued", indexed: 0, skipped: 0, failed: 0, createdAt: now, updatedAt: now });
    assert.equal(store.enqueue("policy-job", "https://example.test/private", 1), false);
    assert.equal(store.enqueue("policy-job", "https://example.test/deep", 2), false);
    assert.deepEqual(store.getJob("policy-job")?.skipReasons, { exclude_pattern: 1, depth: 1 });
    assert.equal(store.getJob("policy-job")?.skipped, 0);
  } finally { store?.close(); rmSync(path, { force: true }); }
});

test("crawl frontiers are capped at each job's page budget", () => {
  const path = join(tmpdir(), `atlas-public-search-${randomUUID()}.sqlite`);
  let store;
  try {
    store = new SearchStore(path);
    const now = new Date().toISOString();
    store.createJob({ id: "limited-job", seedUrl: "https://example.test", maxPages: 2, allowedHosts: ["example.test"], status: "queued", indexed: 0, skipped: 0, failed: 0, createdAt: now, updatedAt: now });
    store.enqueue("limited-job", "https://example.test/first");
    store.enqueue("limited-job", "https://example.test/second");
    assert.equal(store.frontierCount("limited-job"), 2);
    assert.equal(store.nextUrl("limited-job")?.url, "https://example.test");
  } finally { store?.close(); rmSync(path, { force: true }); }
});

test("crawl and frontier listings use stable tie-breakers for pagination", () => {
  const path = join(tmpdir(), `atlas-public-search-${randomUUID()}.sqlite`);
  let store;
  try {
    store = new SearchStore(path);
    const now = new Date().toISOString();
    for (const id of ["job-a", "job-b"]) store.createJob({ id, seedUrl: `https://${id}.test`, maxPages: 3, allowedHosts: [`${id}.test`], status: "queued", indexed: 0, skipped: 0, failed: 0, createdAt: now, updatedAt: now });
    assert.deepEqual(store.listJobs().map((job) => job.id), ["job-b", "job-a"]);
    const toISOString = Date.prototype.toISOString;
    Date.prototype.toISOString = () => now;
    try {
      store.enqueue("job-a", "https://job-a.test/z");
      store.enqueue("job-a", "https://job-a.test/a");
    } finally { Date.prototype.toISOString = toISOString; }
    assert.deepEqual(store.listFrontier("job-a").map((entry) => entry.url), ["https://job-a.test/a", "https://job-a.test/z", "https://job-a.test"]);
    assert.equal(store.nextUrl("job-a")?.url, "https://job-a.test/a");
  } finally { store?.close(); rmSync(path, { force: true }); }
});

test("frontier progress summary reports queued, in-flight, and completed URLs", () => {
  const path = join(tmpdir(), `atlas-public-search-${randomUUID()}.sqlite`);
  let store;
  try {
    store = new SearchStore(path);
    const now = new Date().toISOString();
    store.createJob({ id: "progress-job", seedUrl: "https://example.test", maxPages: 3, allowedHosts: ["example.test"], status: "queued", indexed: 0, skipped: 0, failed: 0, createdAt: now, updatedAt: now });
    store.enqueue("progress-job", "https://example.test/in-flight");
    store.enqueue("progress-job", "https://example.test/complete");
    store.markProcessing("progress-job", "https://example.test/in-flight");
    store.markProcessing("progress-job", "https://example.test/complete");
    store.markFetched("progress-job", "https://example.test/complete");
    store.markProcessing("progress-job", "https://example.test/in-flight");
    assert.deepEqual(store.frontierStatusSummary("progress-job"), { total: 3, states: { queued: 1, processing: 1, fetched: 1, failed: 0 }, attempted: 2, attempts: 3, retries: 1 });
  } finally { store?.close(); rmSync(path, { force: true }); }
});

test("frontier URLs remain isolated between crawl jobs", () => {
  const path = join(tmpdir(), `atlas-public-search-${randomUUID()}.sqlite`);
  let store;
  try {
    store = new SearchStore(path);
    const now = new Date().toISOString();
    for (const id of ["job-a", "job-b"]) store.createJob({ id, seedUrl: "https://example.test", maxPages: 2, allowedHosts: ["example.test"], status: "queued", indexed: 0, skipped: 0, failed: 0, createdAt: now, updatedAt: now });
    assert.equal(store.nextUrl("job-a")?.url, "https://example.test");
    assert.equal(store.nextUrl("job-b")?.url, "https://example.test");
    store.markFetched("job-a", "https://example.test");
    assert.equal(store.nextUrl("job-b")?.url, "https://example.test");
  } finally { store?.close(); rmSync(path, { force: true }); }
});

test("terminal jobs can retry failed frontier URLs without resetting completed work", () => {
  const path = join(tmpdir(), `atlas-public-search-${randomUUID()}.sqlite`);
  let store;
  try {
    store = new SearchStore(path);
    const now = new Date().toISOString();
    store.createJob({ id: "retry-job", seedUrl: "https://example.test", maxPages: 3, allowedHosts: ["example.test"], status: "complete", indexed: 1, skipped: 0, failed: 1, createdAt: now, updatedAt: now, error: "temporary failure" });
    store.enqueue("retry-job", "https://example.test/failure");
    store.markProcessing("retry-job", "https://example.test/");
    store.markFetched("retry-job", "https://example.test/");
    store.markProcessing("retry-job", "https://example.test/failure");
    store.markFailed("retry-job", "https://example.test/failure", "temporary failure");
    store.updateJob("retry-job", { status: "complete", indexed: 1, failed: 1, error: "temporary failure" });
    assert.equal(store.retryFailedFrontier("retry-job"), 1);
    assert.equal(store.getJob("retry-job")?.status, "queued");
    assert.equal(store.getJob("retry-job")?.indexed, 1);
    assert.equal(store.getJob("retry-job")?.failed, 0);
    assert.equal(store.listFrontier("retry-job", 0, 20, "queued").find((entry) => entry.url.endsWith("/failure"))?.lastError, null);
    assert.equal(store.listFrontier("retry-job", 0, 20, "queued").some((entry) => entry.url === "https://example.test/failure"), true);
    assert.equal(store.retryFailedFrontier("retry-job"), 0);
  } finally { store?.close(); rmSync(path, { force: true }); }
});

test("frontier failures retain bounded per-entry diagnostics", () => {
  const path = join(tmpdir(), `atlas-public-search-${randomUUID()}.sqlite`);
  let store;
  try {
    store = new SearchStore(path);
    const now = new Date().toISOString();
    store.createJob({ id: "diagnostic-job", seedUrl: "https://example.test", maxPages: 2, allowedHosts: ["example.test"], status: "complete", indexed: 0, skipped: 0, failed: 1, createdAt: now, updatedAt: now });
    store.markProcessing("diagnostic-job", "https://example.test");
    store.markFailed("diagnostic-job", "https://example.test", ` request\n${"x".repeat(600)}`);
    const entry = store.listFrontier("diagnostic-job", 0, 20, "failed")[0];
    assert.equal(entry.lastError?.length, 500);
    assert.equal(entry.lastError?.includes("\n"), false);
  } finally { store?.close(); rmSync(path, { force: true }); }
});

test("interrupted running jobs requeue only in-flight frontier URLs", () => {
  const path = join(tmpdir(), `atlas-public-search-${randomUUID()}.sqlite`);
  let store;
  try {
    store = new SearchStore(path);
    const now = new Date().toISOString();
    store.createJob({ id: "interrupted-job", seedUrl: "https://example.test", maxPages: 3, allowedHosts: ["example.test"], status: "running", indexed: 1, skipped: 0, failed: 0, createdAt: now, updatedAt: now });
    store.enqueue("interrupted-job", "https://example.test/in-flight");
    store.enqueue("interrupted-job", "https://example.test/complete");
    store.markProcessing("interrupted-job", "https://example.test");
    store.markFetched("interrupted-job", "https://example.test");
    store.markProcessing("interrupted-job", "https://example.test/in-flight");
    store.markProcessing("interrupted-job", "https://example.test/complete");
    store.markFetched("interrupted-job", "https://example.test/complete");
    store.recoverInterruptedJobs();
    assert.equal(store.getJob("interrupted-job")?.status, "queued");
    assert.equal(store.nextUrl("interrupted-job")?.url, "https://example.test/in-flight");
    store.markFetched("interrupted-job", "https://example.test/in-flight");
    assert.equal(store.nextUrl("interrupted-job"), undefined);
  } finally { store?.close(); rmSync(path, { force: true }); }
});

test("terminal crawl jobs can be restarted with their frontier reset", () => {
  const path = join(tmpdir(), `atlas-public-search-${randomUUID()}.sqlite`);
  let store;
  try {
    store = new SearchStore(path);
    const now = new Date().toISOString();
    store.createJob({ id: "restartable-job", seedUrl: "https://example.test", maxPages: 2, allowedHosts: ["example.test"], status: "cancelled", indexed: 1, skipped: 0, failed: 0, createdAt: now, updatedAt: now, error: "cancelled" });
    store.markProcessing("restartable-job", "https://example.test");
    store.markFetched("restartable-job", "https://example.test");
    assert.equal(store.restartJob("restartable-job"), true);
    const restarted = store.getJob("restartable-job");
    assert.equal(restarted?.status, "queued");
    assert.equal(restarted?.indexed, 0);
    assert.equal(restarted?.error, null);
    assert.equal(store.nextUrl("restartable-job")?.url, "https://example.test");
  } finally { store?.close(); rmSync(path, { force: true }); }
});
