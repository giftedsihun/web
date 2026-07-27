import { app, BrowserWindow, ipcMain } from "electron";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type LinkItem = { title: string; url: string };
type IndexedDocument = { title: string; url: string; text: string; headings: string[]; links: LinkItem[]; indexedAt: string };
type SavedState = { bookmarks: Bookmark[]; history: HistoryItem[]; documents: IndexedDocument[] };
type Bookmark = { title: string; url: string; createdAt: string };
type HistoryItem = { title: string; url: string; visitedAt: string };

const statePath = () => join(app.getPath("userData"), "knowledge-browser.json");
const loadState = (): SavedState => {
  try { return JSON.parse(readFileSync(statePath(), "utf8")) as SavedState; }
  catch { return { bookmarks: [], history: [], documents: [] }; }
};
const saveState = (state: SavedState) => writeFileSync(statePath(), JSON.stringify(state, null, 2));

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
    const state = loadState();
    state.documents = [document, ...state.documents.filter((item) => item.url !== document.url)].slice(0, 500);
    saveState(state); return state.documents;
  });
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
