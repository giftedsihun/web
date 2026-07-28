type LinkItem = { title: string; url: string };
type Bookmark = { title: string; url: string; createdAt: string };
type HistoryItem = { title: string; url: string; visitedAt: string };
type IndexedDocument = { title: string; url: string; text: string; headings: string[]; links: LinkItem[]; indexedAt: string };
type GraphDocument = { title: string; url: string; indexedAt: string; links: LinkItem[] };
type Note = { id: number; quote: string; body: string; tags: string[]; sourceUrl: string; sourceTitle: string; createdAt: string };
type GraphData = { documents: GraphDocument[]; notes: Note[] };
type SearchResult = { kind: "document"; title: string; url: string; headings: string[]; preview: string; indexedAt: string } | { kind: "note"; id: number; title: string; url: string; quote: string; body: string; tags: string[]; preview: string; indexedAt: string };
type SessionTab = { title: string; url: string; closedAt?: string };
type TabSession = { tabs: SessionTab[]; activeUrl: string; recentlyClosed: SessionTab[] };
type CrawlResult = { indexed: number; skipped: number; failed: number; message: string };
type CrawlProgress = { jobId: string; indexed: number; skipped: number; failed: number; queued: number; limit: number; currentUrl?: string; status: "running" | "cancelled" | "complete" };
type PublicSearchResult = { title: string; url: string; preview: string; indexedAt: string; score: number };
type PublicSearchResponse = { query: string; page: number; pageSize: number; total: number; totalPages: number; results: PublicSearchResult[]; source: string };
type PublicCrawlJob = { id: string; seedUrl: string; maxPages: number; allowedHosts: string[]; recrawlMinutes?: number; nextRecrawlAt?: number; status: "queued" | "running" | "complete" | "cancelled" | "failed"; indexed: number; skipped: number; failed: number; createdAt: string; updatedAt: string; error?: string };
type BrowserStore = { load(): Promise<{ bookmarks: Bookmark[]; history: HistoryItem[] }>; loadSession(): Promise<TabSession>; saveSession(session: TabSession): Promise<void>; toggleBookmark(item: Bookmark): Promise<Bookmark[]>; addHistory(item: HistoryItem): Promise<HistoryItem[]>; indexDocument(item: IndexedDocument): Promise<number>; documentCount(): Promise<number>; graph(): Promise<GraphData>; search(query: string): Promise<{ results: SearchResult[]; error?: string }>; crawl(request: { jobId?: string; url: string; maxPages?: number; sameHost?: boolean }): Promise<CrawlResult>; cancelCrawl(jobId: string): Promise<boolean>; onCrawlProgress(listener: (progress: CrawlProgress) => void): () => void; notes(): Promise<Note[]>; saveNote(note: Omit<Note, "id" | "createdAt">): Promise<Note>; updateNote(note: Pick<Note, "id" | "body" | "tags">): Promise<Note>; deleteNote(id: number): Promise<void>; exportBackup(): Promise<{ cancelled: boolean; path?: string }>; importBackup(): Promise<{ cancelled: boolean; documents?: number; notes?: number }> };
type WindowControls = { minimize(): Promise<void>; maximize(): Promise<void>; close(): Promise<void> };
interface Window { browserStore: BrowserStore; windowControls: WindowControls }

type Webview = HTMLElement & { partition: string; src: string; loadURL(url: string): void; getURL(): string; goBack(): void; goForward(): void; reload(): void; findInPage(text: string): void; executeJavaScript(script: string): Promise<any> };
type Tab = { id: number; title: string; url: string; view: Webview; headings?: Array<{ level: string; text: string }>; links?: LinkItem[]; pendingQuote?: string };
const tabs: Tab[] = []; let activeId = 0; let nextId = 1; let bookmarks: Bookmark[] = []; let visitHistory: HistoryItem[] = []; let panel = "structure"; let editingNote: Note | undefined; let activeTag = ""; let recentlyClosed: SessionTab[] = []; let sessionTimer: number | undefined; let activeCrawlId = ""; let removeCrawlListener: (() => void) | undefined; let publicSearchEndpoint = localStorage.getItem("atlas-public-search-endpoint") || "http://localhost:8787"; let publicSearchAdminToken = localStorage.getItem("atlas-public-search-admin-token") || ""; let activeSearchQuery = "";
const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const tabsEl = byId<HTMLDivElement>("tabs"), views = byId<HTMLDivElement>("views"), address = byId<HTMLInputElement>("address"), empty = byId<HTMLDivElement>("empty"), searchView = byId<HTMLElement>("search-view"), content = byId<HTMLDivElement>("panel-content");
const noteDialog = byId<HTMLDialogElement>("note-dialog"), noteQuote = byId<HTMLElement>("note-quote"), noteBody = byId<HTMLTextAreaElement>("note-body"), noteTags = byId<HTMLInputElement>("note-tags");
const current = () => tabs.find((tab) => tab.id === activeId);
const isWebAddress = (input: string) => /^https?:\/\//i.test(input.trim()) || /^[\w-]+(\.[\w-]+)+(?:[/:?#]|$)/.test(input.trim());
const normalizeUrl = (input: string) => /^https?:\/\//i.test(input.trim()) ? input.trim() : `https://${input.trim()}`;
const escapeHtml = (value: string) => { const node = document.createElement("div"); node.textContent = value; return node.innerHTML; };
async function searchPublicIndex(query: string, page = 1): Promise<PublicSearchResponse | undefined> {
  try {
    const response = await fetch(`${publicSearchEndpoint}/v1/search?q=${encodeURIComponent(query)}&page=${page}`, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return undefined;
    return await response.json() as PublicSearchResponse;
  } catch { return undefined; }
}
async function publicCrawlerRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${publicSearchAdminToken}`);
  if (init.body) headers.set("Content-Type", "application/json");
  const response = await fetch(`${publicSearchEndpoint}${path}`, { ...init, headers, signal: AbortSignal.timeout(8_000) });
  const result = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(result.error || "Public crawler request failed");
  return result;
}
async function showMainSearch(query: string, publicPage = 1) {
  const value = query.trim();
  if (!value) return;
  activeSearchQuery = value;
  updateMainView(true);
  searchView.innerHTML = `<div class="search-page"><header class="search-page-head"><p class="eyebrow">ATLAS SEARCH</p><form id="main-search-form"><input id="main-search-query" value="${escapeHtml(value)}" autocomplete="off" spellcheck="false" /><button>검색</button></form><p id="main-search-status" class="search-page-status">내 Atlas와 공개 Atlas를 검색하는 중입니다...</p></header><div class="search-page-groups"><section class="main-result-group public-results"><h2>공개 Atlas <small>공개 인덱스</small></h2><div id="main-public-results"><p class="help">검색 중입니다...</p></div></section><section class="main-result-group atlas-results"><h2>내 Atlas <small>개인 전문 색인</small></h2><div id="main-local-results"><p class="help">검색 중입니다...</p></div></section></div></div>`;
  const publicTarget = byId("main-public-results");
  const localTarget = byId("main-local-results");
  const status = byId("main-search-status");
  const preview = (text: string) => escapeHtml(text).replace(/&lt;b&gt;/g, "<mark>").replace(/&lt;\/b&gt;/g, "</mark>");
  const [local, remote] = await Promise.all([window.browserStore.search(value), searchPublicIndex(value, publicPage)]);
  if (activeSearchQuery !== value) return;
  localTarget.innerHTML = local.error ? `<p class="help">${escapeHtml(local.error)}</p>` : local.results.length ? local.results.map((item) => `<button class="main-search-card" data-url="${encodeURIComponent(item.url)}" data-quote="${encodeURIComponent(item.kind === "note" ? item.quote : "")}"><b>${item.kind === "note" ? "NOTE" : "DOC"} · ${escapeHtml(item.title)}</b><span>${escapeHtml(item.url)}</span><q>${preview(item.preview)}</q><small>${new Date(item.indexedAt).toLocaleDateString("ko-KR")}</small></button>`).join("") : `<p class="help">내 Atlas에 일치하는 문서나 노트가 없습니다.</p>`;
  const publicResults = remote?.results || [];
  const pagination = remote && remote.totalPages > 1 ? `<nav class="search-pagination" aria-label="공개 검색 결과 페이지"><button type="button" data-public-page="${remote.page - 1}" ${remote.page <= 1 ? "disabled" : ""}>이전</button><span>${remote.page} / ${remote.totalPages}</span><button type="button" data-public-page="${remote.page + 1}" ${remote.page >= remote.totalPages ? "disabled" : ""}>다음</button></nav>` : "";
  publicTarget.innerHTML = publicResults.length ? `${publicResults.map((item) => `<button class="main-search-card public-card" data-url="${encodeURIComponent(item.url)}"><b>WEB · ${escapeHtml(item.title)}</b><span>${escapeHtml(item.url)}</span><q>${preview(item.preview)}</q><small>${new Date(item.indexedAt).toLocaleDateString("ko-KR")}</small></button>`).join("")}${pagination}` : `<p class="help">${remote ? "공개 Atlas에 일치 문서가 없습니다." : `공개 Atlas 서버(${escapeHtml(publicSearchEndpoint)})에 연결하지 못했습니다.`}</p>`;
  status.textContent = `내 Atlas ${local.results.length}개 · 공개 Atlas ${remote?.total || 0}개`;
  setStatus(`${local.results.length} LOCAL · ${publicResults.length} PUBLIC RESULTS`);
  byId<HTMLFormElement>("main-search-form").onsubmit = (event) => { event.preventDefault(); showMainSearch(byId<HTMLInputElement>("main-search-query").value); };
  searchView.querySelectorAll<HTMLElement>(".main-search-card").forEach((item) => item.onclick = () => { const quote = decodeURIComponent(item.dataset.quote || ""); navigate(decodeURIComponent(item.dataset.url || "")); if (quote && current()) current()!.pendingQuote = quote; });
  searchView.querySelectorAll<HTMLButtonElement>("[data-public-page]").forEach((button) => button.onclick = () => showMainSearch(value, Number(button.dataset.publicPage)));
}

function queueSessionSave() { window.clearTimeout(sessionTimer); sessionTimer = window.setTimeout(() => { const active = current(); window.browserStore.saveSession({ tabs: tabs.map(({ title, url }) => ({ title, url })), activeUrl: active?.url || "", recentlyClosed }); }, 300); }
function clearMainSearch() { activeSearchQuery = ""; searchView.classList.remove("visible"); searchView.innerHTML = ""; }
function updateMainView(isNewTab: boolean) { const showingSearch = !!activeSearchQuery; empty.classList.toggle("hidden", !isNewTab || showingSearch); views.classList.toggle("visible", !isNewTab && !showingSearch); searchView.classList.toggle("visible", showingSearch); }
function addTab(url = "", title = "새 탭", shouldPersist = true) {
  const id = nextId++; const view = document.createElement("webview") as Webview;
  view.partition = "persist:atlas"; view.setAttribute("allowpopups", "true"); view.className = "browser-view"; view.src = url || "about:blank"; views.append(view);
  const tab: Tab = { id, title, url, view }; tabs.push(tab);
  view.addEventListener("did-navigate", () => pageChanged(tab)); view.addEventListener("did-navigate-in-page", () => pageChanged(tab));
  view.addEventListener("page-title-updated", (event) => { tab.title = (event as Event & { title?: string }).title || tab.url; renderTabs(); queueSessionSave(); });
  view.addEventListener("did-start-loading", () => setStatus("LOADING PAGE")); view.addEventListener("did-stop-loading", () => { setStatus("PAGE READY"); if (tab.pendingQuote) { tab.view.findInPage(tab.pendingQuote); tab.pendingQuote = undefined; } inspectPage(tab); });
  view.addEventListener("new-window", (event) => addTab((event as unknown as { url: string }).url)); activate(id); if (shouldPersist) queueSessionSave();
}
function pageChanged(tab: Tab) { tab.url = tab.view.getURL(); if (tab.id === activeId) { clearMainSearch(); updateMainView(!tab.url || tab.url.startsWith("about:")); } address.value = tab.url; renderTabs(); updateBookmark(); queueSessionSave(); if (tab.url && !tab.url.startsWith("about:")) window.browserStore.addHistory({ title: tab.title, url: tab.url, visitedAt: new Date().toISOString() }).then((items) => { visitHistory = items; if (panel === "history") renderPanel(); }); }
function activate(id: number) { activeId = id; const tab = current(); const isNewTab = !tab?.url || tab.url.startsWith("about:"); clearMainSearch(); updateMainView(isNewTab); tabs.forEach((item) => item.view.classList.toggle("active", item.id === id)); address.value = tab?.url || ""; renderTabs(); updateBookmark(); renderPanel(); if (isNewTab) window.setTimeout(() => byId<HTMLInputElement>("home-query").focus(), 0); queueSessionSave(); }
function closeTab(id: number) { const index = tabs.findIndex((tab) => tab.id === id); if (index < 0) return; const [closed] = tabs.splice(index, 1); closed.view.remove(); if (closed.url && !closed.url.startsWith("about:")) recentlyClosed = [{ title: closed.title, url: closed.url, closedAt: new Date().toISOString() }, ...recentlyClosed.filter((item) => item.url !== closed.url)].slice(0, 20); if (activeId === id) tabs.length ? activate(tabs[Math.max(0, index - 1)].id) : activate(0); else renderTabs(); queueSessionSave(); }
function renderTabs() { tabsEl.innerHTML = ""; tabs.forEach((tab) => { const item = document.createElement("button"); item.className = `tab ${tab.id === activeId ? "active" : ""}`; item.innerHTML = `<span class="favicon">◆</span><span class="tab-title">${escapeHtml(tab.title || "새 탭")}</span><span class="close">×</span>`; item.onclick = (event) => (event.target as HTMLElement).classList.contains("close") ? closeTab(tab.id) : activate(tab.id); tabsEl.append(item); }); const restore = byId<HTMLButtonElement>("restore-tab"); restore.disabled = recentlyClosed.length === 0; restore.title = recentlyClosed.length ? `최근 닫은 탭: ${recentlyClosed[0].title}` : "복원할 최근 탭이 없습니다"; }
function setStatus(value: string) { byId("status").innerHTML = `<i></i> ${value}`; }
function updateBookmark() { const tab = current(); const selected = !!tab && bookmarks.some((item) => item.url === tab.url); byId("bookmark").classList.toggle("bookmarked", selected); byId("bookmark").textContent = selected ? "★" : "☆"; const crawler = byId<HTMLButtonElement>("crawl-current"); crawler.disabled = !tab?.url || !/^https?:/i.test(tab.url); }
async function inspectPage(tab: Tab) {
  if (tab.url.startsWith("about:")) return;
  try {
    const data = await tab.view.executeJavaScript(`(() => ({headings:Array.from(document.querySelectorAll('h1,h2,h3')).slice(0,35).map(n=>({level:n.tagName,text:(n.innerText||'').trim()})).filter(n=>n.text),links:Array.from(document.querySelectorAll('a[href]')).slice(0,40).map(a=>({title:(a.innerText||a.getAttribute('aria-label')||a.href).trim().slice(0,90),url:a.href})).filter(a=>a.title&&a.url.startsWith('http')),text:(document.body?.innerText||'').replace(/\\s+/g,' ').slice(0,12000)}))()`);
    tab.headings = data.headings; tab.links = data.links;
    const count = await window.browserStore.indexDocument({ title: tab.title, url: tab.url, text: data.text, headings: data.headings.map((item: { text: string }) => item.text), links: data.links, indexedAt: new Date().toISOString() });
    byId("page-info").textContent = `${count} DOCUMENTS INDEXED`;
    if (tab.id === activeId && (panel === "structure" || panel === "graph" || panel === "search")) renderPanel();
  } catch { setStatus("PAGE READY · STRUCTURE UNAVAILABLE"); }
}
function graphLabel(value: string) { return value.replace(/^https?:\/\//, "").replace(/^www\./, "").slice(0, 22); }
function openNoteDialog(note?: Note) { editingNote = note; byId("note-mode").textContent = note ? "REFINE A THOUGHT" : "CAPTURE A THOUGHT"; noteQuote.textContent = note?.quote || ""; noteBody.value = note?.body || ""; noteTags.value = note?.tags.join(", ") || ""; byId("delete-note").classList.toggle("visible", !!note); noteDialog.showModal(); }
function renderGraph(data: GraphData, activeUrl?: string) {
  const { documents, notes } = data;
  const nodes = new Map<string, { title: string; url: string; kind: string }>();
  documents.forEach((document) => nodes.set(document.url, { title: document.title, url: document.url, kind: document.url === activeUrl ? "current" : "source" }));
  const edges = documents.flatMap((document) => document.links.filter((link) => nodes.has(link.url) || document.url === activeUrl).slice(0, 12).map((link) => {
    if (!nodes.has(link.url)) nodes.set(link.url, { title: link.title, url: link.url, kind: "target" });
    return { source: document.url, target: link.url };
  })).slice(0, 45);
  const values = [...nodes.values()].slice(0, 22); const noteNodes = notes.slice(0, 10).map((note) => ({ title: note.quote, url: `note:${note.id}`, kind: "note", sourceUrl: note.sourceUrl }));
  const allNodes = [...values, ...noteNodes]; const positions = new Map(allNodes.map((node, index) => {
    const angle = (Math.PI * 2 * index) / Math.max(values.length, 1) - Math.PI / 2;
    const radius = index === 0 ? 0 : 70 + (index % 3) * 17;
    return [node.url, { x: 130 + Math.cos(angle) * radius, y: 115 + Math.sin(angle) * radius }];
  }));
  const position = (url: string) => positions.get(url) || { x: 130, y: 115 };
  const noteEdges = noteNodes.filter((note) => positions.has(note.sourceUrl)).map((note) => ({ source: note.sourceUrl, target: note.url }));
  const edgeMarkup = [...edges, ...noteEdges].filter((edge) => positions.has(edge.source) && positions.has(edge.target)).map((edge) => `<line class="graph-edge" x1="${position(edge.source).x}" y1="${position(edge.source).y}" x2="${position(edge.target).x}" y2="${position(edge.target).y}" />`).join("");
  const nodeMarkup = allNodes.map((node) => { const point = position(node.url); const noteId = node.url.startsWith("note:") ? node.url.slice(5) : ""; const shape = node.kind === "note" ? `<rect class="graph-node note" x="${point.x - 5}" y="${point.y - 5}" width="10" height="10" />` : `<circle class="graph-node ${node.kind}" cx="${point.x}" cy="${point.y}" r="${node.kind === "current" ? 8 : 6}" />`; return `<g data-url="${encodeURIComponent(node.url)}" data-note-id="${noteId}">${shape}<text class="graph-label" x="${point.x + 9}" y="${point.y + 3}">${escapeHtml(graphLabel(node.title || node.url))}</text></g>`; }).join("");
  return `<svg class="graph-canvas" viewBox="0 0 260 230" role="img" aria-label="문서 링크 그래프">${edgeMarkup}${nodeMarkup}</svg>`;
}
function renderPanel() {
  const tab = current(); content.classList.toggle("search-mode", panel === "search"); content.classList.toggle("crawler-mode", panel === "crawler"); document.querySelectorAll(".side-item").forEach((item) => item.classList.toggle("active", (item as HTMLElement).dataset.panel === panel));
  if (panel === "structure") { const headings = tab?.headings || []; content.innerHTML = headings.length ? headings.map((item, index) => `<button class="outline-item" data-index="${index}" data-level="${item.level}">${escapeHtml(item.text)}</button>`).join("") : `<p class="help">페이지를 열면 문서의 제목 구조가 여기에 표시됩니다.</p>`; content.querySelectorAll<HTMLElement>(".outline-item").forEach((item) => item.onclick = () => tab?.view.executeJavaScript(`document.querySelectorAll('h1,h2,h3')[${item.dataset.index}]?.scrollIntoView({behavior:'smooth'})`)); }
  if (panel === "graph") { content.innerHTML = `<p class="help graph-help">원형은 문서, 사각형은 원문에 연결된 노트입니다.</p><div id="graph-view"><p class="help">링크 관계를 불러오는 중입니다.</p></div>`; window.browserStore.graph().then((data) => { if (panel !== "graph") return; const graph = byId("graph-view"); graph.innerHTML = data.documents.length ? renderGraph(data, tab?.url) : `<p class="help">문서를 방문하면 지식 그래프가 표시됩니다.</p>`; graph.querySelectorAll<HTMLElement>("g[data-url]").forEach((item) => item.onclick = () => { const noteId = item.dataset.noteId; if (noteId) { panel = "notes"; renderPanel(); return; } navigate(decodeURIComponent(item.dataset.url || "")); }); }); }
  if (panel === "crawler") {
    content.innerHTML = `<form id="crawler-form" class="crawler-form"><div><b>내 Atlas에 사이트 수집</b><small>robots.txt를 준수하고 현재 도메인 안에서만 최대 50페이지를 천천히 읽습니다.</small></div><input id="crawl-url" type="url" placeholder="https://example.com" value="${escapeHtml(tab?.url.startsWith("http") ? tab.url : "")}" /><label>페이지 <input id="crawl-limit" type="number" min="1" max="50" value="10" /></label><button id="crawl-start">수집</button><button id="crawl-cancel" type="button" disabled>취소</button><progress id="crawl-progress" value="0" max="10"></progress><p id="crawl-status" class="help"></p></form><section class="public-crawler"><div class="public-crawler-head"><b>공개 Atlas 수집기</b><button id="refresh-public-crawls" type="button">새로고침</button></div><p class="help">공개 서버의 관리자 토큰이 필요합니다. 승인한 호스트만 수집됩니다.</p><form id="public-crawler-form"><input id="public-crawl-seed" type="url" placeholder="https://example.com" value="${escapeHtml(tab?.url.startsWith("http") ? tab.url : "")}" /><input id="public-crawl-hosts" placeholder="추가 승인 호스트, 쉼표로 구분" /><div class="public-crawl-options"><label>페이지 <input id="public-crawl-limit" type="number" min="1" max="10000" value="100" /></label><label>재수집(분) <input id="public-crawl-recrawl" type="number" min="15" max="43200" placeholder="선택" /></label></div><input id="public-crawl-token" type="password" placeholder="공개 Atlas 관리자 토큰" value="${escapeHtml(publicSearchAdminToken)}" /><button>공개 수집 시작</button></form><p id="public-crawl-status" class="help"></p><div id="public-crawl-list"><p class="help">공개 수집 작업을 불러오려면 새로고침을 누르세요.</p></div></section>`;
    const start = byId<HTMLButtonElement>("crawl-start");
    const cancel = byId<HTMLButtonElement>("crawl-cancel");
    const status = byId("crawl-status");
    const progress = byId<HTMLProgressElement>("crawl-progress");
    const cleanup = () => { start.disabled = false; cancel.disabled = true; activeCrawlId = ""; removeCrawlListener?.(); removeCrawlListener = undefined; };
    byId<HTMLFormElement>("crawler-form").onsubmit = async (event) => {
      event.preventDefault();
      activeCrawlId = `crawl-${Date.now()}`;
      const jobId = activeCrawlId;
      const limit = Number(byId<HTMLInputElement>("crawl-limit").value) || 10;
      start.disabled = true; cancel.disabled = false; progress.max = limit; progress.value = 0;
      status.textContent = "웹을 수집하고 색인하는 중입니다...";
      removeCrawlListener?.();
      removeCrawlListener = window.browserStore.onCrawlProgress((update) => {
        if (update.jobId !== jobId || panel !== "crawler") return;
        progress.max = update.limit;
        progress.value = update.indexed + update.skipped + update.failed;
        status.textContent = `${update.indexed}/${update.limit} 색인 · ${update.skipped} 건너뜀 · ${update.failed} 실패`;
      });
      try {
        const result = await window.browserStore.crawl({ jobId, url: byId<HTMLInputElement>("crawl-url").value, maxPages: limit, sameHost: true });
        status.textContent = result.message;
        byId("page-info").textContent = `${await window.browserStore.documentCount()} DOCUMENTS INDEXED`;
        setStatus(result.message.includes("취소") ? "CRAWL CANCELLED" : "CRAWL COMPLETE");
      } catch { status.textContent = "수집을 완료하지 못했습니다."; }
      finally { cleanup(); }
    };
    cancel.onclick = () => { if (activeCrawlId) { cancel.disabled = true; status.textContent = "현재 페이지 수집 후 취소합니다..."; window.browserStore.cancelCrawl(activeCrawlId); } };
    const publicStatus = byId("public-crawl-status");
    const publicList = byId("public-crawl-list");
    const renderPublicJobs = (jobs: PublicCrawlJob[]) => { publicList.innerHTML = jobs.length ? jobs.map((job) => `<article class="public-crawl-job"><div><b>${escapeHtml(job.seedUrl)}</b><small>${job.status.toUpperCase()} · ${job.indexed} 색인 · ${job.skipped} 건너뜀 · ${job.failed} 실패</small></div>${["queued", "running"].includes(job.status) ? `<button type="button" data-cancel-public-job="${job.id}">취소</button>` : ""}</article>`).join("") : `<p class="help">아직 공개 수집 작업이 없습니다.</p>`; publicList.querySelectorAll<HTMLButtonElement>("[data-cancel-public-job]").forEach((button) => button.onclick = async () => { try { await publicCrawlerRequest(`/v1/crawls/${button.dataset.cancelPublicJob}`, { method: "DELETE" }); publicStatus.textContent = "공개 수집 취소를 요청했습니다."; loadPublicJobs(); } catch (error) { publicStatus.textContent = error instanceof Error ? error.message : "공개 수집을 취소하지 못했습니다."; } }); };
    const loadPublicJobs = async () => { if (!publicSearchAdminToken) { publicStatus.textContent = "관리자 토큰을 입력한 뒤 새로고침하세요."; return; } publicStatus.textContent = "공개 수집 작업을 불러오는 중입니다..."; try { const result = await publicCrawlerRequest<{ jobs: PublicCrawlJob[] }>("/v1/crawls"); renderPublicJobs(result.jobs); publicStatus.textContent = `${result.jobs.length}개 공개 수집 작업`; } catch (error) { publicStatus.textContent = error instanceof Error ? error.message : "공개 수집기에 연결하지 못했습니다."; } };
    byId<HTMLButtonElement>("refresh-public-crawls").onclick = loadPublicJobs;
    byId<HTMLFormElement>("public-crawler-form").onsubmit = async (event) => { event.preventDefault(); const token = byId<HTMLInputElement>("public-crawl-token").value.trim(); const seedUrl = byId<HTMLInputElement>("public-crawl-seed").value.trim(); if (!token || !seedUrl) { publicStatus.textContent = "시작 URL과 관리자 토큰을 입력하세요."; return; } publicSearchAdminToken = token; localStorage.setItem("atlas-public-search-admin-token", token); const hosts = byId<HTMLInputElement>("public-crawl-hosts").value.split(",").map((host) => host.trim()).filter(Boolean); const recrawl = byId<HTMLInputElement>("public-crawl-recrawl").value; const payload = { seedUrl, allowedHosts: hosts, maxPages: Number(byId<HTMLInputElement>("public-crawl-limit").value) || 100, ...(recrawl ? { recrawlMinutes: Number(recrawl) } : {}) }; publicStatus.textContent = "공개 수집을 등록하는 중입니다..."; try { const job = await publicCrawlerRequest<PublicCrawlJob>("/v1/crawls", { method: "POST", body: JSON.stringify(payload) }); publicStatus.textContent = `공개 수집을 시작했습니다: ${job.id}`; loadPublicJobs(); } catch (error) { publicStatus.textContent = error instanceof Error ? error.message : "공개 수집을 시작하지 못했습니다."; } };
  }
  if (panel === "search") {
    content.innerHTML = `<p class="engine-note"><b>Atlas Search</b><br>검색 결과는 오른쪽 메인 화면에 표시됩니다. 여기에서는 공개 Atlas 연결만 관리합니다.</p><form id="public-endpoint-form" class="endpoint-form"><input id="public-endpoint" type="url" value="${escapeHtml(publicSearchEndpoint)}" placeholder="http://localhost:8787" /><button>연결</button></form><form id="local-search"><input id="local-query" placeholder="검색어 입력" value="${escapeHtml(activeSearchQuery)}" /><button>검색</button></form><p class="help">내 Atlas는 AND · OR · NOT · 괄호 · "구문 검색"을 지원합니다.</p>`;
    const showResults = () => showMainSearch(byId<HTMLInputElement>("local-query").value);
    byId<HTMLFormElement>("local-search").onsubmit = (event) => { event.preventDefault(); showResults(); };
    byId<HTMLFormElement>("public-endpoint-form").onsubmit = (event) => { event.preventDefault(); const endpoint = byId<HTMLInputElement>("public-endpoint").value.trim().replace(/\/$/, ""); try { publicSearchEndpoint = new URL(endpoint).origin; localStorage.setItem("atlas-public-search-endpoint", publicSearchEndpoint); setStatus("PUBLIC ATLAS ENDPOINT SAVED"); if (byId<HTMLInputElement>("local-query").value.trim()) showResults(); } catch { setStatus("INVALID PUBLIC ATLAS ENDPOINT"); } };
  }  if (panel === "notes") { content.innerHTML = `<p class="help">카드를 눌러 메모와 태그를 편집하세요.</p><div id="note-filter"></div><div id="note-list"><p class="help">노트를 불러오는 중입니다.</p></div>`; window.browserStore.notes().then((notes) => { if (panel !== "notes") return; const tags = [...new Set(notes.flatMap((note) => note.tags))]; if (activeTag && !tags.includes(activeTag)) activeTag = ""; const filters = byId("note-filter"); filters.innerHTML = tags.length ? `<button class="tag-filter ${activeTag ? "" : "active"}" data-tag="">ALL ${notes.length}</button>${tags.map((tag) => `<button class="tag-filter ${tag === activeTag ? "active" : ""}" data-tag="${encodeURIComponent(tag)}">#${escapeHtml(tag)}</button>`).join("")}` : ""; filters.querySelectorAll<HTMLElement>(".tag-filter").forEach((item) => item.onclick = () => { activeTag = decodeURIComponent(item.dataset.tag || ""); renderPanel(); }); const visibleNotes = activeTag ? notes.filter((note) => note.tags.includes(activeTag)) : notes; const list = byId("note-list"); list.innerHTML = visibleNotes.length ? visibleNotes.map((note) => `<button class="note-card" data-id="${note.id}"><b>${escapeHtml(note.sourceTitle)}</b><q>${escapeHtml(note.quote)}</q>${note.body ? `<span>${escapeHtml(note.body.slice(0, 110))}</span>` : ""}<span class="note-tags">${escapeHtml(note.tags.map((tag) => `#${tag}`).join(" "))}</span></button>`).join("") : `<p class="help">${activeTag ? `#${escapeHtml(activeTag)} 태그의 노트가 없습니다.` : "저장된 지식 노트가 없습니다."}</p>`; list.querySelectorAll<HTMLElement>(".note-card").forEach((item) => item.onclick = () => openNoteDialog(notes.find((note) => note.id === Number(item.dataset.id)))); }); }
  if (panel === "backup") { content.innerHTML = `<p class="help">브라우저 상태, 색인 문서, 링크와 노트를 JSON 파일로 백업하거나 가져옵니다.</p><div class="backup-actions"><button id="export-backup">백업 내보내기</button><button id="import-backup">백업 가져오기</button></div><p id="backup-status" class="help"></p>`; byId("export-backup").onclick = async () => { const result = await window.browserStore.exportBackup(); if (!result.cancelled) byId("backup-status").textContent = `백업 파일을 만들었습니다: ${result.path}`; }; byId("import-backup").onclick = async () => { try { const result = await window.browserStore.importBackup(); if (!result.cancelled) { byId("backup-status").textContent = `가져오기 완료: 문서 ${result.documents}개, 노트 ${result.notes}개`; byId("page-info").textContent = `${await window.browserStore.documentCount()} DOCUMENTS INDEXED`; } } catch { byId("backup-status").textContent = "백업 파일을 가져오지 못했습니다."; } }; }
  if (panel === "bookmarks") content.innerHTML = bookmarks.length ? bookmarks.map((item) => `<button class="saved" data-url="${encodeURIComponent(item.url)}"><b>${escapeHtml(item.title)}</b><span>${escapeHtml(item.url)}</span></button>`).join("") : `<p class="help">별표를 눌러 현재 페이지를 저장하세요.</p>`;
  if (panel === "history") content.innerHTML = visitHistory.length ? visitHistory.slice(0, 20).map((item) => `<button class="saved" data-url="${encodeURIComponent(item.url)}"><b>${escapeHtml(item.title)}</b><span>${escapeHtml(item.url)}</span></button>`).join("") : `<p class="help">아직 탐색한 페이지가 없습니다.</p>`;
  content.querySelectorAll<HTMLElement>(".saved").forEach((item) => item.onclick = () => navigate(decodeURIComponent(item.dataset.url || "")));
}
function navigate(url: string) { const tab = current(); if (!tab) { addTab(normalizeUrl(url)); return; } tab.view.loadURL(normalizeUrl(url)); }
function submitAtlasQuery(input: string) { const value = input.trim(); if (!value) return; if (isWebAddress(value)) { navigate(value); return; } showMainSearch(value); }
byId<HTMLFormElement>("address-form").addEventListener("submit", (event) => { event.preventDefault(); submitAtlasQuery(address.value); });
byId<HTMLFormElement>("home-search").addEventListener("submit", (event) => { event.preventDefault(); const query = byId<HTMLInputElement>("home-query").value; address.value = query.trim(); submitAtlasQuery(query); });
function setAtlasOpen(open: boolean) { byId("shell").classList.toggle("atlas-open", open); }
byId("new-tab").onclick = () => addTab(); byId("restore-tab").onclick = () => { const tab = recentlyClosed.shift(); if (!tab) return; addTab(tab.url, tab.title, false); queueSessionSave(); setStatus("RECENT TAB RESTORED"); }; byId("back").onclick = () => current()?.view.goBack(); byId("forward").onclick = () => current()?.view.goForward(); byId("reload").onclick = () => current()?.view.reload();
byId("toggle-side").onclick = () => setAtlasOpen(!byId("shell").classList.contains("atlas-open")); byId("collapse-side").onclick = () => setAtlasOpen(false);
byId<HTMLButtonElement>("crawl-current").onclick = () => { const tab = current(); setAtlasOpen(true); panel = "crawler"; renderPanel(); if (!tab?.url || !/^https?:/i.test(tab.url)) { setStatus("OPEN A WEB PAGE TO START CRAWLING"); return; } const crawlUrl = byId<HTMLInputElement>("crawl-url"); crawlUrl.value = tab.url; crawlUrl.focus(); setStatus("CRAWLER READY · SET PAGE LIMIT AND START"); };
byId("window-minimize").onclick = () => window.windowControls.minimize(); byId("window-maximize").onclick = () => window.windowControls.maximize(); byId("window-close").onclick = () => window.windowControls.close();
byId("bookmark").onclick = async () => { const tab = current(); if (!tab?.url || tab.url.startsWith("about:")) return; bookmarks = await window.browserStore.toggleBookmark({ title: tab.title, url: tab.url, createdAt: new Date().toISOString() }); updateBookmark(); if (panel === "bookmarks") renderPanel(); };
byId("add-note").onclick = async () => { const tab = current(); if (!tab || tab.url.startsWith("about:")) return; try { const quote = await tab.view.executeJavaScript("window.getSelection()?.toString().trim() || ''") as string; if (!quote) { setStatus("SELECT TEXT TO CREATE A NOTE"); return; } openNoteDialog({ id: 0, quote: quote.slice(0, 3000), body: "", tags: [], sourceUrl: tab.url, sourceTitle: tab.title, createdAt: "" }); editingNote = undefined; byId("delete-note").classList.remove("visible"); } catch { setStatus("NOTE CAPTURE UNAVAILABLE"); } };
byId("close-note").onclick = () => noteDialog.close();
byId<HTMLFormElement>("note-form").onsubmit = async (event) => { event.preventDefault(); const tab = current(); const quote = noteQuote.textContent || ""; if (!quote) return; if (editingNote) await window.browserStore.updateNote({ id: editingNote.id, body: noteBody.value, tags: noteTags.value.split(",") }); else if (tab) await window.browserStore.saveNote({ quote, body: noteBody.value, tags: noteTags.value.split(","), sourceUrl: tab.url, sourceTitle: tab.title }); noteDialog.close(); setStatus(editingNote ? "KNOWLEDGE NOTE UPDATED" : "KNOWLEDGE NOTE SAVED"); editingNote = undefined; if (panel === "notes" || panel === "graph") renderPanel(); };
byId("delete-note").onclick = async () => { if (!editingNote) return; await window.browserStore.deleteNote(editingNote.id); noteDialog.close(); editingNote = undefined; setStatus("KNOWLEDGE NOTE DELETED"); if (panel === "notes" || panel === "graph") renderPanel(); };
document.querySelectorAll<HTMLElement>(".side-item").forEach((item) => item.onclick = () => { panel = item.dataset.panel || "structure"; setAtlasOpen(true); renderPanel(); }); document.querySelectorAll<HTMLButtonElement>("[data-home-url]").forEach((item) => item.onclick = () => navigate(item.dataset.homeUrl || "")); document.querySelectorAll<HTMLButtonElement>("[data-home-panel]").forEach((item) => item.onclick = () => { panel = item.dataset.homePanel || "bookmarks"; setAtlasOpen(true); renderPanel(); }); document.addEventListener("keydown", (event) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "l") { event.preventDefault(); address.focus(); address.select(); } if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "t") { event.preventDefault(); byId<HTMLButtonElement>("restore-tab").click(); } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "t") { event.preventDefault(); addTab(); } });
window.addEventListener("beforeunload", () => { const active = current(); window.browserStore.saveSession({ tabs: tabs.map(({ title, url }) => ({ title, url })), activeUrl: active?.url || "", recentlyClosed }); });
Promise.all([window.browserStore.load(), window.browserStore.loadSession()]).then(async ([state, session]) => { bookmarks = state.bookmarks; visitHistory = state.history; recentlyClosed = session.recentlyClosed; const savedTabs = session.tabs.filter((tab) => tab.url && !tab.url.startsWith("about:")); savedTabs.forEach((tab) => addTab(tab.url, tab.title, false)); const restored = tabs.find((tab) => tab.url === session.activeUrl); if (restored) activate(restored.id); byId("page-info").textContent = `${await window.browserStore.documentCount()} DOCUMENTS INDEXED`; renderTabs(); renderPanel(); if (savedTabs.length) setStatus(`${savedTabs.length} TABS RESTORED`); }); renderPanel();
