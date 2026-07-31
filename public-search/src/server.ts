import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { publicApiError } from "./api-error";
import { isAuthorized } from "./auth";
import { loadCrawlerUserAgent, loadOperationsConfig, requireAdminToken } from "./config";
import { allowedCorsOrigins, corsResponseHeaders } from "./cors";
import { Crawler } from "./crawler";
import { normalizeCrawlPolicy } from "./crawl-policy";
import { normalizeCrawlStatus, normalizeFrontierState } from "./crawl-status";
import { applyHttpLimits } from "./http-limits";
import { FixedWindowRateLimiter } from "./rate-limit";
import { readJsonBody, requireJsonContentType } from "./request";
import { apiResponseHeaders } from "./response-headers";
import { normalizeSearchQuery } from "./search-query";
import { ensureSearchDateRange, normalizeSearchDate, normalizeSearchDocumentType, normalizeSearchDomain, normalizeSearchLanguage, normalizeSearchSort } from "./search-options";
import { MaintenanceInputError, normalizeRetentionInput } from "./maintenance";
import { normalizeMaxConcurrentCrawls } from "./scheduler";
import { normalizeCrawlLimits } from "./crawl-input";
import { SearchStore } from "./store";
import { OperationsReporter } from "./operations";

const port = Number(process.env.PUBLIC_SEARCH_PORT || 8787);
const dataPath = process.env.PUBLIC_SEARCH_DB || join(process.cwd(), "data", "public-search.sqlite");
const backupDirectory = process.env.PUBLIC_SEARCH_BACKUP_DIR || join(dirname(dataPath), "backups");
const adminToken = requireAdminToken(process.env);
const operationsConfig = loadOperationsConfig(process.env);
const operations = new OperationsReporter(operationsConfig);
const corsOrigins = allowedCorsOrigins(process.env);
const store = new SearchStore(dataPath);
const crawler = new Crawler(store, normalizeMaxConcurrentCrawls(process.env.PUBLIC_SEARCH_MAX_CONCURRENT_CRAWLS), (event, job) => operations.emit(event, job), loadCrawlerUserAgent(process.env));
const apiRateLimiter = new FixedWindowRateLimiter(120, 60_000);
crawler.resume();
setInterval(() => crawler.runDueRecrawls(), 60_000).unref();
if (operationsConfig.backup) setInterval(() => { try { store.createBackup(backupDirectory, operationsConfig.backup!.retention); } catch (error) { console.error("Atlas public-search scheduled backup failed", error); } }, operationsConfig.backup.intervalMs).unref();

function json(request: IncomingMessage, response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) { response.writeHead(status, apiResponseHeaders({ "content-type": "application/json; charset=utf-8", ...corsResponseHeaders(request.headers.origin, corsOrigins), ...headers })); response.end(JSON.stringify(body)); }
function authorized(request: IncomingMessage) { return isAuthorized(request.headers.authorization, adminToken); }

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  try {
    if (request.method === "OPTIONS") return json(request, response, 204, {});
    if (url.pathname.startsWith("/v1/")) {
      // Do not trust forwarding headers unless a deployment-specific proxy policy is configured.
      const limit = apiRateLimiter.check(request.socket.remoteAddress || "unknown");
      if (!limit.allowed) return json(request, response, 429, { error: "rate limit exceeded" }, { "retry-after": String(limit.retryAfterSeconds) });
    }
    if (request.method === "GET" && url.pathname === "/health") return json(request, response, 200, { ok: true, documents: store.documentCount() });
    if (request.method === "GET" && url.pathname === "/ready") return json(request, response, 200, { ok: true, ready: true });
    if (request.method === "GET" && url.pathname === "/v1/search") {
      const query = normalizeSearchQuery(url.searchParams.get("q"));
      const rawPage = Number(url.searchParams.get("page") || 1);
      const page = Number.isFinite(rawPage) ? Math.min(Math.max(Math.floor(rawPage), 1), 100) : 1;
      const pageSize = 20;
      const sort = normalizeSearchSort(url.searchParams.get("sort"));
      const domain = normalizeSearchDomain(url.searchParams.get("domain"));
      const from = normalizeSearchDate(url.searchParams.get("from"), "from");
      const to = normalizeSearchDate(url.searchParams.get("to"), "to");
      const language = normalizeSearchLanguage(url.searchParams.get("language"));
      const documentType = normalizeSearchDocumentType(url.searchParams.get("documentType"));
      ensureSearchDateRange(from, to);
      const total = store.searchCount(query, domain, from, to, language, documentType);
      const results = store.search(query, (page - 1) * pageSize, pageSize, sort, domain, from, to, language, documentType);
      return json(request, response, 200, { query, sort, domain: domain ?? null, from: from ?? null, to: to ?? null, language: language ?? null, documentType: documentType ?? null, page, pageSize, total, totalPages: Math.max(Math.ceil(total / pageSize), 1), results, facets: store.searchFacets(query, domain, from, to, language, documentType), source: "atlas-public-starter" });
    }
    if (request.method === "GET" && url.pathname === "/v1/search/suggestions") {
      // Suggestions are derived from indexed public documents; request text is never persisted.
      const query = url.searchParams.get("q") || "";
      if (query.length > 120) return json(request, response, 400, { error: "q must be 120 characters or fewer." });
      return json(request, response, 200, { suggestions: store.suggestions(query) });
    }
    if (request.method === "GET" && url.pathname === "/v1/crawls") {
      if (!authorized(request)) return json(request, response, 401, { error: "admin token required" });
      const rawPage = Number(url.searchParams.get("page") || 1);
      const page = Number.isFinite(rawPage) ? Math.min(Math.max(Math.floor(rawPage), 1), 100) : 1;
      const pageSize = 20;
      const status = normalizeCrawlStatus(url.searchParams.get("status"));
      const total = store.jobCount(status);
      return json(request, response, 200, { jobs: store.listJobs((page - 1) * pageSize, pageSize, status), page, pageSize, total, totalPages: Math.max(Math.ceil(total / pageSize), 1), status: status ?? null });
    }
    if (request.method === "POST" && url.pathname === "/v1/crawls") {
      if (!authorized(request)) return json(request, response, 401, { error: "admin token required" });
      requireJsonContentType(request.headers["content-type"]);
      const input = await readJsonBody(request, request.headers["content-length"]) as { seedUrl?: unknown; maxPages?: unknown; allowedHosts?: unknown; recrawlMinutes?: unknown; crawlPolicy?: unknown };
      if (typeof input.seedUrl !== "string" || !input.seedUrl.trim()) return json(request, response, 400, { error: "seedUrl is required" });
      const allowedHosts = Array.isArray(input.allowedHosts) ? input.allowedHosts.filter((host): host is string => typeof host === "string").slice(0, 50) : [];
      return json(request, response, 202, crawler.submit(input.seedUrl, input.maxPages ?? 100, allowedHosts, input.recrawlMinutes, normalizeCrawlPolicy(input.crawlPolicy)));
    }
    if (request.method === "GET" && url.pathname === "/v1/crawls/summary") {
      if (!authorized(request)) return json(request, response, 401, { error: "admin token required" });
      return json(request, response, 200, store.jobStatusSummary());
    }
    if (request.method === "GET" && url.pathname === "/v1/admin/stats") {
      if (!authorized(request)) return json(request, response, 401, { error: "admin token required" });
      return json(request, response, 200, store.stats(dataPath));
    }
    if (request.method === "GET" && url.pathname === "/v1/admin/metrics") {
      if (!authorized(request)) return json(request, response, 401, { error: "admin token required" });
      return json(request, response, 200, store.operationalMetrics(dataPath));
    }
    if (request.method === "POST" && url.pathname === "/v1/admin/backup") {
      if (!authorized(request)) return json(request, response, 401, { error: "admin token required" });
      return json(request, response, 201, store.createBackup(backupDirectory, operationsConfig.backup?.retention));
    }
    if (request.method === "GET" && url.pathname === "/v1/admin/backups") {
      if (!authorized(request)) return json(request, response, 401, { error: "admin token required" });
      return json(request, response, 200, { backups: store.listBackups(backupDirectory) });
    }
    if (request.method === "POST" && url.pathname === "/v1/admin/backups/verify") {
      if (!authorized(request)) return json(request, response, 401, { error: "admin token required" });
      requireJsonContentType(request.headers["content-type"]);
      const input = await readJsonBody(request, request.headers["content-length"]) as { file?: unknown };
      if (typeof input.file !== "string") throw new MaintenanceInputError("file is required.");
      return json(request, response, 200, store.verifyBackup(backupDirectory, input.file));
    }
    if (request.method === "POST" && url.pathname === "/v1/admin/retention") {
      if (!authorized(request)) return json(request, response, 401, { error: "admin token required" });
      requireJsonContentType(request.headers["content-type"]);
      const input = normalizeRetentionInput(await readJsonBody(request, request.headers["content-length"]));
      return json(request, response, 200, store.retention(input.before, input.deleteDocuments, input.dryRun));
    }
    if (request.method === "POST" && url.pathname === "/v1/admin/search/optimize") {
      if (!authorized(request)) return json(request, response, 401, { error: "admin token required" });
      return json(request, response, 200, store.optimizeSearch());
    }
    if (request.method === "POST" && url.pathname === "/v1/admin/search/rebuild-ngrams") {
      if (!authorized(request)) return json(request, response, 401, { error: "admin token required" });
      return json(request, response, 200, store.rebuildNgrams());
    }
    if (request.method === "GET" && url.pathname === "/v1/admin/documents") {
      if (!authorized(request)) return json(request, response, 401, { error: "admin token required" });
      const domain = normalizeSearchDomain(url.searchParams.get("domain")); const page = Math.min(Math.max(Math.floor(Number(url.searchParams.get("page") || 1)) || 1, 1), 100); const pageSize = 20; const total = store.documentCountByDomain(domain);
      return json(request, response, 200, { documents: store.listDocuments(domain, (page - 1) * pageSize, pageSize), domain: domain ?? null, page, pageSize, total, totalPages: Math.max(Math.ceil(total / pageSize), 1) });
    }
    if (request.method === "GET" && url.pathname === "/v1/admin/documents/inspect") { if (!authorized(request)) return json(request, response, 401, { error: "admin token required" }); const documentUrl = url.searchParams.get("url"); if (!documentUrl) throw new MaintenanceInputError("url is required."); const document = store.inspectDocument(documentUrl); return document ? json(request, response, 200, document) : json(request, response, 404, { error: "document not found" }); }
    if (request.method === "DELETE" && url.pathname === "/v1/admin/documents") { if (!authorized(request)) return json(request, response, 401, { error: "admin token required" }); const documentUrl = url.searchParams.get("url"); if (!documentUrl) throw new MaintenanceInputError("url is required."); return store.deleteDocument(documentUrl) ? json(request, response, 200, { url: documentUrl, deleted: true }) : json(request, response, 404, { error: "document not found" }); }
    if (request.method === "POST" && url.pathname === "/v1/admin/documents/requeue") { if (!authorized(request)) return json(request, response, 401, { error: "admin token required" }); requireJsonContentType(request.headers["content-type"]); const input = await readJsonBody(request, request.headers["content-length"]) as { url?: unknown; jobId?: unknown }; if (typeof input.url !== "string" || !input.url) throw new MaintenanceInputError("url is required."); if (input.jobId !== undefined && (typeof input.jobId !== "string" || !/^[\w-]+$/.test(input.jobId))) throw new MaintenanceInputError("jobId must be a crawl job id."); const result = crawler.requeueDocument(input.url, input.jobId); if (result === undefined) return json(request, response, 404, { error: "document not found" }); return result ? json(request, response, 202, { url: input.url, ...result }) : json(request, response, 409, { error: "document has no eligible approved crawl source" }); }
    if (request.method === "POST" && url.pathname === "/v1/admin/documents/delete") {
      if (!authorized(request)) return json(request, response, 401, { error: "admin token required" }); requireJsonContentType(request.headers["content-type"]); const input = await readJsonBody(request, request.headers["content-length"]) as { domain?: unknown; dryRun?: unknown };
      if (typeof input.domain !== "string") throw new MaintenanceInputError("domain is required."); if (input.dryRun !== undefined && typeof input.dryRun !== "boolean") throw new MaintenanceInputError("dryRun must be a boolean."); const domain = normalizeSearchDomain(input.domain); if (!domain) throw new MaintenanceInputError("domain is required.");
      return json(request, response, 200, store.deleteDocumentsByDomain(domain, input.dryRun !== false));
    }
    if (request.method === "GET" && url.pathname === "/v1/admin/domain-blocks") {
      if (!authorized(request)) return json(request, response, 401, { error: "admin token required" });
      return json(request, response, 200, { blocks: store.listDomainBlocks() });
    }
    if (request.method === "POST" && url.pathname === "/v1/admin/domain-blocks") {
      if (!authorized(request)) return json(request, response, 401, { error: "admin token required" });
      requireJsonContentType(request.headers["content-type"]);
      const input = await readJsonBody(request, request.headers["content-length"]) as { domain?: unknown; reason?: unknown };
      if (typeof input.domain !== "string") throw new MaintenanceInputError("domain is required.");
      if (input.reason !== undefined && typeof input.reason !== "string") throw new MaintenanceInputError("reason must be a string.");
      const domain = normalizeSearchDomain(input.domain);
      if (!domain) throw new MaintenanceInputError("domain is required.");
      return json(request, response, 200, store.blockDomain(domain, input.reason || "Removal request"));
    }
    if (request.method === "DELETE" && url.pathname === "/v1/admin/domain-blocks") {
      if (!authorized(request)) return json(request, response, 401, { error: "admin token required" });
      const domain = normalizeSearchDomain(url.searchParams.get("domain"));
      if (!domain) throw new MaintenanceInputError("domain is required.");
      return store.unblockDomain(domain) ? json(request, response, 200, { domain, blocked: false }) : json(request, response, 404, { error: "domain block not found" });
    }
    if (request.method === "GET" && url.pathname === "/v1/admin/audit") {
      if (!authorized(request)) return json(request, response, 401, { error: "admin token required" }); return json(request, response, 200, { entries: store.listAudit() });
    }
    const frontierJobId = url.pathname.match(/^\/v1\/crawls\/([\w-]+)\/frontier$/)?.[1];
    if (request.method === "GET" && frontierJobId) {
      if (!authorized(request)) return json(request, response, 401, { error: "admin token required" });
      if (!store.getJob(frontierJobId)) return json(request, response, 404, { error: "crawl job not found" });
      const rawPage = Number(url.searchParams.get("page") || 1);
      const page = Number.isFinite(rawPage) ? Math.min(Math.max(Math.floor(rawPage), 1), 100) : 1;
      const pageSize = 20;
      const state = normalizeFrontierState(url.searchParams.get("state"));
      const total = store.frontierCountByState(frontierJobId, state);
      return json(request, response, 200, { entries: store.listFrontier(frontierJobId, (page - 1) * pageSize, pageSize, state), page, pageSize, total, totalPages: Math.max(Math.ceil(total / pageSize), 1), state: state ?? null });
    }
    const diagnosticMatch = url.pathname.match(/^\/v1\/crawls\/([\w-]+)\/pages\/diagnostic$/);
    if (request.method === "GET" && diagnosticMatch) {
      if (!authorized(request)) return json(request, response, 401, { error: "admin token required" });
      const pageUrl = url.searchParams.get("url");
      if (!pageUrl) throw new MaintenanceInputError("url is required.");
      if (!store.getJob(diagnosticMatch[1])) return json(request, response, 404, { error: "crawl job not found" });
      const diagnostic = store.pageDiagnostic(diagnosticMatch[1], pageUrl);
      return diagnostic ? json(request, response, 200, diagnostic) : json(request, response, 404, { error: "crawl page diagnostic not found" });
    }
    const retryFailedId = url.pathname.match(/^\/v1\/crawls\/([\w-]+)\/frontier\/retry$/)?.[1];
    if (request.method === "POST" && retryFailedId) {
      if (!authorized(request)) return json(request, response, 401, { error: "admin token required" });
      const retried = crawler.retryFailed(retryFailedId);
      return retried ? json(request, response, 202, { id: retryFailedId, retried, status: "queued" }) : json(request, response, 409, { error: "only terminal crawl jobs with failed frontier entries can be retried" });
    }
    const restartId = url.pathname.match(/^\/v1\/crawls\/([\w-]+)\/restart$/)?.[1];
    if (request.method === "POST" && restartId) {
      if (!authorized(request)) return json(request, response, 401, { error: "admin token required" });
      return crawler.restart(restartId) ? json(request, response, 202, { id: restartId, status: "queued" }) : json(request, response, 409, { error: "only completed, cancelled, or failed crawl jobs can be restarted" });
    }
    const scheduleId = url.pathname.match(/^\/v1\/crawls\/([\w-]+)\/schedule$/)?.[1];
    if (request.method === "POST" && scheduleId) { if (!authorized(request)) return json(request, response, 401, { error: "admin token required" }); requireJsonContentType(request.headers["content-type"]); const input = await readJsonBody(request, request.headers["content-length"]) as { recrawlMinutes?: unknown }; const job = store.getJob(scheduleId); if (!job) return json(request, response, 404, { error: "crawl job not found" }); const limits = normalizeCrawlLimits(job.maxPages, input.recrawlMinutes); store.setRecrawlMinutes(scheduleId, limits.recrawlMinutes); return json(request, response, 200, { id: scheduleId, recrawlMinutes: limits.recrawlMinutes ?? null }); }
    const pauseId = url.pathname.match(/^\/v1\/crawls\/([\w-]+)\/pause$/)?.[1];
    if (request.method === "POST" && pauseId) { if (!authorized(request)) return json(request, response, 401, { error: "admin token required" }); return crawler.pause(pauseId) ? json(request, response, 202, { id: pauseId, status: "paused" }) : json(request, response, 409, { error: "only queued or running crawl jobs can be paused" }); }
    const resumeId = url.pathname.match(/^\/v1\/crawls\/([\w-]+)\/resume$/)?.[1];
    if (request.method === "POST" && resumeId) { if (!authorized(request)) return json(request, response, 401, { error: "admin token required" }); return crawler.resumeJob(resumeId) ? json(request, response, 202, { id: resumeId, status: "queued" }) : json(request, response, 409, { error: "only paused crawl jobs can be resumed" }); }
    const jobId = url.pathname.match(/^\/v1\/crawls\/([\w-]+)$/)?.[1];
    if (request.method === "GET" && jobId) {
      if (!authorized(request)) return json(request, response, 401, { error: "admin token required" });
      const job = store.getJob(jobId);
      return job ? json(request, response, 200, { job, frontier: store.frontierStatusSummary(jobId) }) : json(request, response, 404, { error: "crawl job not found" });
    }
    if (request.method === "DELETE" && jobId) {
      if (!authorized(request)) return json(request, response, 401, { error: "admin token required" });
      return crawler.cancel(jobId) ? json(request, response, 202, { id: jobId, status: "cancelled" }) : json(request, response, 404, { error: "active job not found" });
    }
    return json(request, response, 404, { error: "not found" });
  } catch (error) {
    const apiError = publicApiError(error);
    return json(request, response, apiError.status, { error: apiError.message });
  }
});

applyHttpLimits(server);
server.listen(port, () => console.log(`Atlas public-search starter listening on :${port}`));
