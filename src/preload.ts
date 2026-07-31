import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("browserStore", {
  load: () => ipcRenderer.invoke("state:load"),
  loadSession: () => ipcRenderer.invoke("session:load"),
  saveSession: (session: { tabs: Array<{ title: string; url: string }>; activeUrl: string; recentlyClosed: Array<{ title: string; url: string; closedAt?: string }> }) => ipcRenderer.invoke("session:save", session),
  toggleBookmark: (bookmark: { title: string; url: string; createdAt: string }) => ipcRenderer.invoke("bookmark:toggle", bookmark),
  toggleReadingList: (item: { title: string; url: string; savedAt: string }) => ipcRenderer.invoke("reading-list:toggle", item),
  toggleSavedSearch: (item: { query: string; savedAt: string }) => ipcRenderer.invoke("saved-search:toggle", item),
  addSearchHistory: (item: { query: string; searchedAt: string }) => ipcRenderer.invoke("search-history:add", item),
  clearSearchHistory: () => ipcRenderer.invoke("search-history:clear"),
  addHistory: (item: { title: string; url: string; visitedAt: string }) => ipcRenderer.invoke("history:add", item),
  indexDocument: (document: { title: string; url: string; text: string; headings: string[]; links: Array<{ title: string; url: string }>; indexedAt: string }) => ipcRenderer.invoke("document:index", document),
  documentCount: () => ipcRenderer.invoke("document:count"),
  graph: () => ipcRenderer.invoke("document:graph"),
  search: (query: string, page?: number) => ipcRenderer.invoke("document:search", query, page),
  publicSearchConfig: () => ipcRenderer.invoke("public-search:config"),
  supabaseConfig: () => ipcRenderer.invoke("supabase:config"),
  mergeSupabaseState: (state: { bookmarks: Array<{ title: string; url: string; createdAt: string }>; readingList: Array<{ title: string; url: string; savedAt: string }>; savedSearches: Array<{ query: string; savedAt: string }> }) => ipcRenderer.invoke("supabase:merge-state", state),
  crawl: (request: { jobId: string; url: string; maxPages?: number; sameHost?: boolean }) => ipcRenderer.invoke("crawler:start", request),
  cancelCrawl: (jobId: string) => ipcRenderer.invoke("crawler:cancel", jobId),
  onCrawlProgress: (listener: (progress: { jobId: string; indexed: number; skipped: number; failed: number; queued: number; limit: number; currentUrl?: string; status: "running" | "cancelled" | "complete" }) => void) => { const handler = (_event: Electron.IpcRendererEvent, progress: Parameters<typeof listener>[0]) => listener(progress); ipcRenderer.on("crawler:progress", handler); return () => ipcRenderer.removeListener("crawler:progress", handler); },
  notes: () => ipcRenderer.invoke("notes:list"),
  saveNote: (note: { quote: string; body: string; tags: string[]; sourceUrl: string; sourceTitle: string }) => ipcRenderer.invoke("notes:save", note),
  updateNote: (note: { id: number; body: string; tags: string[] }) => ipcRenderer.invoke("notes:update", note),
  deleteNote: (id: number) => ipcRenderer.invoke("notes:delete", id),
  exportBackup: () => ipcRenderer.invoke("backup:export"),
  importBackup: () => ipcRenderer.invoke("backup:import"),
  onDownloadUpdate: (listener: (download: { id: string; name: string; state: "starting" | "progressing" | "complete" | "cancelled" | "interrupted"; received: number; total: number; path?: string }) => void) => { const handler = (_event: Electron.IpcRendererEvent, download: Parameters<typeof listener>[0]) => listener(download); ipcRenderer.on("download:updated", handler); return () => ipcRenderer.removeListener("download:updated", handler); }
});

contextBridge.exposeInMainWorld("windowControls", {
  minimize: () => ipcRenderer.invoke("window:minimize"),
  maximize: () => ipcRenderer.invoke("window:maximize"),
  close: () => ipcRenderer.invoke("window:close")
});
