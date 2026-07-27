import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("browserStore", {
  load: () => ipcRenderer.invoke("state:load"),
  toggleBookmark: (bookmark: { title: string; url: string; createdAt: string }) => ipcRenderer.invoke("bookmark:toggle", bookmark),
  addHistory: (item: { title: string; url: string; visitedAt: string }) => ipcRenderer.invoke("history:add", item),
  indexDocument: (document: { title: string; url: string; text: string; headings: string[]; links: Array<{ title: string; url: string }>; indexedAt: string }) => ipcRenderer.invoke("document:index", document)
});
