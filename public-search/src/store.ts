import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CrawlJob, SearchResult } from "./types";

export class SearchStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS crawl_jobs (id TEXT PRIMARY KEY, seed_url TEXT NOT NULL, max_pages INTEGER NOT NULL, status TEXT NOT NULL, indexed INTEGER NOT NULL DEFAULT 0, skipped INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS frontier (url TEXT PRIMARY KEY, job_id TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, host TEXT NOT NULL, available_at INTEGER NOT NULL DEFAULT 0, discovered_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS documents (url TEXT PRIMARY KEY, canonical_url TEXT, title TEXT NOT NULL, text_hash TEXT NOT NULL, indexed_at TEXT NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS document_search USING fts5(url UNINDEXED, title, text);
    `);
    this.addColumn("crawl_jobs", "allowed_hosts", "TEXT NOT NULL DEFAULT '[]'");
    this.addColumn("crawl_jobs", "recrawl_minutes", "INTEGER");
    this.addColumn("crawl_jobs", "next_recrawl_at", "INTEGER");
  }

  private addColumn(table: string, column: string, definition: string) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((item) => item.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  private jobSelect = "SELECT id, seed_url AS seedUrl, max_pages AS maxPages, status, indexed, skipped, failed, allowed_hosts AS allowedHostsJson, recrawl_minutes AS recrawlMinutes, next_recrawl_at AS nextRecrawlAt, created_at AS createdAt, updated_at AS updatedAt, error FROM crawl_jobs";
  private parseJob(row: (CrawlJob & { allowedHostsJson?: string }) | undefined) { if (!row) return undefined; let allowedHosts: string[] = []; try { allowedHosts = JSON.parse(row.allowedHostsJson || "[]") as string[]; } catch { /* Legacy rows default to the seed host. */ } return { ...row, allowedHosts: allowedHosts.length ? allowedHosts : [new URL(row.seedUrl).host] } as CrawlJob; }
  createJob(job: CrawlJob) { this.db.prepare("INSERT INTO crawl_jobs (id, seed_url, max_pages, status, allowed_hosts, recrawl_minutes, next_recrawl_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(job.id, job.seedUrl, job.maxPages, job.status, JSON.stringify(job.allowedHosts), job.recrawlMinutes ?? null, job.nextRecrawlAt ?? null, job.createdAt, job.updatedAt); this.enqueue(job.id, job.seedUrl); }
  getJob(id: string) { return this.parseJob(this.db.prepare(`${this.jobSelect} WHERE id = ?`).get(id) as unknown as (CrawlJob & { allowedHostsJson?: string }) | undefined); }
  listJobs() { return (this.db.prepare(`${this.jobSelect} ORDER BY created_at DESC LIMIT 20`).all() as unknown as Array<CrawlJob & { allowedHostsJson?: string }>).map((row) => this.parseJob(row)!); }
  runnableJobs() { return (this.db.prepare(`${this.jobSelect} WHERE status IN ('queued', 'running')`).all() as unknown as Array<CrawlJob & { allowedHostsJson?: string }>).map((row) => this.parseJob(row)!); }
  dueRecrawls(now: number) { return (this.db.prepare(`${this.jobSelect} WHERE status = 'complete' AND next_recrawl_at IS NOT NULL AND next_recrawl_at <= ?`).all(now) as unknown as Array<CrawlJob & { allowedHostsJson?: string }>).map((row) => this.parseJob(row)!); }
  enqueue(jobId: string, url: string) { this.db.prepare("INSERT OR IGNORE INTO frontier (url, job_id, state, host, discovered_at) VALUES (?, ?, 'queued', ?, ?)").run(url, jobId, new URL(url).host, new Date().toISOString()); }
  nextUrl(jobId: string) { return this.db.prepare("SELECT url FROM frontier WHERE job_id = ? AND state = 'queued' AND available_at <= ? ORDER BY discovered_at LIMIT 1").get(jobId, Date.now()) as { url: string } | undefined; }
  hasQueuedUrl(jobId: string) { return !!this.db.prepare("SELECT 1 FROM frontier WHERE job_id = ? AND state = 'queued' LIMIT 1").get(jobId); }
  markFetched(url: string) { this.db.prepare("UPDATE frontier SET state = 'fetched', attempts = attempts + 1 WHERE url = ?").run(url); }
  defer(url: string, until: number) { this.db.prepare("UPDATE frontier SET available_at = ? WHERE url = ?").run(until, url); }
  updateJob(id: string, values: Partial<Pick<CrawlJob, "status" | "indexed" | "skipped" | "failed" | "error">>) { const job = this.getJob(id); if (!job) return; this.db.prepare("UPDATE crawl_jobs SET status = ?, indexed = ?, skipped = ?, failed = ?, error = ?, updated_at = ? WHERE id = ?").run(values.status ?? job.status, values.indexed ?? job.indexed, values.skipped ?? job.skipped, values.failed ?? job.failed, values.error ?? job.error ?? null, new Date().toISOString(), id); }
  cancelJob(id: string) { const job = this.getJob(id); if (!job || job.status === "complete" || job.status === "failed") return false; this.updateJob(id, { status: "cancelled" }); return true; }
  restartForRecrawl(id: string) { const job = this.getJob(id); if (!job || !job.recrawlMinutes) return false; const nextRecrawlAt = Date.now() + job.recrawlMinutes * 60_000; this.db.prepare("UPDATE frontier SET state = 'queued', available_at = 0 WHERE job_id = ?").run(id); this.db.prepare("UPDATE crawl_jobs SET status = 'queued', indexed = 0, skipped = 0, failed = 0, error = NULL, next_recrawl_at = ?, updated_at = ? WHERE id = ?").run(nextRecrawlAt, new Date().toISOString(), id); return true; }
  index(url: string, canonicalUrl: string | undefined, title: string, text: string, hash: string) { this.db.prepare("DELETE FROM document_search WHERE url = ?").run(url); this.db.prepare("INSERT INTO documents (url, canonical_url, title, text_hash, indexed_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(url) DO UPDATE SET canonical_url = excluded.canonical_url, title = excluded.title, text_hash = excluded.text_hash, indexed_at = excluded.indexed_at").run(url, canonicalUrl ?? null, title, hash, new Date().toISOString()); this.db.prepare("INSERT INTO document_search (url, title, text) VALUES (?, ?, ?)").run(url, title, text); }
  search(query: string, offset: number, limit: number) { return this.db.prepare("SELECT d.title, d.url, snippet(document_search, 2, '<mark>', '</mark>', '...', 22) AS preview, d.indexed_at AS indexedAt, -bm25(document_search) AS score FROM document_search JOIN documents d ON d.url = document_search.url WHERE document_search MATCH ? ORDER BY score DESC, d.indexed_at DESC LIMIT ? OFFSET ?").all(query, limit, offset) as SearchResult[]; }
  searchCount(query: string) { return (this.db.prepare("SELECT count(*) AS count FROM document_search WHERE document_search MATCH ?").get(query) as { count: number }).count; }
  documentCount() { return (this.db.prepare("SELECT count(*) AS count FROM documents").get() as { count: number }).count; }
  close() { this.db.close(); }
}
