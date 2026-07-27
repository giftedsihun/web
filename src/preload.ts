import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("browserStore", {
  load: () => ipcRenderer.invoke("state:load"),
  loadSession: () => ipcRenderer.invoke("session:load"),
  saveSession: (session: { tabs: Array<{ title: string; url: string }>; activeUrl: string; recentlyClosed: Array<{ title: string; url: string; closedAt?: string }> }) => ipcRenderer.invoke("session:save", session),
  toggleBookmark: (bookmark: { title: string; url: string; createdAt: string }) => ipcRenderer.invoke("bookmark:toggle", bookmark),
  addHistory: (item: { title: string; url: string; visitedAt: string }) => ipcRenderer.invoke("history:add", item),
  indexDocument: (document: { title: string; url: string; text: string; headings: string[]; links: Array<{ title: string; url: string }>; indexedAt: string }) => ipcRenderer.invoke("document:index", document),
  documentCount: () => ipcRenderer.invoke("document:count"),
  graph: () => ipcRenderer.invoke("document:graph"),
  search: (query: string) => ipcRenderer.invoke("document:search", query),
  crawl: (request: { url: string; maxPages?: number; sameHost?: boolean }) => ipcRenderer.invoke("crawler:start", request),
  notes: () => ipcRenderer.invoke("notes:list"),
  saveNote: (note: { quote: string; body: string; tags: string[]; sourceUrl: string; sourceTitle: string }) => ipcRenderer.invoke("notes:save", note),
  updateNote: (note: { id: number; body: string; tags: string[] }) => ipcRenderer.invoke("notes:update", note),
  deleteNote: (id: number) => ipcRenderer.invoke("notes:delete", id)
});
