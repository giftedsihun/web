import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { Crawler } from "./crawler";
import { SearchStore } from "./store";

const port = Number(process.env.PUBLIC_SEARCH_PORT || 8787);
const dataPath = process.env.PUBLIC_SEARCH_DB || join(process.cwd(), "data", "public-search.sqlite");
const adminToken = process.env.PUBLIC_SEARCH_ADMIN_TOKEN || "change-me";
const store = new SearchStore(dataPath);
const crawler = new Crawler(store);
crawler.resume();
setInterval(() => crawler.runDueRecrawls(), 60_000).unref();

function json(response: ServerResponse, status: number, body: unknown) { response.writeHead(status, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, DELETE, OPTIONS" }); response.end(JSON.stringify(body)); }
async function body(request: IncomingMessage) { let text = ""; for await (const chunk of request) text += chunk; return JSON.parse(text || "{}"); }
function authorized(request: IncomingMessage) { return request.headers.authorization === `Bearer ${adminToken}`; }

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  try {
    if (request.method === "OPTIONS") return json(response, 204, {});
    if (request.method === "GET" && url.pathname === "/health") return json(response, 200, { ok: true, documents: store.documentCount() });
    if (request.method === "GET" && url.pathname === "/v1/search") {
      const query = (url.searchParams.get("q") || "").trim().slice(0, 300);
      const rawPage = Number(url.searchParams.get("page") || 1);
      const page = Number.isFinite(rawPage) ? Math.min(Math.max(Math.floor(rawPage), 1), 1000) : 1;
      if (!query) return json(response, 400, { error: "q is required" });
      const pageSize = 20;
      const total = store.searchCount(query);
      const results = store.search(query, (page - 1) * pageSize, pageSize);
      return json(response, 200, { query, page, pageSize, total, totalPages: Math.max(Math.ceil(total / pageSize), 1), results, source: "atlas-public-starter" });
    }
    if (request.method === "GET" && url.pathname === "/v1/crawls") {
      if (!authorized(request)) return json(response, 401, { error: "admin token required" });
      return json(response, 200, { jobs: store.listJobs() });
    }
    if (request.method === "POST" && url.pathname === "/v1/crawls") {
      if (!authorized(request)) return json(response, 401, { error: "admin token required" });
      const input = await body(request) as { seedUrl?: string; maxPages?: number; allowedHosts?: unknown; recrawlMinutes?: number };
      if (!input.seedUrl) return json(response, 400, { error: "seedUrl is required" });
      const allowedHosts = Array.isArray(input.allowedHosts) ? input.allowedHosts.filter((host): host is string => typeof host === "string").slice(0, 50) : [];
      return json(response, 202, crawler.submit(input.seedUrl, input.maxPages ?? 100, allowedHosts, input.recrawlMinutes));
    }
    const jobId = url.pathname.match(/^\/v1\/crawls\/([\w-]+)$/)?.[1];
    if (request.method === "DELETE" && jobId) {
      if (!authorized(request)) return json(response, 401, { error: "admin token required" });
      return store.cancelJob(jobId) ? json(response, 202, { id: jobId, status: "cancelled" }) : json(response, 404, { error: "active job not found" });
    }
    return json(response, 404, { error: "not found" });
  } catch (error) { return json(response, 400, { error: error instanceof Error ? error.message : "bad request" }); }
});

server.listen(port, () => console.log(`Atlas public-search starter listening on :${port}`));
