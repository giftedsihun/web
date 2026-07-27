import { app, BrowserWindow, ipcMain } from "electron";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

type LinkItem = { title: string; url: string };
type IndexedDocument = { title: string; url: string; text: string; headings: string[]; links: LinkItem[]; indexedAt: string };
type SavedState = { bookmarks: Bookmark[]; history: HistoryItem[]; documents: IndexedDocument[] };
type Bookmark = { title: string; url: string; createdAt: string };
type HistoryItem = { title: string; url: string; visitedAt: string };
type GraphDocument = { title: string; url: string; indexedAt: string; links: LinkItem[] };
type Note = { id: number; quote: string; body: string; tags: string[]; sourceUrl: string; sourceTitle: string; createdAt: string };
type NoteInput = Omit<Note, "id" | "createdAt">;
type NoteUpdate = Pick<Note, "id" | "body" | "tags">;
type GraphData = { documents: GraphDocument[]; notes: Note[] };
type SearchResult = { kind: "document"; title: string; url: string; headings: string[]; indexedAt: string } | { kind: "note"; id: number; title: string; url: string; quote: string; body: string; tags: string[]; indexedAt: string };

let database: DatabaseSync;

const statePath = () => join(app.getPath("userData"), "knowledge-browser.json");
const loadState = (): SavedState => {
  try { return JSON.parse(readFileSync(statePath(), "utf8")) as SavedState; }
  catch { return { bookmarks: [], history: [], documents: [] }; }
};
const saveState = (state: SavedState) => writeFileSync(statePath(), JSON.stringify(state, null, 2));

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

function searchDocuments(query: string): { results: SearchResult[]; error?: string } {
  if (!query.trim()) return { results: [] };
  try {
    const documentResults = database.prepare(`
      SELECT d.title, d.url, d.headings, d.indexed_at AS indexedAt
      FROM document_search search JOIN documents d ON d.url = search.url
      WHERE document_search MATCH ?
      ORDER BY bm25(document_search), d.indexed_at DESC LIMIT 50
    `).all(query) as Array<{ title: string; url: string; headings: string; indexedAt: string }>;
    const noteResults = database.prepare(`
      SELECT n.id, n.quote, n.body, n.source_url AS url, n.source_title AS title, n.created_at AS indexedAt
      FROM note_search search JOIN notes n ON n.id = search.note_id
      WHERE note_search MATCH ? ORDER BY bm25(note_search), n.created_at DESC LIMIT 50
    `).all(query) as Array<{ id: number; quote: string; body: string; title: string; url: string; indexedAt: string }>;
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
  ipcMain.handle("notes:list", () => getNotes());
  ipcMain.handle("notes:save", (_event, note: NoteInput) => saveNote(note));
  ipcMain.handle("notes:update", (_event, note: NoteUpdate) => updateNote(note));
  ipcMain.handle("notes:delete", (_event, id: number) => deleteNote(id));
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
