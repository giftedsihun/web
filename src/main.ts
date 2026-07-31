import { app, BrowserWindow, dialog, ipcMain, session } from "electron";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fork, type ChildProcess } from "node:child_process";
import { lookup } from "node:dns/promises";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { clampCrawlLimit, isPublicIpAddress, isSafeCrawlerUrl, koreanNgrams, normalizeSession, noteImportKey } from "./core";
import { MAX_DOCUMENT_BYTES, MAX_ROBOTS_BYTES, MAX_SITEMAP_BYTES, readCrawlResponseText } from "./crawl-response";

type LinkItem = { title: string; url: string };
type IndexedDocument = { title: string; url: string; text: string; headings: string[]; links: LinkItem[]; indexedAt: string };
type SavedState = { bookmarks: Bookmark[]; readingList?: ReadingItem[]; savedSearches?: SavedSearch[]; searchHistory?: SearchHistoryItem[]; history: HistoryItem[]; documents: IndexedDocument[] };
type SessionTab = { title: string; url: string; closedAt?: string };
type TabSession = { tabs: SessionTab[]; activeUrl: string; recentlyClosed: SessionTab[] };
type Bookmark = { title: string; url: string; createdAt: string };
type HistoryItem = { title: string; url: string; visitedAt: string };
type ReadingItem = { title: string; url: string; savedAt: string };
type SavedSearch = { query: string; savedAt: string };
type SearchHistoryItem = { query: string; searchedAt: string };
type GraphDocument = { title: string; url: string; indexedAt: string; links: LinkItem[] };
type Note = { id: number; quote: string; body: string; tags: string[]; sourceUrl: string; sourceTitle: string; createdAt: string };
type NoteInput = Omit<Note, "id" | "createdAt">;
type NoteUpdate = Pick<Note, "id" | "body" | "tags">;
type GraphData = { documents: GraphDocument[]; notes: Note[] };
type SearchResult = { kind: "document"; title: string; url: string; headings: string[]; preview: string; indexedAt: string } | { kind: "note"; id: number; title: string; url: string; quote: string; body: string; tags: string[]; preview: string; indexedAt: string };
type CrawlRequest = { jobId?: string; url: string; maxPages?: number; sameHost?: boolean };
type CrawlResult = { indexed: number; skipped: number; failed: number; message: string };
type CrawlProgress = { jobId: string; indexed: number; skipped: number; failed: number; queued: number; limit: number; currentUrl?: string; status: "running" | "cancelled" | "complete" };
type BackupDocument = IndexedDocument;
type BackupData = { version: 1; createdAt: string; state: SavedState; session: TabSession; documents: BackupDocument[]; notes: Note[] };
type CrawlJob = { cancelled: boolean; controller: AbortController };

let database: DatabaseSync;
const crawlJobs = new Map<string, CrawlJob>();
let publicSearchProcess: ChildProcess | undefined;
let publicSearchConfig: { endpoint: string; adminToken: string } | undefined;

type DownloadStatus = { id: string; name: string; state: "starting" | "progressing" | "complete" | "cancelled" | "interrupted"; received: number; total: number; path?: string };

function sendDownloadStatus(webContents: Electron.WebContents, status: DownloadStatus) {
  const host = (webContents as Electron.WebContents & { hostWebContents?: Electron.WebContents }).hostWebContents || webContents;
  if (!host.isDestroyed()) host.send("download:updated", status);
}

function configureGuestSession() {
  const guestSession = session.fromPartition("persist:atlas");
  guestSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  guestSession.setPermissionCheckHandler(() => false);
  guestSession.on("will-download", (_event, item, webContents) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const name = item.getFilename();
    sendDownloadStatus(webContents, { id, name, state: "starting", received: 0, total: item.getTotalBytes() });
    item.pause();
    void dialog.showSaveDialog({ title: "다운로드 저장", defaultPath: join(app.getPath("downloads"), name) }).then((target) => {
      if (target.canceled || !target.filePath) { item.cancel(); return; }
      item.setSavePath(target.filePath);
      item.resume();
    });
    item.on("updated", (_updateEvent, state) => sendDownloadStatus(webContents, { id, name, state: state === "interrupted" ? "interrupted" : "progressing", received: item.getReceivedBytes(), total: item.getTotalBytes() }));
    item.once("done", (_doneEvent, state) => sendDownloadStatus(webContents, { id, name, state: state === "completed" ? "complete" : state === "cancelled" ? "cancelled" : "interrupted", received: item.getReceivedBytes(), total: item.getTotalBytes(), path: state === "completed" ? item.getSavePath() : undefined }));
  });
}

const statePath = () => join(app.getPath("userData"), "knowledge-browser.json");
const loadState = (): SavedState => {
  try { return JSON.parse(readFileSync(statePath(), "utf8")) as SavedState; }
  catch { return { bookmarks: [], readingList: [], savedSearches: [], searchHistory: [], history: [], documents: [] }; }
};
const saveState = (state: SavedState) => writeFileSync(statePath(), JSON.stringify(state, null, 2));
const sessionPath = () => join(app.getPath("userData"), "atlas-tabs.json");
const publicSearchTokenPath = () => join(app.getPath("userData"), "public-search-admin-token");
type SupabaseConfig = { url: string; anonKey: string };
const environmentFiles = () => [...new Set([
  join(app.getAppPath(), ".env"),
  join(process.cwd(), ".env"),
  join(process.resourcesPath, ".env"),
  join(dirname(process.execPath), ".env"),
])];
const environmentValue = (name: string) => {
  if (process.env[name]) return process.env[name];
  for (const file of environmentFiles()) {
    try {
      const line = readFileSync(file, "utf8").split(/\r?\n/).find((value) => value.trimStart().startsWith(`${name}=`));
      if (line) return line.slice(line.indexOf("=") + 1).trim().replace(/^(["'])(.*)\1$/, "$2");
    } catch { /* Try the next supported configuration location. */ }
  }
  return undefined;
};
const supabaseConfig = (): SupabaseConfig | undefined => {
  const url = environmentValue("SUPABASE_URL"); const anonKey = environmentValue("SUPABASE_ANON_KEY") || environmentValue("SUPABASE_PUBLISHABLE_KEY");
  return url && anonKey && /^https:\/\/[^.]+\.supabase\.co$/.test(url) ? { url, anonKey } : undefined;
};
const emptySession = (): TabSession => ({ tabs: [], activeUrl: "", recentlyClosed: [] });
const loadSession = (): TabSession => {
  try {
    return normalizeSession(JSON.parse(readFileSync(sessionPath(), "utf8")) as Partial<TabSession>);
  } catch { return emptySession(); }
};
const saveSession = (session: TabSession) => writeFileSync(sessionPath(), JSON.stringify({
  tabs: session.tabs.slice(0, 20), activeUrl: session.activeUrl,
  recentlyClosed: session.recentlyClosed.slice(0, 20)
}, null, 2));

async function availableLoopbackPort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolve(typeof address === "object" && address ? address.port : 8787));
    });
  });
}

async function waitForPublicSearch(endpoint: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${endpoint}/ready`, { signal: AbortSignal.timeout(500) })).ok) return; }
    catch { /* The child process is still initializing. */ }
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error("Timed out waiting for bundled public-search.");
}

async function startBundledPublicSearch() {
  const token = existsSync(publicSearchTokenPath())
    ? readFileSync(publicSearchTokenPath(), "utf8").trim()
    : randomBytes(32).toString("base64url");
  if (!existsSync(publicSearchTokenPath())) writeFileSync(publicSearchTokenPath(), token, { mode: 0o600 });
  const port = await availableLoopbackPort();
  const script = join(__dirname, "public-search", "server.js");
  publicSearchProcess = fork(script, [], {
    execPath: process.execPath,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      PUBLIC_SEARCH_PORT: String(port),
      PUBLIC_SEARCH_DB: join(app.getPath("userData"), "public-search.sqlite"),
      PUBLIC_SEARCH_BACKUP_DIR: join(app.getPath("userData"), "public-search-backups"),
      PUBLIC_SEARCH_ADMIN_TOKEN: token,
      PUBLIC_SEARCH_CORS_ORIGINS: "",
    },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  const endpoint = `http://127.0.0.1:${port}`;
  publicSearchProcess.once("exit", () => { publicSearchProcess = undefined; });
  await waitForPublicSearch(endpoint);
  publicSearchConfig = { endpoint, adminToken: token };
}

function initializeSearchIndex() {
  database = new DatabaseSync(join(app.getPath("userData"), "atlas-search.sqlite"));
  database.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      url TEXT PRIMARY KEY, title TEXT NOT NULL, headings TEXT NOT NULL,
      indexed_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS document_links (
      source_url TEXT NOT NULL, target_url TEXT NOT NULL, title TEXT NOT NULL,
      PRIMARY KEY (source_url, target_url)
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS document_search USING fts5(
      url UNINDEXED, title, headings, text
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS document_ngrams USING fts5(url UNINDEXED, grams);
    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, quote TEXT NOT NULL, body TEXT NOT NULL,
      source_url TEXT NOT NULL, source_title TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS note_tags (
      note_id INTEGER NOT NULL, tag TEXT NOT NULL,
      PRIMARY KEY (note_id, tag)
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS note_search USING fts5(
      note_id UNINDEXED, quote, body, tags
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS note_ngrams USING fts5(note_id UNINDEXED, grams);
  `);

  // Preserve documents collected by earlier JSON-backed Atlas versions.
  const count = (database.prepare("SELECT count(*) AS count FROM documents").get() as { count: number }).count;
  if (count === 0) loadState().documents.forEach(indexDocument);
  const ngramCount = (database.prepare("SELECT count(*) AS count FROM document_ngrams").get() as { count: number }).count;
  if (ngramCount === 0 && documentCount()) {
    const rows = database.prepare("SELECT d.url, d.title, d.headings, s.text FROM documents d JOIN document_search s ON s.url = d.url").all() as Array<{ url: string; title: string; headings: string; text: string }>;
    const insert = database.prepare("INSERT INTO document_ngrams (url, grams) VALUES (?, ?)");
    rows.forEach((row) => insert.run(row.url, koreanNgrams(`${row.title} ${row.headings} ${row.text}`).join(" ")));
  }
}

function indexDocument(document: IndexedDocument) {
  const headings = JSON.stringify(document.headings);
  database.prepare("DELETE FROM document_links WHERE source_url = ?").run(document.url);
  database.prepare("DELETE FROM document_search WHERE url = ?").run(document.url);
  database.prepare("DELETE FROM document_ngrams WHERE url = ?").run(document.url);
  database.prepare("INSERT INTO documents (url, title, headings, indexed_at) VALUES (?, ?, ?, ?) ON CONFLICT(url) DO UPDATE SET title = excluded.title, headings = excluded.headings, indexed_at = excluded.indexed_at").run(document.url, document.title, headings, document.indexedAt);
  database.prepare("INSERT INTO document_search (url, title, headings, text) VALUES (?, ?, ?, ?)").run(document.url, document.title, document.headings.join(" "), document.text);
  database.prepare("INSERT INTO document_ngrams (url, grams) VALUES (?, ?)").run(document.url, koreanNgrams(`${document.title} ${document.headings.join(" ")} ${document.text}`).join(" "));
  const insertLink = database.prepare("INSERT OR IGNORE INTO document_links (source_url, target_url, title) VALUES (?, ?, ?)");
  document.links.slice(0, 40).forEach((link) => insertLink.run(document.url, link.url, link.title));
  return documentCount();
}

const decodeHtml = (value: string) => value.replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, "\"").replace(/&#39;/gi, "'");
const textFromHtml = (value: string) => decodeHtml(value.replace(/<script\b[^>]*>[\s\S]*?<\/script>|<style\b[^>]*>[\s\S]*?<\/style>|<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
const canonicalUrl = (value: string) => { const url = new URL(value); url.hash = ""; return url.toString(); };

function extractCrawlDocument(url: string, html: string): IndexedDocument {
  const title = textFromHtml(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || new URL(url).hostname).slice(0, 300);
  const headings = [...html.matchAll(/<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/gi)].map((match) => textFromHtml(match[2]).slice(0, 300)).filter(Boolean).slice(0, 35);
  const links: LinkItem[] = [];
  for (const match of html.matchAll(/<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    try {
      const target = canonicalUrl(new URL(match[1], url).toString());
      if (/^https?:$/i.test(new URL(target).protocol)) links.push({ url: target, title: textFromHtml(match[2]).slice(0, 90) || target });
    } catch { /* Ignore malformed links. */ }
  }
  return { title, url, headings, links: links.filter((link, index) => links.findIndex((item) => item.url === link.url) === index).slice(0, 40), text: textFromHtml(html).slice(0, 12000), indexedAt: new Date().toISOString() };
}

async function allowedByRobots(url: URL, cache: Map<string, string>, signal: AbortSignal) {
  const origin = url.origin;
  if (!cache.has(origin)) {
    try { cache.set(origin, await readCrawlResponseText(await fetchWithRetry(`${origin}/robots.txt`, { headers: { "User-Agent": "AtlasBrowser/1.0" }, signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) }), MAX_ROBOTS_BYTES)); }
    catch (error) { if (signal.aborted) throw error; cache.set(origin, ""); }
  }
  const rules = cache.get(origin) || "";
  const groups = rules.split(/\n\s*\n/).filter((group) => /user-agent\s*:\s*\*/i.test(group));
  const disallowed = groups.flatMap((group) => [...group.matchAll(/^\s*disallow\s*:\s*(\S+)/gim)].map((match) => match[1])).filter(Boolean);
  return !disallowed.some((path) => url.pathname.startsWith(path));
}

async function assertPublicTarget(value: string) {
  if (!isSafeCrawlerUrl(value)) throw new Error("Blocked non-public URL");
  const url = new URL(value);
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((entry) => !isPublicIpAddress(entry.address))) throw new Error("Blocked private network address");
}

async function fetchWithRetry(url: string, init: RequestInit, attempts = 3) {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      let target = url;
      for (let redirect = 0; redirect < 6; redirect++) {
        await assertPublicTarget(target);
        const response = await fetch(target, { ...init, redirect: "manual" });
        if (response.status < 300 || response.status >= 400) { if (response.status < 500 && response.status !== 429) return response; lastError = new Error(`HTTP ${response.status}`); break; }
        const location = response.headers.get("location");
        if (!location) throw new Error("Redirect without location");
        target = new URL(location, target).toString();
      }
      if (!lastError) lastError = new Error("Too many redirects");
    }
    catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 500 * (2 ** attempt)));
  }
  throw lastError instanceof Error ? lastError : new Error("Request failed");
}

function sitemapLinks(xml: string, sourceUrl: string) {
  const links: string[] = [];
  for (const match of xml.matchAll(/<loc\b[^>]*>([\s\S]*?)<\/loc>/gi)) {
    try { const url = canonicalUrl(new URL(match[1].trim(), sourceUrl).toString()); if (isSafeCrawlerUrl(url) && !links.includes(url)) links.push(url); } catch { /* Ignore invalid locations. */ }
  }
  return links.slice(0, 500);
}

function sendCrawlProgress(sender: Electron.WebContents, progress: CrawlProgress) {
  if (!sender.isDestroyed()) sender.send("crawler:progress", progress);
}

async function crawlSite(request: CrawlRequest, sender: Electron.WebContents, jobId: string): Promise<CrawlResult> {
  let seed: URL;
  try { seed = new URL(request.url); } catch { return { indexed: 0, skipped: 0, failed: 0, message: "유효한 시작 주소를 입력하세요." }; }
  if (!isSafeCrawlerUrl(seed.toString())) return { indexed: 0, skipped: 0, failed: 0, message: "공개 HTTP/HTTPS 주소만 수집할 수 있습니다." };
  const maxPages = clampCrawlLimit(request.maxPages);
  const queue = [canonicalUrl(seed.toString())]; const seen = new Set<string>(); const robots = new Map<string, string>();
  let indexed = 0; let skipped = 0; let failed = 0;
  try {
    const sitemap = await fetchWithRetry(new URL("/sitemap.xml", seed.origin).toString(), { headers: { "User-Agent": "AtlasBrowser/1.0" }, signal: AbortSignal.timeout(10_000) });
    if (sitemap.ok) sitemapLinks(await readCrawlResponseText(sitemap, MAX_SITEMAP_BYTES), seed.origin).filter((url) => request.sameHost === false || new URL(url).host === seed.host).forEach((url) => queue.push(url));
  } catch { /* Sitemap discovery is optional. */ }
  const report = (status: CrawlProgress["status"], currentUrl?: string) => sendCrawlProgress(sender, { jobId, indexed, skipped, failed, queued: queue.length, limit: maxPages, currentUrl, status });
  report("running");
  const job = () => crawlJobs.get(jobId);
  while (queue.length && seen.size < maxPages) {
    if (job()?.cancelled) {
      report("cancelled");
      return { indexed, skipped, failed, message: `수집을 취소했습니다. ${indexed}개 페이지를 색인했습니다.` };
    }
    const next = queue.shift() as string; if (seen.has(next)) continue; seen.add(next);
    report("running", next);
    try {
      const page = new URL(next);
      if (!isSafeCrawlerUrl(page.toString()) || (request.sameHost !== false && page.host !== seed.host)) { skipped++; continue; }
      if (!await allowedByRobots(page, robots, job()?.controller.signal || AbortSignal.abort())) { skipped++; continue; }
      const response = await fetchWithRetry(next, { redirect: "follow", headers: { "User-Agent": "AtlasBrowser/1.0 (+local knowledge index)" }, signal: AbortSignal.any([job()?.controller.signal || AbortSignal.abort(), AbortSignal.timeout(10000)]) });
      if (!response.ok || !response.headers.get("content-type")?.includes("text/html")) { skipped++; continue; }
      const finalUrl = new URL(response.url);
      if (!isSafeCrawlerUrl(finalUrl.toString()) || (request.sameHost !== false && finalUrl.host !== seed.host)) { skipped++; continue; }
      const document = extractCrawlDocument(canonicalUrl(response.url), await readCrawlResponseText(response, MAX_DOCUMENT_BYTES));
      indexDocument(document); indexed++;
      document.links.forEach((link) => { if (!seen.has(link.url) && (!request.sameHost || new URL(link.url).host === seed.host) && queue.length < maxPages * 4) queue.push(link.url); });
      await new Promise<void>((resolve, reject) => { const timeout = setTimeout(resolve, 350); job()?.controller.signal.addEventListener("abort", () => { clearTimeout(timeout); reject(new Error("Crawl cancelled")); }, { once: true }); });
    } catch { if (job()?.cancelled) { report("cancelled"); return { indexed, skipped, failed, message: `수집을 취소했습니다. ${indexed}개 페이지를 색인했습니다.` }; } failed++; }
  }
  report("complete");
  return { indexed, skipped, failed, message: `${indexed}개 페이지를 색인했습니다${skipped ? ` · ${skipped}개 건너뜀` : ""}${failed ? ` · ${failed}개 실패` : ""}.` };
}

const documentCount = () => (database.prepare("SELECT count(*) AS count FROM documents").get() as { count: number }).count;
const getGraphData = (): GraphData => {
  const documents = database.prepare("SELECT title, url, indexed_at AS indexedAt FROM documents ORDER BY indexed_at DESC LIMIT 100").all() as unknown as GraphDocument[];
  const links = database.prepare("SELECT source_url AS sourceUrl, target_url AS url, title FROM document_links").all() as Array<{ sourceUrl: string; url: string; title: string }>;
  return { documents: documents.map((document) => ({ ...document, links: links.filter((link) => link.sourceUrl === document.url).map(({ url, title }) => ({ url, title })) })), notes: getNotes() };
};

function getNotes(): Note[] {
  const notes = database.prepare("SELECT id, quote, body, source_url AS sourceUrl, source_title AS sourceTitle, created_at AS createdAt FROM notes ORDER BY created_at DESC LIMIT 100").all() as unknown as Array<Omit<Note, "tags">>;
  const tags = database.prepare("SELECT note_id AS noteId, tag FROM note_tags ORDER BY tag").all() as Array<{ noteId: number; tag: string }>;
  return notes.map((note) => ({ ...note, tags: tags.filter((tag) => tag.noteId === note.id).map((tag) => tag.tag) }));
}

function saveNote(input: NoteInput): Note {
  const quote = input.quote.trim().slice(0, 3000);
  const body = input.body.trim().slice(0, 5000);
  if (!quote) throw new Error("A selected quote is required.");
  const createdAt = new Date().toISOString();
  database.prepare("INSERT INTO notes (quote, body, source_url, source_title, created_at) VALUES (?, ?, ?, ?, ?)").run(quote, body, input.sourceUrl, input.sourceTitle.slice(0, 300), createdAt);
  const id = (database.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
  const tags = [...new Set(input.tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))].slice(0, 12);
  const insertTag = database.prepare("INSERT OR IGNORE INTO note_tags (note_id, tag) VALUES (?, ?)");
  tags.forEach((tag) => insertTag.run(id, tag));
  database.prepare("INSERT INTO note_search (note_id, quote, body, tags) VALUES (?, ?, ?, ?)").run(id, quote, body, tags.join(" "));
  database.prepare("INSERT INTO note_ngrams (note_id, grams) VALUES (?, ?)").run(id, koreanNgrams(`${quote} ${body} ${tags.join(" ")}`).join(" "));
  return { id, quote, body, tags, sourceUrl: input.sourceUrl, sourceTitle: input.sourceTitle, createdAt };
}

function updateNote(input: NoteUpdate): Note {
  const existing = getNotes().find((note) => note.id === input.id);
  if (!existing) throw new Error("Note not found.");
  const body = input.body.trim().slice(0, 5000);
  const tags = [...new Set(input.tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))].slice(0, 12);
  database.prepare("UPDATE notes SET body = ? WHERE id = ?").run(body, input.id);
  database.prepare("DELETE FROM note_tags WHERE note_id = ?").run(input.id);
  database.prepare("DELETE FROM note_search WHERE note_id = ?").run(input.id);
  database.prepare("DELETE FROM note_ngrams WHERE note_id = ?").run(input.id);
  const insertTag = database.prepare("INSERT OR IGNORE INTO note_tags (note_id, tag) VALUES (?, ?)");
  tags.forEach((tag) => insertTag.run(input.id, tag));
  database.prepare("INSERT INTO note_search (note_id, quote, body, tags) VALUES (?, ?, ?, ?)").run(input.id, existing.quote, body, tags.join(" "));
  database.prepare("INSERT INTO note_ngrams (note_id, grams) VALUES (?, ?)").run(input.id, koreanNgrams(`${existing.quote} ${body} ${tags.join(" ")}`).join(" "));
  return { ...existing, body, tags };
}

function deleteNote(id: number) {
  database.prepare("DELETE FROM note_tags WHERE note_id = ?").run(id);
  database.prepare("DELETE FROM note_search WHERE note_id = ?").run(id);
  database.prepare("DELETE FROM note_ngrams WHERE note_id = ?").run(id);
  database.prepare("DELETE FROM notes WHERE id = ?").run(id);
}

function getBackupData(): BackupData {
  const metadata = database.prepare("SELECT url, title, headings, indexed_at AS indexedAt FROM documents").all() as Array<{ url: string; title: string; headings: string; indexedAt: string }>;
  const textRows = database.prepare("SELECT url, text FROM document_search").all() as Array<{ url: string; text: string }>;
  const links = database.prepare("SELECT source_url AS sourceUrl, target_url AS url, title FROM document_links").all() as Array<{ sourceUrl: string; url: string; title: string }>;
  return { version: 1, createdAt: new Date().toISOString(), state: loadState(), session: loadSession(), notes: getNotes(), documents: metadata.map((document) => ({ title: document.title, url: document.url, headings: JSON.parse(document.headings) as string[], indexedAt: document.indexedAt, text: textRows.find((row) => row.url === document.url)?.text || "", links: links.filter((link) => link.sourceUrl === document.url).map(({ url, title }) => ({ url, title })) })) };
}

function importBackup(data: BackupData) {
  if (!data || data.version !== 1 || !Array.isArray(data.documents) || !Array.isArray(data.notes)) throw new Error("지원하지 않는 백업 파일입니다.");
  data.documents.filter((document): document is IndexedDocument => !!document && typeof document.url === "string" && typeof document.title === "string" && typeof document.text === "string" && Array.isArray(document.headings) && Array.isArray(document.links)).forEach(indexDocument);
  const existingNotes = new Set(getNotes().map((note) => noteImportKey(note.sourceUrl, note.quote, note.body)));
  data.notes.filter((note) => !!note && typeof note.quote === "string" && typeof note.sourceUrl === "string").forEach((note) => { const body = typeof note.body === "string" ? note.body : ""; const key = noteImportKey(note.sourceUrl, note.quote, body); if (!existingNotes.has(key)) { saveNote({ quote: note.quote, body, tags: Array.isArray(note.tags) ? note.tags : [], sourceUrl: note.sourceUrl, sourceTitle: typeof note.sourceTitle === "string" ? note.sourceTitle : note.sourceUrl }); existingNotes.add(key); } });
  if (data.state && Array.isArray(data.state.bookmarks) && Array.isArray(data.state.history)) saveState({ bookmarks: data.state.bookmarks, readingList: Array.isArray(data.state.readingList) ? data.state.readingList : [], savedSearches: Array.isArray(data.state.savedSearches) ? data.state.savedSearches : [], searchHistory: Array.isArray(data.state.searchHistory) ? data.state.searchHistory : [], history: data.state.history, documents: [] });
  if (data.session && Array.isArray(data.session.tabs) && Array.isArray(data.session.recentlyClosed)) saveSession(data.session);
  return { documents: documentCount(), notes: getNotes().length };
}

function searchDocuments(query: string, page = 1, pageSize = 20): { results: SearchResult[]; total: number; page: number; pageSize: number; totalPages: number; error?: string } {
  const safePage = Math.max(1, Math.floor(page) || 1); const safePageSize = Math.min(50, Math.max(1, Math.floor(pageSize) || 20));
  const resultPage = (results: SearchResult[]) => ({ results: results.slice((safePage - 1) * safePageSize, safePage * safePageSize), total: results.length, page: safePage, pageSize: safePageSize, totalPages: Math.max(Math.ceil(results.length / safePageSize), 1) });
  if (!query.trim()) return resultPage([]);
  try {
    const documentResults = database.prepare(`
      SELECT d.title, d.url, d.headings, d.indexed_at AS indexedAt, snippet(document_search, 3, '<b>', '</b>', '...', 18) AS preview
      FROM document_search search JOIN documents d ON d.url = search.url
      WHERE document_search MATCH ?
      ORDER BY bm25(document_search), d.indexed_at DESC LIMIT 50
    `).all(query) as Array<{ title: string; url: string; headings: string; indexedAt: string; preview: string }>;
    const noteResults = database.prepare(`
      SELECT n.id, n.quote, n.body, n.source_url AS url, n.source_title AS title, n.created_at AS indexedAt, snippet(note_search, -1, '<b>', '</b>', '...', 18) AS preview
      FROM note_search search JOIN notes n ON n.id = search.note_id
      WHERE note_search MATCH ? ORDER BY bm25(note_search), n.created_at DESC LIMIT 50
    `).all(query) as Array<{ id: number; quote: string; body: string; title: string; url: string; indexedAt: string; preview: string }>;
    const noteTags = database.prepare("SELECT note_id AS noteId, tag FROM note_tags").all() as Array<{ noteId: number; tag: string }>;
    const directResults: SearchResult[] = [
      ...documentResults.map((item) => ({ kind: "document" as const, ...item, headings: JSON.parse(item.headings) as string[] })),
      ...noteResults.map((item) => ({ kind: "note" as const, ...item, tags: noteTags.filter((tag) => tag.noteId === item.id).map((tag) => tag.tag) }))
    ];
    if (directResults.length || !/[\p{Script=Hangul}]/u.test(query)) return resultPage(directResults);
    const grams = koreanNgrams(query).join(" AND ");
    if (!grams) return resultPage([]);
    const documents = database.prepare("SELECT d.title, d.url, d.headings, d.indexed_at AS indexedAt, snippet(document_search, 3, '<b>', '</b>', '...', 18) AS preview FROM document_ngrams n JOIN documents d ON d.url = n.url JOIN document_search ON document_search.url = d.url WHERE document_ngrams MATCH ? LIMIT 50").all(grams) as Array<{ title: string; url: string; headings: string; indexedAt: string; preview: string }>;
    const notes = database.prepare("SELECT n.id, n.quote, n.body, n.source_url AS url, n.source_title AS title, n.created_at AS indexedAt, snippet(note_search, -1, '<b>', '</b>', '...', 18) AS preview FROM note_ngrams g JOIN notes n ON n.id = g.note_id JOIN note_search ON note_search.note_id = n.id WHERE note_ngrams MATCH ? LIMIT 50").all(grams) as Array<{ id: number; quote: string; body: string; title: string; url: string; indexedAt: string; preview: string }>;
    return resultPage([...documents.map((item) => ({ kind: "document" as const, ...item, headings: JSON.parse(item.headings) as string[] })), ...notes.map((item) => ({ kind: "note" as const, ...item, tags: noteTags.filter((tag) => tag.noteId === item.id).map((tag) => tag.tag) }))]);
  } catch { return { ...resultPage([]), error: "검색식 형식을 확인하세요. AND, OR, NOT, 괄호, 따옴표를 사용할 수 있습니다." }; }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440, height: 920, minWidth: 920, minHeight: 600,
    backgroundColor: "#f4f0e8",
    titleBarStyle: "hidden",
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      webviewTag: true,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true
    }
  });
  win.loadFile(join(__dirname, "..", "src", "renderer", "index.html"));
}

app.whenReady().then(async () => {
  // The app shell is local-only; guest webviews may browse only normal web URLs
  // and must never create an untracked native window.
  app.on("web-contents-created", (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    if (contents.getType() === "webview") {
      contents.on("will-navigate", (event, target) => {
        try {
          if (!/^https?:$/.test(new URL(target).protocol)) event.preventDefault();
        } catch { event.preventDefault(); }
      });
    }
  });
  configureGuestSession();
  initializeSearchIndex();
  try { await startBundledPublicSearch(); }
  catch (error) { console.error("Atlas public-search could not start", error); publicSearchProcess?.kill(); }
  ipcMain.handle("state:load", () => loadState());
  ipcMain.handle("session:load", () => loadSession());
  ipcMain.handle("session:save", (_event, session: TabSession) => saveSession(session));
  ipcMain.handle("bookmark:toggle", (_event, bookmark: Bookmark) => {
    const state = loadState();
    const index = state.bookmarks.findIndex((item) => item.url === bookmark.url);
    if (index >= 0) state.bookmarks.splice(index, 1); else state.bookmarks.unshift(bookmark);
    saveState(state); return state.bookmarks;
  });
  ipcMain.handle("reading-list:toggle", (_event, item: ReadingItem) => {
    const state = loadState();
    const readingList = state.readingList || [];
    const index = readingList.findIndex((entry) => entry.url === item.url);
    if (index >= 0) readingList.splice(index, 1); else readingList.unshift(item);
    state.readingList = readingList.slice(0, 200);
    saveState(state); return state.readingList;
  });
  ipcMain.handle("saved-search:toggle", (_event, item: SavedSearch) => {
    const state = loadState(); const savedSearches = state.savedSearches || [];
    const index = savedSearches.findIndex((entry) => entry.query === item.query);
    if (index >= 0) savedSearches.splice(index, 1); else savedSearches.unshift(item);
    state.savedSearches = savedSearches.slice(0, 100); saveState(state); return state.savedSearches;
  });
  ipcMain.handle("search-history:add", (_event, item: SearchHistoryItem) => {
    const query = item.query.trim().slice(0, 300); if (!query) return loadState().searchHistory || [];
    const state = loadState(); state.searchHistory = [{ query, searchedAt: item.searchedAt }, ...(state.searchHistory || []).filter((entry) => entry.query !== query)].slice(0, 100);
    saveState(state); return state.searchHistory;
  });
  ipcMain.handle("search-history:clear", () => { const state = loadState(); state.searchHistory = []; saveState(state); return state.searchHistory; });
  ipcMain.handle("history:add", (_event, item: HistoryItem) => {
    const state = loadState();
    state.history = [item, ...state.history.filter((entry) => entry.url !== item.url)].slice(0, 250);
    saveState(state); return state.history;
  });
  ipcMain.handle("document:index", (_event, document: IndexedDocument) => {
    return indexDocument(document);
  });
  ipcMain.handle("document:count", () => documentCount());
  ipcMain.handle("document:graph", () => getGraphData());
  ipcMain.handle("document:search", (_event, query: string, page?: number) => searchDocuments(query, page));
  ipcMain.handle("public-search:config", () => publicSearchConfig);
  ipcMain.handle("supabase:config", () => supabaseConfig());
  ipcMain.handle("supabase:merge-state", (_event, remote: Pick<SavedState, "bookmarks" | "readingList" | "savedSearches">) => {
    const state = loadState();
    const mergeBy = <T>(local: T[], incoming: T[], key: (item: T) => string) => [...incoming, ...local].filter((item, index, items) => items.findIndex((candidate) => key(candidate) === key(item)) === index);
    state.bookmarks = mergeBy(state.bookmarks, remote.bookmarks || [], (item) => item.url).slice(0, 250);
    state.readingList = mergeBy(state.readingList || [], remote.readingList || [], (item) => item.url).slice(0, 200);
    state.savedSearches = mergeBy(state.savedSearches || [], remote.savedSearches || [], (item) => item.query).slice(0, 100);
    saveState(state);
    return { bookmarks: state.bookmarks, readingList: state.readingList, savedSearches: state.savedSearches };
  });
  ipcMain.handle("crawler:start", (event, request: CrawlRequest) => {
    const jobId = request.jobId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    crawlJobs.set(jobId, { cancelled: false, controller: new AbortController() });
    return crawlSite(request, event.sender, jobId).finally(() => crawlJobs.delete(jobId));
  });
  ipcMain.handle("crawler:cancel", (_event, jobId: string) => {
    const job = crawlJobs.get(jobId);
    if (job) { job.cancelled = true; job.controller.abort(); }
    return !!job;
  });
  ipcMain.handle("notes:list", () => getNotes());
  ipcMain.handle("notes:save", (_event, note: NoteInput) => saveNote(note));
  ipcMain.handle("notes:update", (_event, note: NoteUpdate) => updateNote(note));
  ipcMain.handle("notes:delete", (_event, id: number) => deleteNote(id));
  ipcMain.handle("backup:export", async () => {
    const target = await dialog.showSaveDialog({ title: "Atlas 데이터 백업", defaultPath: `atlas-backup-${new Date().toISOString().slice(0, 10)}.json`, filters: [{ name: "Atlas backup", extensions: ["json"] }] });
    if (target.canceled || !target.filePath) return { cancelled: true };
    writeFileSync(target.filePath, JSON.stringify(getBackupData(), null, 2));
    return { cancelled: false, path: target.filePath };
  });
  ipcMain.handle("backup:import", async () => {
    const source = await dialog.showOpenDialog({ title: "Atlas 데이터 가져오기", properties: ["openFile"], filters: [{ name: "Atlas backup", extensions: ["json"] }] });
    if (source.canceled || !source.filePaths[0]) return { cancelled: true };
    const result = importBackup(JSON.parse(readFileSync(source.filePaths[0], "utf8")) as BackupData);
    return { cancelled: false, ...result };
  });
  ipcMain.handle("window:minimize", (event) => BrowserWindow.fromWebContents(event.sender)?.minimize());
  ipcMain.handle("window:maximize", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win?.isMaximized()) win.unmaximize(); else win?.maximize();
  });
  ipcMain.handle("window:close", (event) => BrowserWindow.fromWebContents(event.sender)?.close());
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", () => publicSearchProcess?.kill());
