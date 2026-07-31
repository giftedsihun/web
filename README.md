# Atlas Browser

Electron and TypeScript browser MVP that uses Chromium's `webview` for navigation.

Project-wide implementation status, constraints, and roadmap: [PROJECT_STATUS_KO.md](PROJECT_STATUS_KO.md)

Project file map, implemented features, configuration notes, and next plans: [PROJECT_GUIDE_KO.md](PROJECT_GUIDE_KO.md)

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

`public-search/` is a deliberately small, server-side foundation for a public-web search product. It is separate from the Electron app and is **not** a whole-web search engine yet. It provides a durable SQLite URL frontier, per-host crawl pacing, basic `robots.txt` `Allow`/`Disallow` and `Crawl-delay` handling, page-level `noindex`/`nofollow` compliance, HTML extraction, a full-text index, and an HTTP query/admin API.

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

Atlas automatically starts a private, loopback-only public-search service when the desktop app starts. Open the `ATLAS` panel, choose `통합 검색`, and search or submit a seed in `수집기`; results appear separately once pages have been collected. The desktop app does not crawl the whole web automatically: crawling starts only after you submit an approved seed and respects the configured page limits and robots policy. You can still enter a deployed public-search URL in the endpoint field; that explicit endpoint is saved locally.

## Supabase Account Foundation

The project accepts `SUPABASE_URL` plus `SUPABASE_ANON_KEY` (or `SUPABASE_PUBLISHABLE_KEY`) in the ignored `.env` file. In development, place it in the project root. For a packaged app, place the same public-only `.env` beside `Atlas Browser.exe` or in its `resources` directory; the app checks both locations. Open the Supabase Dashboard's `SQL Editor`, create a new query, and run [`supabase/migrations/20260731_atlas_profiles.sql`](supabase/migrations/20260731_atlas_profiles.sql). It creates RLS-protected profile, bookmark, reading-list, and saved-search tables. After fully restarting Atlas, use `계정·동기화` to sign up or sign in and sync those three collections; notes and browsing history remain local. Setup notes are in [`supabase/README.md`](supabase/README.md); never package or expose the service-role key in Electron.

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
- A submitted `crawlPolicy` can set `maxDepth`, up to 20 include/exclude URL glob patterns, approved HTML/XHTML content types, and `requestIntervalMs` from 1,000 to 120,000. The Atlas crawler panel exposes these controls, including additional approved hosts; the enforced interval is the stricter of the job policy and `robots.txt` `Crawl-delay`.
- Search retains FTS5/BM25 as its primary ranking path, with a separate Unicode-normalized token index for Korean particles and CJK character-bigram fallback. Rebuilding n-grams through the authenticated admin route also refreshes this token index; this is lightweight normalization, not a full dictionary-based morphological analyzer.
- Relevance ranking weights title matches above body matches, boosts a matching URL path, and adds small bounded freshness, indexed in-link, and content-quality signals. Link credit is limited to eight qualifying indexed sources, so a link farm cannot dominate results; substantive pages receive a modest boost while unusually thin, title-heavy, keyword-repetitive, or link-heavy pages are capped or down-weighted. `sort=newest` remains an explicit chronological override.
- A fixed offline ranking corpus covers English, Korean particle fallback, CJK matching, link authority, and spam-like pages, preventing these ranking behaviours from regressing during future changes.
- Public search supports optional language (`ko`, `en`, `ja`, `zh`, `other`) and document-type (`html`, `xhtml`) filters. Language is a lightweight script-based inference rather than a declaration of the page's official language.
- The Atlas crawler panel refreshes public crawl status every five seconds while open; job detail exposes queued, leased/processing, fetched, failed, retry, and per-URL error information.
- Unified search reports totals and pages both private Atlas documents/notes and public-index results independently, keeping the two result sources distinct.
- Transient DNS, connection, timeout, `429`, and `5xx` page failures are persisted and retried up to three total attempts with capped exponential backoff (maximum two minutes). `Retry-After` is honored for `429`/`5xx`; the job/frontier APIs expose `retrying`, `nextRetryAt`, `failureType`, `lastError`, and `lastFailedAt` for operators.
- Admin APIs provide paginated jobs/frontier inspection, pause/resume, retention previews, document-domain deletion previews, stats, and audit entries. Frontier inspection includes opaque lease owner, expiry, and heartbeat fields for active work. Run destructive actions as dry runs first.
- `GET /v1/admin/metrics` is an authenticated, bounded operational snapshot for dashboards: database size, document language/type counts, job states, frontier states, retries, and terminal failures. It intentionally excludes individual URLs and query text.
- In Atlas, the public crawler panel refreshes this same authenticated operational snapshot every five seconds and can create an on-demand server snapshot with `스냅샷 백업`. It also lists generated snapshots and runs a read-only `복구 검증` (`integrity_check`, schema compatibility, and bounded record totals) without replacing the live database.
- Public-search records its applied SQLite baseline in `schema_migrations`; the current version is included in the metrics snapshot. GitHub Actions runs `npm ci` and `npm test` for pushes and pull requests in [`.github/workflows/verify.yml`](.github/workflows/verify.yml).
- Frontier URLs are claimed atomically under a 30-second lease; active workers renew it every 10 seconds. A worker outage leaves its URL eligible for automatic recovery after lease expiry, preventing duplicate processing across service instances sharing the SQLite database.
- Approved in-scope canonical URLs become the document key. Exact duplicate body hashes retain the first indexed representative, while the duplicate page is recorded as `duplicate_content`. `GET /v1/crawls/<job-id>/pages/diagnostic?url=<page-url>` exposes canonical acceptance, robots directives, and any retained duplicate representative.
- Every crawl request resolves its hostname before validation and again in the HTTP connector; all returned addresses must be public, which blocks DNS rebinding to loopback, link-local, private, and reserved ranges. This application-level control complements (and does not replace) an infrastructure egress policy that permits the crawler only outbound `80`/`443` traffic to public networks and denies metadata, RFC1918, loopback, link-local, and IPv6 ULA ranges.
- Set `PUBLIC_SEARCH_CRAWLER_USER_AGENT` to a stable bot identity with an operator-owned information/contact URL before public deployment. The crawler respects both HTML robots meta directives and HTTP `X-Robots-Tag` `noindex`, `nofollow`, and `none` directives; sites can additionally block paths through `robots.txt`.
- `GET /v1/admin/documents/inspect?url=<indexed-url>` exposes stored document and quality metadata. `DELETE /v1/admin/documents?url=<indexed-url>` deletes one indexed document. `POST /v1/admin/documents/requeue` with `{ "url": "<indexed-url>", "jobId": "<optional-source-job>" }` only requeues an existing approved frontier entry; it never fetches a caller-supplied target, so the crawler still enforces public-target, host, robots, and crawl-policy checks.
- Crawl lifecycle events are emitted as one-line structured JSON logs without seed URLs or credentials. Optional signed alerts require both `PUBLIC_SEARCH_WEBHOOK_URL` (HTTPS only) and `PUBLIC_SEARCH_WEBHOOK_SECRET` (16-512 characters); no webhook or secret is enabled by default. Set `PUBLIC_SEARCH_WEBHOOK_EVENTS` to a comma-separated subset of `crawl.submitted`, `crawl.running`, `crawl.completed`, `crawl.failed`, `crawl.cancelled`, `crawl.paused`, `crawl.resumed`, `crawl.restarted`, and `crawl.retry_queued` (terminal alerts are the default). Alerts use bounded redacted payloads, an HMAC-SHA256 `x-atlas-signature`, a five-second timeout, and are queued asynchronously so crawl work does not await network delivery.
- `POST /v1/admin/backup` creates a transactionally consistent single-file SQLite snapshot using `VACUUM INTO`. It is admin-authenticated, generates its own filename, and writes to `PUBLIC_SEARCH_BACKUP_DIR` (default: `backups` beside the database); persist that directory with `/data`. Keep multiple snapshots according to your retention policy and periodically restore-test one in an isolated environment.
- `GET /v1/admin/backups` lists generated snapshot metadata without exposing server paths. `POST /v1/admin/backups/verify` accepts one listed filename, opens it read-only, runs SQLite `integrity_check`, checks schema compatibility, and returns bounded document/job/frontier/block totals. It is a restore-readiness check, not a restore operation; keep the service stopped and use the documented procedure for an actual replacement.
- Set `PUBLIC_SEARCH_BACKUP_INTERVAL_MINUTES` (15 to 10,080) to enable periodic snapshots and `PUBLIC_SEARCH_BACKUP_RETENTION` (default 7) to retain only the newest generated backups. Scheduled backup errors are logged without interrupting crawling; test restores separately before relying on them for recovery.
- `npm run public-search:restore-drill -- --backup <snapshot.sqlite>` copies one generated snapshot into a temporary directory, starts an isolated public-search process on an ephemeral loopback port, waits for `/ready`, compares authenticated metrics and domain-block totals with the snapshot, then removes the temporary database. It never starts from, changes, or replaces the live database.
- Operators can process a verified removal or crawl-block request through authenticated `POST /v1/admin/domain-blocks`. It immediately removes that domain's indexed documents and links, clears its queued frontier URLs, cancels matching active jobs, blocks future submissions, and writes an audit entry. The Atlas crawler panel lists active blocks and provides the same block/unblock controls. Use `DELETE /v1/admin/domain-blocks?domain=...` only after reviewing and resolving the request.
- Atlas keeps bookmarks, history, notes, and a local reading list in its local state. Use `읽기 목록` on a page to queue it for later; saved entries can be opened or removed from the Atlas tools panel and are included in the normal local state backup.
- Searches can be saved from the result header and rerun from the Atlas search panel. Recent queries remain only in local Atlas state, are capped at 100 unique terms, are included in local backups, and can be cleared from that panel.
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

Before a recovery drill, create or select a generated snapshot, run its authenticated read-only verification, then restore it only into an isolated stopped service. Confirm `/ready`, the reported schema version, and expected aggregate counts before routing traffic to it.

For the repeatable isolated drill, build the service and run:

```powershell
npm run build:public-search
npm run public-search:restore-drill -- --backup "backups\public-search-YYYYMMDD-HHMMSS.sqlite"
```

The drill has no network exposure beyond an ephemeral `127.0.0.1` listener and deletes its temporary restored database on success or failure. An actual production restore still requires stopping all writers and using the replacement procedure above.

### Deployment smoke test

After deployment and after recovery, run the Windows-compatible smoke test. It checks liveness, readiness, public search, and (when a token is supplied) an authenticated admin route without making changes.

```powershell
$env:PUBLIC_SEARCH_ADMIN_TOKEN = "replace-this-token"
.\scripts\public-search-smoke.ps1 -BaseUrl "http://localhost:8787"
```
