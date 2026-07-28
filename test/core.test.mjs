import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { clampCrawlLimit, crawlProgressValue, matchesSearchFilters, normalizeSession, noteImportKey } from "../dist/core.js";

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
