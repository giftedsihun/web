# Atlas Browser

Electron and TypeScript browser MVP that uses Chromium's `webview` for navigation.

Project-wide implementation status, constraints, and roadmap: [PROJECT_STATUS_KO.md](PROJECT_STATUS_KO.md)

The earlier local-browser MVP overview is retained in [ATLAS_OVERVIEW_KO.md](ATLAS_OVERVIEW_KO.md).

## Run

```powershell
npm install
npm start
```

## Included

- Persistent tab sessions, recently closed-tab restore (`Ctrl+Shift+T`), address/search bar, back, forward, and reload controls
- Local bookmarks and history stored in Electron's user-data directory
- Page heading outline and clickable SVG link graph built from indexed pages
- SQLite FTS5 local index with `AND`, `OR`, `NOT`, parentheses, and phrase search
- Bounded, robots.txt-aware same-domain web crawler that adds up to 50 linked HTML pages to the local index
- Selected-text knowledge notes with personal annotations, tags, unified search, and graph links
- Note editing, deletion, and tag filters for managing a growing knowledge collection
- Keyboard shortcuts: `Ctrl+L` address bar and `Ctrl+T` new tab

## Public Search Starter

`public-search/` is a deliberately small, server-side foundation for a public-web search product. It is separate from the Electron app and is **not** a whole-web search engine yet. It provides a durable SQLite URL frontier, per-host crawl pacing, basic `robots.txt` `Allow`/`Disallow` and `Crawl-delay` handling, HTML extraction, a full-text index, and an HTTP query/admin API.

Run it locally:

```powershell
$env:PUBLIC_SEARCH_ADMIN_TOKEN = "replace-this-token"
npm run public-search
```

Submit an approved public seed domain. The crawler stays within the seed host unless you explicitly add other approved hosts. `recrawlMinutes` is optional (minimum 15 minutes) and reuses the stored frontier after a completed crawl.

```powershell
Invoke-RestMethod http://localhost:8787/v1/crawls -Method Post -Headers @{ Authorization = "Bearer replace-this-token" } -ContentType "application/json" -Body '{"seedUrl":"https://example.com","maxPages":25,"allowedHosts":["www.example.com"],"recrawlMinutes":1440}'
Invoke-RestMethod "http://localhost:8787/v1/search?q=example"
```

Open Atlas's `ATLAS` panel, choose `통합 검색`, and keep the endpoint at `http://localhost:8787` (or enter a deployed public-search URL). Atlas then shows private and public-index results separately. The public endpoint is saved locally in the app.

Cancel a submitted crawl when needed:

```powershell
Invoke-RestMethod "http://localhost:8787/v1/crawls/<job-id>" -Method Delete -Headers @{ Authorization = "Bearer replace-this-token" }
```

Or start the same service with Docker:

```powershell
$env:PUBLIC_SEARCH_ADMIN_TOKEN = "replace-this-token"
docker compose up --build
```

The service resumes queued/running jobs when it starts, periodically starts due recrawls, and supports only explicitly approved hosts per crawl job. For production, replace the SQLite frontier/index with managed queue, object storage, and a distributed search cluster; add reliable HTML parsing/rendering, host/domain policies, canonical and duplicate clusters, distributed leases, metrics, abuse handling, and legal/privacy operations before expanding the corpus.
