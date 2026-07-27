type LinkItem = { title: string; url: string };
type Bookmark = { title: string; url: string; createdAt: string };
type HistoryItem = { title: string; url: string; visitedAt: string };
type IndexedDocument = { title: string; url: string; text: string; headings: string[]; links: LinkItem[]; indexedAt: string };
type BrowserStore = { load(): Promise<{ bookmarks: Bookmark[]; history: HistoryItem[]; documents?: IndexedDocument[] }>; toggleBookmark(item: Bookmark): Promise<Bookmark[]>; addHistory(item: HistoryItem): Promise<HistoryItem[]>; indexDocument(item: IndexedDocument): Promise<IndexedDocument[]> };
declare global { interface Window { browserStore: BrowserStore } }

type Tab = { id: number; title: string; url: string; view: Electron.WebviewTag; headings?: Array<{ level: string; text: string }>; links?: LinkItem[] };
const tabs: Tab[] = []; let activeId = 0; let nextId = 1; let bookmarks: Bookmark[] = []; let history: HistoryItem[] = []; let documents: IndexedDocument[] = []; let panel = "structure";
const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const tabsEl = byId<HTMLDivElement>("tabs"), views = byId<HTMLDivElement>("views"), address = byId<HTMLInputElement>("address"), empty = byId<HTMLDivElement>("empty"), content = byId<HTMLDivElement>("panel-content");
const current = () => tabs.find((tab) => tab.id === activeId);
const normalizeUrl = (input: string) => { const text = input.trim(); if (/^https?:\/\//i.test(text)) return text; if (/^[\w-]+(\.[\w-]+)+/.test(text)) return `https://${text}`; return `https://www.google.com/search?q=${encodeURIComponent(text)}`; };
const escapeHtml = (value: string) => { const node = document.createElement("div"); node.textContent = value; return node.innerHTML; };

function addTab(url = "", title = "새 탭") {
  const id = nextId++; const view = document.createElement("webview") as Electron.WebviewTag;
  view.partition = "persist:atlas"; view.setAttribute("allowpopups", "true"); view.className = "browser-view"; view.src = url || "about:blank"; views.append(view);
  const tab: Tab = { id, title, url, view }; tabs.push(tab);
  view.addEventListener("did-navigate", () => pageChanged(tab)); view.addEventListener("did-navigate-in-page", () => pageChanged(tab));
  view.addEventListener("page-title-updated", (event) => { tab.title = event.title || tab.url; renderTabs(); });
  view.addEventListener("did-start-loading", () => setStatus("LOADING PAGE")); view.addEventListener("did-stop-loading", () => { setStatus("PAGE READY"); inspectPage(tab); });
  view.addEventListener("new-window", (event) => addTab((event as unknown as { url: string }).url)); activate(id);
}
function pageChanged(tab: Tab) { tab.url = tab.view.getURL(); address.value = tab.url; renderTabs(); updateBookmark(); if (tab.url && !tab.url.startsWith("about:")) window.browserStore.addHistory({ title: tab.title, url: tab.url, visitedAt: new Date().toISOString() }).then((items) => { history = items; if (panel === "history") renderPanel(); }); }
function activate(id: number) { activeId = id; empty.classList.toggle("hidden", tabs.length > 0); views.classList.toggle("visible", tabs.length > 0); tabs.forEach((tab) => tab.view.classList.toggle("active", tab.id === id)); address.value = current()?.url || ""; renderTabs(); updateBookmark(); renderPanel(); }
function closeTab(id: number) { const index = tabs.findIndex((tab) => tab.id === id); if (index < 0) return; tabs[index].view.remove(); tabs.splice(index, 1); if (activeId === id) tabs.length ? activate(tabs[Math.max(0, index - 1)].id) : activate(0); else renderTabs(); }
function renderTabs() { tabsEl.innerHTML = ""; tabs.forEach((tab) => { const item = document.createElement("button"); item.className = `tab ${tab.id === activeId ? "active" : ""}`; item.innerHTML = `<span class="favicon">◆</span><span class="tab-title">${escapeHtml(tab.title || "새 탭")}</span><span class="close">×</span>`; item.onclick = (event) => (event.target as HTMLElement).classList.contains("close") ? closeTab(tab.id) : activate(tab.id); tabsEl.append(item); }); }
function setStatus(value: string) { byId("status").innerHTML = `<i></i> ${value}`; }
function updateBookmark() { const tab = current(); const selected = !!tab && bookmarks.some((item) => item.url === tab.url); byId("bookmark").classList.toggle("bookmarked", selected); byId("bookmark").textContent = selected ? "★" : "☆"; }
async function inspectPage(tab: Tab) {
  if (tab.url.startsWith("about:")) return;
  try {
    const data = await tab.view.executeJavaScript(`(() => ({headings:Array.from(document.querySelectorAll('h1,h2,h3')).slice(0,35).map(n=>({level:n.tagName,text:(n.innerText||'').trim()})).filter(n=>n.text),links:Array.from(document.querySelectorAll('a[href]')).slice(0,40).map(a=>({title:(a.innerText||a.getAttribute('aria-label')||a.href).trim().slice(0,90),url:a.href})).filter(a=>a.title&&a.url.startsWith('http')),text:(document.body?.innerText||'').replace(/\\s+/g,' ').slice(0,12000)}))()`);
    tab.headings = data.headings; tab.links = data.links;
    documents = await window.browserStore.indexDocument({ title: tab.title, url: tab.url, text: data.text, headings: data.headings.map((item: { text: string }) => item.text), links: data.links, indexedAt: new Date().toISOString() });
    byId("page-info").textContent = `${documents.length} DOCUMENTS INDEXED`;
    if (tab.id === activeId && (panel === "structure" || panel === "graph" || panel === "search")) renderPanel();
  } catch { setStatus("PAGE READY · STRUCTURE UNAVAILABLE"); }
}
function matchesBoolean(document: IndexedDocument, query: string) {
  const haystack = `${document.title} ${document.url} ${document.headings.join(" ")} ${document.text}`.toLowerCase(); const groups = query.match(/(?:"[^"]+"|\S+)/g) || [];
  const terms = groups.map((term) => term.replaceAll('"', "").toLowerCase()).filter((term) => !["and", "or", "not"].includes(term)); if (!terms.length) return false;
  let result = haystack.includes(terms[0]); let negate = false; let operator = "AND";
  for (let i = 1; i < groups.length; i += 1) { const token = groups[i].toUpperCase(); if (["AND", "OR"].includes(token)) { operator = token; continue; } if (token === "NOT") { negate = true; continue; } const found = haystack.includes(groups[i].replaceAll('"', "").toLowerCase()); const value = negate ? !found : found; result = operator === "OR" ? result || value : result && value; negate = false; operator = "AND"; } return result;
}
function renderPanel() {
  const tab = current(); document.querySelectorAll(".side-item").forEach((item) => item.classList.toggle("active", (item as HTMLElement).dataset.panel === panel));
  if (panel === "structure") { const headings = tab?.headings || []; content.innerHTML = headings.length ? headings.map((item, index) => `<button class="outline-item" data-index="${index}" data-level="${item.level}">${escapeHtml(item.text)}</button>`).join("") : `<p class="help">페이지를 열면 문서의 제목 구조가 여기에 표시됩니다.</p>`; content.querySelectorAll<HTMLElement>(".outline-item").forEach((item) => item.onclick = () => tab?.view.executeJavaScript(`document.querySelectorAll('h1,h2,h3')[${item.dataset.index}]?.scrollIntoView({behavior:'smooth'})`)); }
  if (panel === "graph") { const links = tab?.links || []; content.innerHTML = links.length ? `<p class="help">현재 문서에서 발견한 링크 ${links.length}개</p>${links.slice(0, 16).map((link) => `<button class="saved" data-url="${encodeURIComponent(link.url)}"><b>↗ ${escapeHtml(link.title)}</b><span>${escapeHtml(link.url)}</span></button>`).join("")}` : `<p class="help">링크를 분석하는 중입니다. 페이지가 로드된 뒤 다시 확인하세요.</p>`; }
  if (panel === "search") { content.innerHTML = `<form id="local-search"><input id="local-query" placeholder="AI AND 논문 NOT 광고" /><button>찾기</button></form><p class="help">방문하며 색인된 문서만 검색합니다.<br>AND · OR · NOT · "구문 검색" 지원</p><div id="search-results"></div>`; byId<HTMLFormElement>("local-search").onsubmit = (event) => { event.preventDefault(); const query = byId<HTMLInputElement>("local-query").value.trim(); const results = documents.filter((document) => matchesBoolean(document, query)); const target = byId("search-results"); const list = results.map((document) => `<button class="saved" data-url="${encodeURIComponent(document.url)}"><b>${escapeHtml(document.title)}</b><span>${escapeHtml(document.url)}</span></button>`).join(""); target.innerHTML = `<p class="help">${results.length}개의 결과</p>${list || '<p class="help">일치하는 색인 문서가 없습니다.</p>'}`; target.querySelectorAll<HTMLElement>(".saved").forEach((item) => item.onclick = () => navigate(decodeURIComponent(item.dataset.url || ""))); }; }
  if (panel === "bookmarks") content.innerHTML = bookmarks.length ? bookmarks.map((item) => `<button class="saved" data-url="${encodeURIComponent(item.url)}"><b>${escapeHtml(item.title)}</b><span>${escapeHtml(item.url)}</span></button>`).join("") : `<p class="help">별표를 눌러 현재 페이지를 저장하세요.</p>`;
  if (panel === "history") content.innerHTML = history.length ? history.slice(0, 20).map((item) => `<button class="saved" data-url="${encodeURIComponent(item.url)}"><b>${escapeHtml(item.title)}</b><span>${escapeHtml(item.url)}</span></button>`).join("") : `<p class="help">아직 탐색한 페이지가 없습니다.</p>`;
  content.querySelectorAll<HTMLElement>(".saved").forEach((item) => item.onclick = () => navigate(decodeURIComponent(item.dataset.url || "")));
}
function navigate(url: string) { const tab = current(); if (!tab) { addTab(normalizeUrl(url)); return; } tab.view.loadURL(normalizeUrl(url)); }
byId<HTMLFormElement>("address-form").addEventListener("submit", (event) => { event.preventDefault(); navigate(address.value); }); byId("new-tab").onclick = () => addTab(); byId("back").onclick = () => current()?.view.goBack(); byId("forward").onclick = () => current()?.view.goForward(); byId("reload").onclick = () => current()?.view.reload();
byId("bookmark").onclick = async () => { const tab = current(); if (!tab?.url || tab.url.startsWith("about:")) return; bookmarks = await window.browserStore.toggleBookmark({ title: tab.title, url: tab.url, createdAt: new Date().toISOString() }); updateBookmark(); if (panel === "bookmarks") renderPanel(); };
document.querySelectorAll<HTMLElement>(".side-item").forEach((item) => item.onclick = () => { panel = item.dataset.panel || "structure"; renderPanel(); }); document.addEventListener("keydown", (event) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "l") { event.preventDefault(); address.focus(); address.select(); } if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "t") { event.preventDefault(); addTab(); } });
window.browserStore.load().then((state) => { bookmarks = state.bookmarks; history = state.history; documents = state.documents || []; byId("page-info").textContent = `${documents.length} DOCUMENTS INDEXED`; renderPanel(); }); renderPanel();
