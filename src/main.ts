import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { clampCrawlLimit, normalizeSession, noteImportKey } from "./core";

type LinkItem = { title: string; url: string };
type IndexedDocument = { title: string; url: string; text: string; headings: string[]; links: LinkItem[]; indexedAt: string };
type SavedState = { bookmarks: Bookmark[]; history: HistoryItem[]; documents: IndexedDocument[] };
type SessionTab = { title: string; url: string; closedAt?: string };
type TabSession = { tabs: SessionTab[]; activeUrl: string; recentlyClosed: SessionTab[] };
type Bookmark = { title: string; url: string; createdAt: string };
type HistoryItem = { title: string; url: string; visitedAt: string };
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

const statePath = () => join(app.getPath("userData"), "knowledge-browser.json");
const loadState = (): SavedState => {
  try { return JSON.parse(readFileSync(statePath(), "utf8")) as SavedState; }
  catch { return { bookmarks: [], history: [], documents: [] }; }
};
const saveState = (state: SavedState) => writeFileSync(statePath(), JSON.stringify(state, null, 2));
const sessionPath = () => join(app.getPath("userData"), "atlas-tabs.json");
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
  `);

  // Preserve documents collected by earlier JSON-backed Atlas versions.
  const count = (database.prepare("SELECT count(*) AS count FROM documents").get() as { count: number }).count;
  if (count === 0) loadState().documents.forEach(indexDocument);
}

function indexDocument(document: IndexedDocument) {
  const headings = JSON.stringify(document.headings);
  database.prepare("DELETE FROM document_links WHERE source_url = ?").run(document.url);
  database.prepare("DELETE FROM document_search WHERE url = ?").run(document.url);
  database.prepare("INSERT INTO documents (url, title, headings, indexed_at) VALUES (?, ?, ?, ?) ON CONFLICT(url) DO UPDATE SET title = excluded.title, headings = excluded.headings, indexed_at = excluded.indexed_at").run(document.url, document.title, headings, document.indexedAt);
  database.prepare("INSERT INTO document_search (url, title, headings, text) VALUES (?, ?, ?, ?)").run(document.url, document.title, document.headings.join(" "), document.text);
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
    try { cache.set(origin, await (await fetch(`${origin}/robots.txt`, { headers: { "User-Agent": "AtlasBrowser/1.0" }, signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) })).text()); }
    catch (error) { if (signal.aborted) throw error; cache.set(origin, ""); }
  }
  const rules = cache.get(origin) || "";
  const groups = rules.split(/\n\s*\n/).filter((group) => /user-agent\s*:\s*\*/i.test(group));
  const disallowed = groups.flatMap((group) => [...group.matchAll(/^\s*disallow\s*:\s*(\S+)/gim)].map((match) => match[1])).filter(Boolean);
  return !disallowed.some((path) => url.pathname.startsWith(path));
}

function sendCrawlProgress(sender: Electron.WebContents, progress: CrawlProgress) {
  if (!sender.isDestroyed()) sender.send("crawler:progress", progress);
}

async function crawlSite(request: CrawlRequest, sender: Electron.WebContents, jobId: string): Promise<CrawlResult> {
  let seed: URL;
  try { seed = new URL(request.url); } catch { return { indexed: 0, skipped: 0, failed: 0, message: "유효한 시작 주소를 입력하세요." }; }
  if (!/^https?:$/.test(seed.protocol)) return { indexed: 0, skipped: 0, failed: 0, message: "HTTP 또는 HTTPS 주소만 크롤링할 수 있습니다." };
  const maxPages = clampCrawlLimit(request.maxPages);
  const queue = [canonicalUrl(seed.toString())]; const seen = new Set<string>(); const robots = new Map<string, string>();
  let indexed = 0; let skipped = 0; let failed = 0;
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
      if (request.sameHost !== false && page.host !== seed.host) { skipped++; continue; }
      if (!await allowedByRobots(page, robots, job()?.controller.signal || AbortSignal.abort())) { skipped++; continue; }
      const response = await fetch(next, { redirect: "follow", headers: { "User-Agent": "AtlasBrowser/1.0 (+local knowledge index)" }, signal: AbortSignal.any([job()?.controller.signal || AbortSignal.abort(), AbortSignal.timeout(10000)]) });
      if (!response.ok || !response.headers.get("content-type")?.includes("text/html")) { skipped++; continue; }
      const finalUrl = new URL(response.url);
      if (request.sameHost !== false && finalUrl.host !== seed.host) { skipped++; continue; }
      const document = extractCrawlDocument(canonicalUrl(response.url), await response.text());
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
  const insertTag = database.prepare("INSERT OR IGNORE INTO note_tags (note_id, tag) VALUES (?, ?)");
  tags.forEach((tag) => insertTag.run(input.id, tag));
  database.prepare("INSERT INTO note_search (note_id, quote, body, tags) VALUES (?, ?, ?, ?)").run(input.id, existing.quote, body, tags.join(" "));
  return { ...existing, body, tags };
}

function deleteNote(id: number) {
  database.prepare("DELETE FROM note_tags WHERE note_id = ?").run(id);
  database.prepare("DELETE FROM note_search WHERE note_id = ?").run(id);
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
  if (data.state && Array.isArray(data.state.bookmarks) && Array.isArray(data.state.history)) saveState({ bookmarks: data.state.bookmarks, history: data.state.history, documents: [] });
  if (data.session && Array.isArray(data.session.tabs) && Array.isArray(data.session.recentlyClosed)) saveSession(data.session);
  return { documents: documentCount(), notes: getNotes().length };
}

function searchDocuments(query: string): { results: SearchResult[]; error?: string } {
  if (!query.trim()) return { results: [] };
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
    return { results: [
      ...documentResults.map((item) => ({ kind: "document" as const, ...item, headings: JSON.parse(item.headings) as string[] })),
      ...noteResults.map((item) => ({ kind: "note" as const, ...item, tags: noteTags.filter((tag) => tag.noteId === item.id).map((tag) => tag.tag) }))
    ] };
  } catch { return { results: [], error: "검색식 형식을 확인하세요. AND, OR, NOT, 괄호, 따옴표를 사용할 수 있습니다." }; }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440, height: 920, minWidth: 920, minHeight: 600,
    backgroundColor: "#f4f0e8",
    titleBarStyle: "hidden",
    webPreferences: { preload: join(__dirname, "preload.js"), webviewTag: true, contextIsolation: true, sandbox: false }
  });
  win.loadFile(join(__dirname, "..", "src", "renderer", "index.html"));
}

app.whenReady().then(() => {
  initializeSearchIndex();
  ipcMain.handle("state:load", () => loadState());
  ipcMain.handle("session:load", () => loadSession());
  ipcMain.handle("session:save", (_event, session: TabSession) => saveSession(session));
  ipcMain.handle("bookmark:toggle", (_event, bookmark: Bookmark) => {
    const state = loadState();
    const index = state.bookmarks.findIndex((item) => item.url === bookmark.url);
    if (index >= 0) state.bookmarks.splice(index, 1); else state.bookmarks.unshift(bookmark);
    saveState(state); return state.bookmarks;
  });
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
  ipcMain.handle("document:search", (_event, query: string) => searchDocuments(query));
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
