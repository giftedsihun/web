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
# Copy-Item .env.example .env
# Set PUBLIC_SEARCH_ADMIN_TOKEN in .env to a long, random secret.
docker compose up --build
```

The service resumes queued/running jobs when it starts, periodically starts due recrawls, and supports only explicitly approved hosts per crawl job. For production, replace the SQLite frontier/index with managed queue, object storage, and a distributed search cluster; add reliable HTML parsing/rendering, host/domain policies, canonical and duplicate clusters, distributed leases, metrics, abuse handling, and legal/privacy operations before expanding the corpus.

### Operations

- `GET /health` confirms the process and database are responding; `GET /ready` is the readiness probe.
- The Docker image and Compose service use `/health` for their healthchecks. Wait for `healthy` before routing traffic to a new container.
- Set `PUBLIC_SEARCH_MAX_CONCURRENT_CRAWLS` to an integer from `1` to `10` (default `2`) to bound concurrent crawl jobs.
- Admin APIs provide paginated jobs/frontier inspection, pause/resume, retention previews, document-domain deletion previews, stats, and audit entries. Run destructive actions as dry runs first.
- `GET /v1/admin/documents/inspect?url=<indexed-url>` exposes stored document and quality metadata. `DELETE /v1/admin/documents?url=<indexed-url>` deletes one indexed document. `POST /v1/admin/documents/requeue` with `{ "url": "<indexed-url>", "jobId": "<optional-source-job>" }` only requeues an existing approved frontier entry; it never fetches a caller-supplied target, so the crawler still enforces public-target, host, robots, and crawl-policy checks.
- Crawl lifecycle events are emitted as one-line structured JSON logs without seed URLs or credentials. Optional signed alerts require both `PUBLIC_SEARCH_WEBHOOK_URL` (HTTPS only) and `PUBLIC_SEARCH_WEBHOOK_SECRET` (16-512 characters); no webhook or secret is enabled by default. Set `PUBLIC_SEARCH_WEBHOOK_EVENTS` to a comma-separated subset of `crawl.submitted`, `crawl.running`, `crawl.completed`, `crawl.failed`, `crawl.cancelled`, `crawl.paused`, `crawl.resumed`, `crawl.restarted`, and `crawl.retry_queued` (terminal alerts are the default). Alerts use bounded redacted payloads, an HMAC-SHA256 `x-atlas-signature`, a five-second timeout, and are queued asynchronously so crawl work does not await network delivery.
- Persist `/data` (the named Docker volume by default) and back up `public-search.sqlite`, `-wal`, and `-shm` together after stopping writes or using a SQLite-consistent backup.
- The versioned API contract is [`public-search/openapi.yaml`](public-search/openapi.yaml). Public API errors have an `{ "error": "..." }` body; authenticated endpoints use `Authorization: Bearer <token>`. `/v1/*` is rate-limited and reports `Retry-After` on `429` responses.

### Backup and recovery

The SQLite database uses WAL mode. Take a cold backup only after stopping all service writers; the Windows PowerShell script copies the database and its `-wal`/`-shm` companions together. Backups are ignored by Git by default.

```powershell
docker compose down
.\scripts\public-search-backup.ps1 -Action backup -DatabasePath "data\public-search.sqlite" -ServiceStopped

# Restore a named backup only while public-search is stopped. -Force permits replacing an existing database.
.\scripts\public-search-backup.ps1 -Action restore -DatabasePath "data\public-search.sqlite" -BackupPath "backups\public-search-YYYYMMDD-HHMMSS.sqlite" -ServiceStopped -Force
docker compose up -d
```

For the Compose named volume, first copy `/data/public-search.sqlite`, `/data/public-search.sqlite-wal`, and `/data/public-search.sqlite-shm` from a stopped container or volume into a local directory, then use that directory as `-DatabasePath`. Do not restore a database while the service is running.

### Deployment smoke test

After deployment and after recovery, run the Windows-compatible smoke test. It checks liveness, readiness, public search, and (when a token is supplied) an authenticated admin route without making changes.

```powershell
$env:PUBLIC_SEARCH_ADMIN_TOKEN = "replace-this-token"
.\scripts\public-search-smoke.ps1 -BaseUrl "http://localhost:8787"
```
