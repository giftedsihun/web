import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { crawlUrlSkipReason, normalizeCrawlPolicy, type CrawlPolicy } from "./crawl-policy";
import { koreanNgrams } from "./extract";
import type { SearchSort } from "./search-options";
import type { AuditEntry, CrawlJob, CrawlStatus, FrontierEntry, FrontierState, SearchFacets, SearchResult, SearchSuggestion } from "./types";

export class SearchStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS crawl_jobs (id TEXT PRIMARY KEY, seed_url TEXT NOT NULL, max_pages INTEGER NOT NULL, status TEXT NOT NULL, indexed INTEGER NOT NULL DEFAULT 0, skipped INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS frontier (url TEXT NOT NULL, job_id TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, host TEXT NOT NULL, depth INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL DEFAULT 0, discovered_at TEXT NOT NULL, PRIMARY KEY (job_id, url));
       CREATE TABLE IF NOT EXISTS documents (url TEXT PRIMARY KEY, canonical_url TEXT, title TEXT NOT NULL, text_hash TEXT NOT NULL, indexed_at TEXT NOT NULL);
       CREATE VIRTUAL TABLE IF NOT EXISTS document_search USING fts5(url UNINDEXED, title, text);
       CREATE VIRTUAL TABLE IF NOT EXISTS document_ngrams USING fts5(url UNINDEXED, grams);
       CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, target TEXT NOT NULL, details TEXT NOT NULL, created_at TEXT NOT NULL);
    `);
    this.migrateFrontierKey();
    this.db.exec("CREATE INDEX IF NOT EXISTS frontier_next_url ON frontier(job_id, state, available_at, discovered_at)");
    this.addColumn("crawl_jobs", "allowed_hosts", "TEXT NOT NULL DEFAULT '[]'");
    this.addColumn("crawl_jobs", "recrawl_minutes", "INTEGER");
    this.addColumn("crawl_jobs", "next_recrawl_at", "INTEGER");
    this.addColumn("crawl_jobs", "crawl_policy", "TEXT NOT NULL DEFAULT '{}' ");
    this.addColumn("crawl_jobs", "skip_reasons", "TEXT NOT NULL DEFAULT '{}'");
    this.addColumn("frontier", "last_error", "TEXT");
    this.addColumn("frontier", "depth", "INTEGER NOT NULL DEFAULT 0");
    this.addColumn("documents", "etag", "TEXT");
    this.addColumn("documents", "last_modified", "TEXT");
    this.backfillNgrams();
  }

  private addColumn(table: string, column: string, definition: string) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((item) => item.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  private jobSelect = "SELECT id, seed_url AS seedUrl, max_pages AS maxPages, status, indexed, skipped, failed, allowed_hosts AS allowedHostsJson, crawl_policy AS policyJson, skip_reasons AS skipReasonsJson, recrawl_minutes AS recrawlMinutes, next_recrawl_at AS nextRecrawlAt, created_at AS createdAt, updated_at AS updatedAt, error FROM crawl_jobs";
  private parseJob(row: (CrawlJob & { allowedHostsJson?: string; policyJson?: string; skipReasonsJson?: string }) | undefined) { if (!row) return undefined; let allowedHosts: string[] = []; let policy = normalizeCrawlPolicy(undefined); let skipReasons: Record<string, number> = {}; try { allowedHosts = JSON.parse(row.allowedHostsJson || "[]") as string[]; policy = normalizeCrawlPolicy(JSON.parse(row.policyJson || "{}")); skipReasons = JSON.parse(row.skipReasonsJson || "{}") as Record<string, number>; } catch { /* Legacy rows default safely. */ } return { ...row, allowedHosts: allowedHosts.length ? allowedHosts : [new URL(row.seedUrl).host], policy, skipReasons } as CrawlJob; }
  createJob(job: CrawlJob) { this.db.prepare("INSERT INTO crawl_jobs (id, seed_url, max_pages, status, allowed_hosts, crawl_policy, skip_reasons, recrawl_minutes, next_recrawl_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?)").run(job.id, job.seedUrl, job.maxPages, job.status, JSON.stringify(job.allowedHosts), JSON.stringify(job.policy || {}), job.recrawlMinutes ?? null, job.nextRecrawlAt ?? null, job.createdAt, job.updatedAt); this.enqueue(job.id, job.seedUrl, 0); }
  getJob(id: string) { return this.parseJob(this.db.prepare(`${this.jobSelect} WHERE id = ?`).get(id) as unknown as (CrawlJob & { allowedHostsJson?: string }) | undefined); }
  listJobs(offset = 0, limit = 20, status?: CrawlStatus) {
    const statement = status ? `${this.jobSelect} WHERE status = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?` : `${this.jobSelect} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`;
    const rows = status ? this.db.prepare(statement).all(status, limit, offset) : this.db.prepare(statement).all(limit, offset);
    return (rows as unknown as Array<CrawlJob & { allowedHostsJson?: string }>).map((row) => this.parseJob(row)!);
  }

  private backfillNgrams() {
    const existing = (this.db.prepare("SELECT count(*) AS count FROM document_ngrams").get() as { count: number }).count;
    if (existing) return;
    const rows = this.db.prepare("SELECT url, title, text FROM document_search").all() as Array<{ url: string; title: string; text: string }>;
    const insert = this.db.prepare("INSERT INTO document_ngrams (url, grams) VALUES (?, ?)");
    for (const row of rows) insert.run(row.url, koreanNgrams(`${row.title} ${row.text}`));
  }
  rebuildNgrams() {
    this.db.exec("BEGIN");
    try {
      this.db.exec("DELETE FROM document_ngrams");
      const rows = this.db.prepare("SELECT url, title, text FROM document_search").all() as Array<{ url: string; title: string; text: string }>;
      const insert = this.db.prepare("INSERT INTO document_ngrams (url, grams) VALUES (?, ?)");
      for (const row of rows) insert.run(row.url, koreanNgrams(`${row.title} ${row.text}`));
      this.audit("search_ngrams_rebuilt", "document_ngrams", JSON.stringify({ documents: rows.length }));
      this.db.exec("COMMIT");
      return { documents: rows.length };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  jobCount(status?: CrawlStatus) {
    const row = (status ? this.db.prepare("SELECT count(*) AS count FROM crawl_jobs WHERE status = ?").get(status) : this.db.prepare("SELECT count(*) AS count FROM crawl_jobs").get()) as { count: number };
    return row.count;
  }
  jobStatusSummary() {
    const summary: Record<CrawlStatus, number> = { queued: 0, running: 0, paused: 0, complete: 0, cancelled: 0, failed: 0 };
    const rows = this.db.prepare("SELECT status, count(*) AS count FROM crawl_jobs GROUP BY status").all() as Array<{ status: CrawlStatus; count: number }>;
    for (const row of rows) summary[row.status] = row.count;
    return { total: Object.values(summary).reduce((total, count) => total + count, 0), statuses: summary };
  }
  runnableJobs() { return (this.db.prepare(`${this.jobSelect} WHERE status IN ('queued', 'running')`).all() as unknown as Array<CrawlJob & { allowedHostsJson?: string }>).map((row) => this.parseJob(row)!); }
  recoverInterruptedJobs() {
    // Only `processing` represents an in-flight request, so completed frontier entries stay complete after a restart.
    this.db.exec("BEGIN");
    try {
      this.db.prepare("UPDATE frontier SET state = 'queued', available_at = 0 WHERE state = 'processing' AND job_id IN (SELECT id FROM crawl_jobs WHERE status = 'running')").run();
      this.db.prepare("UPDATE crawl_jobs SET status = 'queued', updated_at = ? WHERE status = 'running'").run(new Date().toISOString());
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  dueRecrawls(now: number) { return (this.db.prepare(`${this.jobSelect} WHERE status = 'complete' AND next_recrawl_at IS NOT NULL AND next_recrawl_at <= ?`).all(now) as unknown as Array<CrawlJob & { allowedHostsJson?: string }>).map((row) => this.parseJob(row)!); }
  enqueue(jobId: string, url: string, depth = 0) {
    // Bound stored frontier entries as well as fetched pages so link-heavy sites cannot inflate the database.
    const job = this.getJob(jobId);
    if (!job || this.frontierCount(jobId) >= job.maxPages) return false;
    const reason = crawlUrlSkipReason(url, depth, job.policy || normalizeCrawlPolicy(undefined));
    if (reason) { this.recordSkipReason(jobId, reason); return false; }
    this.db.prepare("INSERT OR IGNORE INTO frontier (url, job_id, state, host, depth, discovered_at) VALUES (?, ?, 'queued', ?, ?, ?)").run(url, jobId, new URL(url).host, depth, new Date().toISOString());
    return true;
  }

  private migrateFrontierKey() {
    const columns = this.db.prepare("PRAGMA table_info(frontier)").all() as Array<{ name: string; pk: number }>;
    if (columns.find((column) => column.name === "url")?.pk !== 1 || columns.find((column) => column.name === "job_id")?.pk === 2) return;
    this.db.exec(`
      BEGIN;
      ALTER TABLE frontier RENAME TO frontier_legacy;
      CREATE TABLE frontier (url TEXT NOT NULL, job_id TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, host TEXT NOT NULL, depth INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL DEFAULT 0, discovered_at TEXT NOT NULL, PRIMARY KEY (job_id, url));
      INSERT INTO frontier (url, job_id, state, attempts, host, available_at, discovered_at)
        SELECT url, job_id, state, attempts, host, available_at, discovered_at FROM frontier_legacy;
      DROP TABLE frontier_legacy;
      COMMIT;
    `);
  }
  frontierCount(jobId: string) { return (this.db.prepare("SELECT count(*) AS count FROM frontier WHERE job_id = ?").get(jobId) as { count: number }).count; }
  frontierStatusSummary(jobId: string) {
    const states: Record<FrontierState, number> = { queued: 0, processing: 0, fetched: 0, failed: 0 };
    const rows = this.db.prepare("SELECT state, count(*) AS count FROM frontier WHERE job_id = ? GROUP BY state").all(jobId) as Array<{ state: keyof typeof states; count: number }>;
    for (const row of rows) if (row.state in states) states[row.state] = row.count;
    const attempts = this.db.prepare("SELECT count(*) FILTER (WHERE attempts > 0) AS attempted, coalesce(sum(attempts), 0) AS attempts, coalesce(sum(CASE WHEN attempts > 1 THEN attempts - 1 ELSE 0 END), 0) AS retries FROM frontier WHERE job_id = ?").get(jobId) as { attempted: number; attempts: number; retries: number };
    return { total: states.queued + states.processing + states.fetched + states.failed, states, ...attempts };
  }
  listFrontier(jobId: string, offset = 0, limit = 20, state?: FrontierState) {
    const select = "SELECT url, state, attempts, host, depth, available_at AS availableAt, discovered_at AS discoveredAt, last_error AS lastError FROM frontier WHERE job_id = ?";
    const statement = state ? `${select} AND state = ? ORDER BY discovered_at, url LIMIT ? OFFSET ?` : `${select} ORDER BY discovered_at, url LIMIT ? OFFSET ?`;
    return (state ? this.db.prepare(statement).all(jobId, state, limit, offset) : this.db.prepare(statement).all(jobId, limit, offset)) as FrontierEntry[];
  }
  frontierCountByState(jobId: string, state?: FrontierState) {
    const row = (state ? this.db.prepare("SELECT count(*) AS count FROM frontier WHERE job_id = ? AND state = ?").get(jobId, state) : this.db.prepare("SELECT count(*) AS count FROM frontier WHERE job_id = ?").get(jobId)) as { count: number };
    return row.count;
  }
  nextUrl(jobId: string) { return this.db.prepare("SELECT url, depth FROM frontier WHERE job_id = ? AND state = 'queued' AND available_at <= ? ORDER BY discovered_at, url LIMIT 1").get(jobId, Date.now()) as { url: string; depth: number } | undefined; }
  hasQueuedUrl(jobId: string) { return !!this.db.prepare("SELECT 1 FROM frontier WHERE job_id = ? AND state = 'queued' LIMIT 1").get(jobId); }
  markProcessing(jobId: string, url: string) { this.db.prepare("UPDATE frontier SET state = 'processing', attempts = attempts + 1, last_error = NULL WHERE job_id = ? AND url = ?").run(jobId, url); }
  markFetched(jobId: string, url: string) { this.db.prepare("UPDATE frontier SET state = 'fetched', last_error = NULL WHERE job_id = ? AND url = ?").run(jobId, url); }
  markFailed(jobId: string, url: string, error: string) { this.db.prepare("UPDATE frontier SET state = 'failed', last_error = ? WHERE job_id = ? AND url = ?").run(error.replace(/\s+/g, " ").trim().slice(0, 500) || "Crawler request failed", jobId, url); }
  recordSkipReason(id: string, reason: string, incrementSkipped = false) { const job = this.getJob(id); if (!job) return; const skipReasons = { ...(job.skipReasons || {}) }; skipReasons[reason] = (skipReasons[reason] || 0) + 1; this.db.prepare("UPDATE crawl_jobs SET skipped = ?, skip_reasons = ?, updated_at = ? WHERE id = ?").run(job.skipped + (incrementSkipped ? 1 : 0), JSON.stringify(skipReasons), new Date().toISOString(), id); }
  defer(jobId: string, url: string, until: number) { this.db.prepare("UPDATE frontier SET available_at = ? WHERE job_id = ? AND url = ?").run(until, jobId, url); }
  updateJob(id: string, values: Partial<Pick<CrawlJob, "status" | "indexed" | "skipped" | "failed" | "error">>) { const job = this.getJob(id); if (!job) return; const error = values.error === undefined ? job.error : values.error?.replace(/\s+/g, " ").trim().slice(0, 500); this.db.prepare("UPDATE crawl_jobs SET status = ?, indexed = ?, skipped = ?, failed = ?, error = ?, updated_at = ? WHERE id = ?").run(values.status ?? job.status, values.indexed ?? job.indexed, values.skipped ?? job.skipped, values.failed ?? job.failed, error || null, new Date().toISOString(), id); }
  cancelJob(id: string) { const job = this.getJob(id); if (!job || job.status === "complete" || job.status === "failed") return false; this.updateJob(id, { status: "cancelled" }); return true; }
  pauseJob(id: string) { const job = this.getJob(id); if (!job || !["queued", "running"].includes(job.status)) return false; this.updateJob(id, { status: "paused" }); this.audit("crawl_paused", id, ""); return true; }
  resumeJob(id: string) { const job = this.getJob(id); if (!job || job.status !== "paused") return false; this.updateJob(id, { status: "queued" }); this.audit("crawl_resumed", id, ""); return true; }
  setRecrawlMinutes(id: string, minutes: number | undefined) { const job = this.getJob(id); if (!job) return false; const next = minutes ? Date.now() + minutes * 60_000 : null; this.db.prepare("UPDATE crawl_jobs SET recrawl_minutes = ?, next_recrawl_at = ?, updated_at = ? WHERE id = ?").run(minutes ?? null, next, new Date().toISOString(), id); this.audit("crawl_schedule_updated", id, JSON.stringify({ recrawlMinutes: minutes ?? null })); return true; }
  restartJob(id: string, nextRecrawlAt?: number) {
    const job = this.getJob(id);
    if (!job || !["complete", "cancelled", "failed"].includes(job.status)) return false;
    this.db.exec("BEGIN");
    try {
      this.db.prepare("UPDATE frontier SET state = 'queued', available_at = 0, last_error = NULL WHERE job_id = ?").run(id);
      this.db.prepare("UPDATE crawl_jobs SET status = 'queued', indexed = 0, skipped = 0, failed = 0, error = NULL, skip_reasons = '{}', next_recrawl_at = ?, updated_at = ? WHERE id = ?").run(nextRecrawlAt ?? job.nextRecrawlAt ?? null, new Date().toISOString(), id);
      this.db.exec("COMMIT");
      return true;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  restartForRecrawl(id: string) { const job = this.getJob(id); return !!job?.recrawlMinutes && this.restartJob(id, Date.now() + job.recrawlMinutes * 60_000); }
  retryFailedFrontier(id: string) {
    const job = this.getJob(id);
    if (!job || !["complete", "cancelled", "failed"].includes(job.status)) return 0;
    const failed = this.frontierCountByState(id, "failed");
    if (!failed) return 0;
    this.db.exec("BEGIN");
    try {
      this.db.prepare("UPDATE frontier SET state = 'queued', available_at = 0, last_error = NULL WHERE job_id = ? AND state = 'failed'").run(id);
      this.db.prepare("UPDATE crawl_jobs SET status = 'queued', failed = MAX(failed - ?, 0), error = NULL, updated_at = ? WHERE id = ?").run(failed, new Date().toISOString(), id);
      this.db.exec("COMMIT");
      return failed;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  validators(url: string) { return this.db.prepare("SELECT etag, last_modified AS lastModified FROM documents WHERE url = ?").get(url) as { etag?: string | null; lastModified?: string | null } | undefined; }
  touchDocument(url: string) { this.db.prepare("UPDATE documents SET indexed_at = ? WHERE url = ?").run(new Date().toISOString(), url); }
  index(url: string, canonicalUrl: string | undefined, title: string, text: string, hash: string, validators?: { etag?: string | null; lastModified?: string | null }) { this.db.prepare("DELETE FROM document_search WHERE url = ?").run(url); this.db.prepare("DELETE FROM document_ngrams WHERE url = ?").run(url); this.db.prepare("INSERT INTO documents (url, canonical_url, title, text_hash, indexed_at, etag, last_modified) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(url) DO UPDATE SET canonical_url = excluded.canonical_url, title = excluded.title, text_hash = excluded.text_hash, indexed_at = excluded.indexed_at, etag = excluded.etag, last_modified = excluded.last_modified").run(url, canonicalUrl ?? null, title, hash, new Date().toISOString(), validators?.etag ?? null, validators?.lastModified ?? null); this.db.prepare("INSERT INTO document_search (url, title, text) VALUES (?, ?, ?)").run(url, title, text); this.db.prepare("INSERT INTO document_ngrams (url, grams) VALUES (?, ?)").run(url, koreanNgrams(`${title} ${text}`)); }
  private searchWhere(domain?: string, from?: string, to?: string) { return ["document_search MATCH ?", domain ? "(d.url = ? OR d.url LIKE ?)" : "", from ? "d.indexed_at >= ?" : "", to ? "d.indexed_at < ?" : ""].filter(Boolean).join(" AND "); }
  private searchBindings(query: string, domain?: string, from?: string, to?: string) { const nextDay = to ? new Date(new Date(`${to}T00:00:00.000Z`).getTime() + 86_400_000).toISOString() : undefined; return [query, ...(domain ? [`https://${domain}`, `https://${domain}/%`] : []), ...(from ? [`${from}T00:00:00.000Z`] : []), ...(nextDay ? [nextDay] : [])]; }
  search(query: string, offset: number, limit: number, sort: SearchSort = "relevance", domain?: string, from?: string, to?: string) { const order = sort === "newest" ? "d.indexed_at DESC, d.url ASC" : "score DESC, d.indexed_at DESC, d.url ASC"; const bindings = this.searchBindings(query, domain, from, to); const sql = `SELECT d.title, d.url, snippet(document_search, 2, '<mark>', '</mark>', '...', 22) AS preview, d.indexed_at AS indexedAt, -bm25(document_search, 0.0, 5.0, 1.0) AS score FROM document_search JOIN documents d ON d.url = document_search.url WHERE ${this.searchWhere(domain, from, to)} ORDER BY ${order} LIMIT ? OFFSET ?`; const results = this.db.prepare(sql).all(...bindings, limit, offset) as SearchResult[]; if (results.length || !/[가-힣]/.test(query)) return results; const grams = koreanNgrams(query).split(" ").join(" AND "); const fallback = `SELECT d.title, d.url, d.title AS preview, d.indexed_at AS indexedAt, 0 AS score FROM document_ngrams JOIN documents d ON d.url = document_ngrams.url WHERE document_ngrams MATCH ?${domain ? " AND (d.url = ? OR d.url LIKE ?)" : ""}${from ? " AND d.indexed_at >= ?" : ""}${to ? " AND d.indexed_at < ?" : ""} ORDER BY d.indexed_at DESC, d.url ASC LIMIT ? OFFSET ?`; return this.db.prepare(fallback).all(...this.searchBindings(grams, domain, from, to), limit, offset) as SearchResult[]; }
  searchCount(query: string, domain?: string, from?: string, to?: string) { const bindings = this.searchBindings(query, domain, from, to); const sql = `SELECT count(*) AS count FROM document_search JOIN documents d ON d.url = document_search.url WHERE ${this.searchWhere(domain, from, to)}`; const count = this.db.prepare(sql).get(...bindings) as { count: number }; if (count.count || !/[가-힣]/.test(query)) return count.count; const grams = koreanNgrams(query).split(" ").join(" AND "); const fallback = `SELECT count(*) AS count FROM document_ngrams JOIN documents d ON d.url = document_ngrams.url WHERE document_ngrams MATCH ?${domain ? " AND (d.url = ? OR d.url LIKE ?)" : ""}${from ? " AND d.indexed_at >= ?" : ""}${to ? " AND d.indexed_at < ?" : ""}`; return (this.db.prepare(fallback).get(...this.searchBindings(grams, domain, from, to)) as { count: number }).count; }
  searchFacets(query: string, domain?: string, from?: string, to?: string): SearchFacets { const where = this.searchWhere(domain, from, to); const bindings = this.searchBindings(query, domain, from, to); const domains = this.db.prepare(`SELECT substr(substr(d.url, instr(d.url, '//') + 2), 1, instr(substr(d.url, instr(d.url, '//') + 2), '/') - 1) AS domain, count(*) AS count FROM document_search JOIN documents d ON d.url = document_search.url WHERE ${where} GROUP BY domain ORDER BY count DESC, domain ASC LIMIT 8`).all(...bindings) as SearchFacets["domains"]; const dates = this.db.prepare(`SELECT substr(d.indexed_at, 1, 10) AS date, count(*) AS count FROM document_search JOIN documents d ON d.url = document_search.url WHERE ${where} GROUP BY date ORDER BY date DESC LIMIT 8`).all(...bindings) as SearchFacets["dates"]; return { domains, dates }; }
  suggestions(prefix: string, limit = 8): SearchSuggestion[] { const term = prefix.trim().replace(/["*^():]/g, ""); if (term.length < 2) return []; const values = this.db.prepare("SELECT title, url FROM documents WHERE title LIKE ? ESCAPE '\\' ORDER BY indexed_at DESC, title ASC LIMIT ?").all(`${term.replace(/[\\%_]/g, "\\$&")}%`, limit) as Array<{ title: string; url: string }>; const seen = new Set<string>(); const suggestions: SearchSuggestion[] = []; for (const row of values) { if (!seen.has(row.title.toLowerCase())) { seen.add(row.title.toLowerCase()); suggestions.push({ value: row.title, label: row.title, kind: "title" }); } try { const domain = new URL(row.url).hostname; if (!seen.has(domain)) { seen.add(domain); suggestions.push({ value: domain, label: `domain: ${domain}`, kind: "domain" }); } } catch { /* Indexed URLs are normalized by the crawler. */ } if (suggestions.length >= limit) break; } return suggestions.slice(0, limit); }
  listDocuments(domain: string | undefined, offset = 0, limit = 20) { const where = domain ? "WHERE url = ? OR url LIKE ?" : ""; const rows = domain ? this.db.prepare(`SELECT url, canonical_url AS canonicalUrl, title, text_hash AS textHash, indexed_at AS indexedAt FROM documents ${where} ORDER BY indexed_at DESC, url ASC LIMIT ? OFFSET ?`).all(`https://${domain}`, `https://${domain}/%`, limit, offset) : this.db.prepare("SELECT url, canonical_url AS canonicalUrl, title, text_hash AS textHash, indexed_at AS indexedAt FROM documents ORDER BY indexed_at DESC, url ASC LIMIT ? OFFSET ?").all(limit, offset); return rows; }
  inspectDocument(url: string) { const document = this.db.prepare("SELECT d.url, d.canonical_url AS canonicalUrl, d.title, d.text_hash AS textHash, d.indexed_at AS indexedAt, d.etag, d.last_modified AS lastModified, length(s.title) AS titleLength, length(s.text) AS textLength, length(trim(s.text)) - length(replace(trim(s.text), ' ', '')) + CASE WHEN length(trim(s.text)) = 0 THEN 0 ELSE 1 END AS wordCount FROM documents d JOIN document_search s ON s.url = d.url WHERE d.url = ?").get(url) as { url: string; canonicalUrl?: string | null; title: string; textHash: string; indexedAt: string; etag?: string | null; lastModified?: string | null; titleLength: number; textLength: number; wordCount: number } | undefined; if (!document) return undefined; const crawlJobs = this.db.prepare("SELECT j.id, j.status, f.state, f.depth, j.updated_at AS updatedAt FROM frontier f JOIN crawl_jobs j ON j.id = f.job_id WHERE f.url = ? ORDER BY j.updated_at DESC, j.id DESC").all(url); return { url: document.url, canonicalUrl: document.canonicalUrl, title: document.title, indexedAt: document.indexedAt, etag: document.etag, lastModified: document.lastModified, quality: { titleLength: document.titleLength, textLength: document.textLength, wordCount: document.wordCount, textHash: document.textHash, hasValidators: !!(document.etag || document.lastModified) }, crawlJobs }; }
  deleteDocument(url: string) { if (!this.inspectDocument(url)) return false; this.db.exec("BEGIN"); try { this.db.prepare("DELETE FROM document_search WHERE url = ?").run(url); this.db.prepare("DELETE FROM document_ngrams WHERE url = ?").run(url); this.db.prepare("DELETE FROM documents WHERE url = ?").run(url); this.audit("document_deleted", url, ""); this.db.exec("COMMIT"); return true; } catch (error) { this.db.exec("ROLLBACK"); throw error; } }
  requeueDocument(url: string, jobId?: string) { const document = this.inspectDocument(url); if (!document) return undefined; const candidate = (document.crawlJobs as Array<{ id: string; status: string; state: string; depth: number }>).filter((job) => !jobId || job.id === jobId).find((entry) => { const job = this.getJob(entry.id); return !!job && job.allowedHosts.includes(new URL(url).host) && !crawlUrlSkipReason(url, entry.depth, job.policy || normalizeCrawlPolicy(undefined)); }); if (!candidate) return null; const job = this.getJob(candidate.id)!; this.db.exec("BEGIN"); try { this.db.prepare("UPDATE frontier SET state = 'queued', available_at = 0, last_error = NULL WHERE job_id = ? AND url = ?").run(job.id, url); this.db.prepare("UPDATE crawl_jobs SET status = ?, indexed = ?, failed = ?, error = NULL, updated_at = ? WHERE id = ?").run(job.status === "paused" ? "paused" : "queued", candidate.state === "fetched" ? Math.max(job.indexed - 1, 0) : job.indexed, candidate.state === "failed" ? Math.max(job.failed - 1, 0) : job.failed, new Date().toISOString(), job.id); this.audit("document_requeued", url, JSON.stringify({ jobId: job.id })); this.db.exec("COMMIT"); return { jobId: job.id, status: job.status === "paused" ? "paused" : "queued" }; } catch (error) { this.db.exec("ROLLBACK"); throw error; } }
  documentCountByDomain(domain?: string) { const row = (domain ? this.db.prepare("SELECT count(*) AS count FROM documents WHERE url = ? OR url LIKE ?").get(`https://${domain}`, `https://${domain}/%`) : this.db.prepare("SELECT count(*) AS count FROM documents").get()) as { count: number }; return row.count; }
  deleteDocumentsByDomain(domain: string, dryRun: boolean) { const count = this.documentCountByDomain(domain); if (!dryRun) { this.db.exec("BEGIN"); try { const urls = "SELECT url FROM documents WHERE url = ? OR url LIKE ?"; this.db.prepare(`DELETE FROM document_search WHERE url IN (${urls})`).run(`https://${domain}`, `https://${domain}/%`); this.db.prepare(`DELETE FROM document_ngrams WHERE url IN (${urls})`).run(`https://${domain}`, `https://${domain}/%`); this.db.prepare("DELETE FROM documents WHERE url = ? OR url LIKE ?").run(`https://${domain}`, `https://${domain}/%`); this.audit("documents_deleted", domain, JSON.stringify({ count })); this.db.exec("COMMIT"); } catch (error) { this.db.exec("ROLLBACK"); throw error; } } return { domain, dryRun, documents: count }; }
  audit(action: string, target: string, details: string) { this.db.prepare("INSERT INTO audit_log (action, target, details, created_at) VALUES (?, ?, ?, ?)").run(action, target, details.slice(0, 500), new Date().toISOString()); }
  listAudit(offset = 0, limit = 20) { return this.db.prepare("SELECT id, action, target, details, created_at AS createdAt FROM audit_log ORDER BY id DESC LIMIT ? OFFSET ?").all(limit, offset) as AuditEntry[]; }
  stats(path: string) { let bytes = 0; try { bytes = statSync(path).size; } catch { /* Database can be created after stats are requested. */ } return { documents: this.documentCount(), jobs: this.jobCount(), frontier: (this.db.prepare("SELECT count(*) AS count FROM frontier").get() as { count: number }).count, databaseBytes: bytes }; }
  retention(cutoff: string, deleteDocuments: boolean, dryRun: boolean) { const jobs = (this.db.prepare("SELECT count(*) AS count FROM crawl_jobs WHERE status IN ('complete', 'cancelled', 'failed') AND updated_at < ?").get(cutoff) as { count: number }).count; const frontier = (this.db.prepare("SELECT count(*) AS count FROM frontier WHERE job_id IN (SELECT id FROM crawl_jobs WHERE status IN ('complete', 'cancelled', 'failed') AND updated_at < ?)").get(cutoff) as { count: number }).count; const documents = deleteDocuments ? (this.db.prepare("SELECT count(*) AS count FROM documents WHERE indexed_at < ?").get(cutoff) as { count: number }).count : 0; if (!dryRun) { this.db.exec("BEGIN"); try { if (deleteDocuments) { this.db.prepare("DELETE FROM document_search WHERE url IN (SELECT url FROM documents WHERE indexed_at < ?)").run(cutoff); this.db.prepare("DELETE FROM document_ngrams WHERE url IN (SELECT url FROM documents WHERE indexed_at < ?)").run(cutoff); this.db.prepare("DELETE FROM documents WHERE indexed_at < ?").run(cutoff); } this.db.prepare("DELETE FROM frontier WHERE job_id IN (SELECT id FROM crawl_jobs WHERE status IN ('complete', 'cancelled', 'failed') AND updated_at < ?)").run(cutoff); this.db.prepare("DELETE FROM crawl_jobs WHERE status IN ('complete', 'cancelled', 'failed') AND updated_at < ?").run(cutoff); this.audit("retention_executed", cutoff, JSON.stringify({ jobs, frontier, documents })); this.db.exec("COMMIT"); } catch (error) { this.db.exec("ROLLBACK"); throw error; } } return { cutoff, dryRun, jobs, frontier, documents }; }
  optimizeSearch() { this.db.prepare("INSERT INTO document_search(document_search) VALUES('optimize')").run(); this.audit("search_optimized", "document_search", ""); return { documents: this.documentCount() }; }
  documentCount() { return (this.db.prepare("SELECT count(*) AS count FROM documents").get() as { count: number }).count; }
  close() { this.db.close(); }
}
