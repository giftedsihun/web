import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { clampCrawlLimit, crawlProgressValue, isPublicIpAddress, isSafeCrawlerUrl, koreanNgrams, matchesSearchFilters, normalizeSession, noteImportKey } from "../dist/core.js";
import { CrawlResponseTooLargeError, MAX_DOCUMENT_BYTES, readCrawlResponseText } from "../dist/crawl-response.js";

test("crawl limits are bounded", () => {
  assert.equal(clampCrawlLimit(), 10);
  assert.equal(clampCrawlLimit(0), 1);
  assert.equal(clampCrawlLimit(99), 50);
});

test("sessions keep only valid tabs and restore active URL", () => {
  const session = normalizeSession({ tabs: [{ title: "One", url: "https://one.test" }, { title: 1, url: "bad" }], activeUrl: "https://one.test", recentlyClosed: [{ title: "Two", url: "https://two.test" }] });
  assert.deepEqual(session.tabs, [{ title: "One", url: "https://one.test" }]);
  assert.equal(session.activeUrl, "https://one.test");
  assert.equal(session.recentlyClosed.length, 1);
});

test("FTS reindex replaces prior document text and supports Boolean search", () => {
  const database = new DatabaseSync(":memory:");
  database.exec("CREATE VIRTUAL TABLE documents USING fts5(url UNINDEXED, text)");
  const index = (url, text) => { database.prepare("DELETE FROM documents WHERE url = ?").run(url); database.prepare("INSERT INTO documents VALUES (?, ?)").run(url, text); };
  index("https://atlas.test/a", "atlas browser search");
  assert.equal(database.prepare("SELECT count(*) AS count FROM documents WHERE documents MATCH 'atlas AND search'").get().count, 1);
  index("https://atlas.test/a", "updated document only");
  assert.equal(database.prepare("SELECT count(*) AS count FROM documents WHERE documents MATCH 'atlas'").get().count, 0);
});

test("local search returns stable result pages with totals", () => {
  const results = Array.from({ length: 25 }, (_, index) => ({ kind: "document", title: `Atlas ${index}`, url: `https://example.test/${index}`, headings: [], preview: "atlas", indexedAt: "2026-01-01T00:00:00.000Z" }));
  const page = (items, number, size = 20) => ({ results: items.slice((number - 1) * size, number * size), total: items.length, page: number, pageSize: size, totalPages: Math.max(Math.ceil(items.length / size), 1) });
  const second = page(results, 2);
  assert.equal(second.total, 25);
  assert.equal(second.totalPages, 2);
  assert.equal(second.results.length, 5);
  assert.equal(second.results[0].url, "https://example.test/20");
});

test("reading list toggles a URL and keeps the newest saved entry first", () => {
  const list = [];
  const toggle = (item) => { const index = list.findIndex((entry) => entry.url === item.url); if (index >= 0) list.splice(index, 1); else list.unshift(item); return list; };
  toggle({ title: "First", url: "https://atlas.test/first", savedAt: "2026-07-01T00:00:00.000Z" });
  toggle({ title: "Second", url: "https://atlas.test/second", savedAt: "2026-07-02T00:00:00.000Z" });
  assert.deepEqual(list.map((item) => item.url), ["https://atlas.test/second", "https://atlas.test/first"]);
  toggle({ title: "First", url: "https://atlas.test/first", savedAt: "2026-07-01T00:00:00.000Z" });
  assert.deepEqual(list.map((item) => item.url), ["https://atlas.test/second"]);
});

test("saved searches and query history are unique and bounded locally", () => {
  const saved = []; const history = [];
  const toggle = (query) => { const index = saved.findIndex((item) => item.query === query); if (index >= 0) saved.splice(index, 1); else saved.unshift({ query }); };
  const record = (query) => { history.unshift({ query }); const duplicate = history.findIndex((item, index) => index > 0 && item.query === query); if (duplicate >= 0) history.splice(duplicate, 1); history.splice(3); };
  toggle("atlas"); toggle("Korean search"); toggle("atlas");
  assert.deepEqual(saved.map((item) => item.query), ["Korean search"]);
  ["atlas", "notes", "atlas", "crawler"].forEach(record);
  assert.deepEqual(history.map((item) => item.query), ["crawler", "atlas", "notes"]);
});

test("domain and date filters narrow indexed search results", () => {
  assert.equal(matchesSearchFilters({ url: "https://docs.example.com/a", indexedAt: "2026-07-10T00:00:00.000Z" }, "example.com", "2026-07-01", "2026-07-31"), true);
  assert.equal(matchesSearchFilters({ url: "https://other.test/a", indexedAt: "2026-07-10T00:00:00.000Z" }, "example.com"), false);
});

test("crawler UI progress never exceeds its configured limit", () => {
  assert.equal(crawlProgressValue(4, 3, 1, 10), 8);
  assert.equal(crawlProgressValue(30, 30, 0, 10), 10);
});

test("backup note keys distinguish content but find identical notes", () => {
  assert.equal(noteImportKey("https://atlas.test", "A quote", "Thought"), noteImportKey("https://atlas.test", "A quote", "Thought"));
  assert.notEqual(noteImportKey("https://atlas.test", "A quote", "Thought"), noteImportKey("https://atlas.test", "A quote", "Other thought"));
});

test("Korean n-grams preserve searchable syllable pairs", () => {
  assert.deepEqual(koreanNgrams("한국어 검색"), ["한국", "국어", "검색"]);
});

test("crawler URL policy blocks local network targets", () => {
  assert.equal(isSafeCrawlerUrl("https://example.test/docs"), true);
  assert.equal(isSafeCrawlerUrl("http://127.0.0.1/admin"), false);
  assert.equal(isSafeCrawlerUrl("http://192.168.1.5/"), false);
  assert.equal(isSafeCrawlerUrl("file:///etc/passwd"), false);
});

test("resolved crawler addresses reject private and link-local networks", () => {
  assert.equal(isPublicIpAddress("8.8.8.8"), true);
  assert.equal(isPublicIpAddress("172.20.0.4"), false);
  assert.equal(isPublicIpAddress("100.64.0.1"), false);
  assert.equal(isPublicIpAddress("198.18.0.1"), false);
  assert.equal(isPublicIpAddress("203.0.113.1"), false);
  assert.equal(isPublicIpAddress("169.254.169.254"), false);
  assert.equal(isPublicIpAddress("fe80::1"), false);
  assert.equal(isPublicIpAddress("::ffff:127.0.0.1"), false);
  assert.equal(isPublicIpAddress("2001:db8::1"), false);
  assert.equal(isPublicIpAddress("2606:4700:4700::1111"), true);
});

test("local crawler bounds response reads before indexing", async () => {
  assert.equal(await readCrawlResponseText(new Response("atlas"), MAX_DOCUMENT_BYTES), "atlas");
  await assert.rejects(readCrawlResponseText(new Response("", { headers: { "content-length": String(MAX_DOCUMENT_BYTES + 1) } }), MAX_DOCUMENT_BYTES), CrawlResponseTooLargeError);
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(MAX_DOCUMENT_BYTES + 1)); controller.close(); } });
  await assert.rejects(readCrawlResponseText(new Response(stream), MAX_DOCUMENT_BYTES), CrawlResponseTooLargeError);
});
