import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { Agent } from "undici";
import { normalizeCrawlLimits } from "./crawl-input";
import { allowsContentType, normalizeCrawlPolicy } from "./crawl-policy";
import { extractDocument, canonicalize, inferDocumentLanguage, isPublicIpAddress, isPublicWebUrl, robotsDirectives, sitemapEntries } from "./extract";
import { robotsPolicy, robotsSitemaps } from "./robots";
import { MAX_DOCUMENT_BYTES, MAX_ROBOTS_BYTES, MAX_SITEMAP_BYTES, readResponseText } from "./response";
import { SearchStore } from "./store";
import type { CrawlFailureType, CrawlJob } from "./types";
import { normalizeMaxConcurrentCrawls } from "./scheduler";
import type { WebhookEvent } from "./config";

import { DEFAULT_CRAWLER_USER_AGENT } from "./config";
export const MAX_HOST_THROTTLES = 10_000;
export const MAX_ROBOTS_CACHE_ENTRIES = 10_000;
export const ROBOTS_CACHE_TTL_MS = 60 * 60 * 1_000;
export const MAX_SITEMAP_DOCUMENTS = 100;
export const MAX_SITEMAP_DEPTH = 3;
export const MAX_RETRY_AFTER_MS = 120_000;
export const MAX_FRONTIER_ATTEMPTS = 3;
export const MAX_FRONTIER_RETRY_DELAY_MS = 120_000;
export const FRONTIER_RETRY_BASE_DELAY_MS = 1_000;
export const FRONTIER_LEASE_MS = 30_000;
export const FRONTIER_HEARTBEAT_MS = 10_000;

export type ResolvedAddress = { address: string; family: number };
export type DnsResolver = (hostname: string) => Promise<ResolvedAddress[]>;

async function systemDnsResolver(hostname: string): Promise<ResolvedAddress[]> {
  return lookup(hostname, { all: true, verbatim: true });
}

// Validate every DNS answer: accepting one public answer can still allow a rebinding to a private one.
export async function resolvePublicAddresses(hostname: string, resolver: DnsResolver = systemDnsResolver) {
  const addresses = await resolver(hostname);
  if (!addresses.length || addresses.some((entry) => !isPublicIpAddress(entry.address))) throw new Error("Blocked private network address");
  return addresses;
}

function publicDnsLookup(hostname: string, options: { family?: number | "IPv4" | "IPv6" }, callback: (error: NodeJS.ErrnoException | null, address?: string, family?: number) => void) {
  void resolvePublicAddresses(hostname).then((addresses) => {
    const family = options.family === "IPv4" ? 4 : options.family === "IPv6" ? 6 : options.family;
    const selected = addresses.find((entry) => !family || entry.family === family);
    if (!selected) { callback(Object.assign(new Error("No public DNS address for requested family"), { code: "ENOTFOUND" })); return; }
    callback(null, selected.address, selected.family);
  }, (error: unknown) => callback(error instanceof Error ? error as NodeJS.ErrnoException : Object.assign(new Error("DNS lookup failed"), { code: "ENOTFOUND" })));
}

// The connector repeats DNS validation at socket creation, closing the DNS lookup-to-connect gap.
const publicNetworkDispatcher = new Agent({ connect: { lookup: publicDnsLookup as never } });

function fetchPublicTarget(target: URL, init: RequestInit, cancellation: AbortSignal) {
  return fetch(target, { ...init, signal: combineCrawlSignals(init.signal, cancellation), redirect: "manual", dispatcher: publicNetworkDispatcher } as RequestInit);
}

export type RobotsCacheEntry = { text: string; expiresAt: number };

export function retryAfterMs(value: string | null, now = Date.now()) {
  if (!value) return undefined;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : Date.parse(value) - now;
  return Number.isFinite(delay) && delay >= 0 ? Math.min(delay, MAX_RETRY_AFTER_MS) : undefined;
}

function safeSeed(value: string) {
  const url = new URL(value);
  if (!isPublicWebUrl(url.toString())) throw new Error("Public HTTP/HTTPS URL only; local network targets are blocked.");
  return canonicalize(url.toString());
}

export function normalizeApprovedHost(value: string) {
  const candidate = value.trim().toLowerCase();
  if (!candidate || /[\s/@?#]/.test(candidate)) throw new Error("Approved hosts must be hostnames or host:port values.");
  let url: URL;
  try { url = new URL(`https://${candidate}`); } catch { throw new Error("Approved hosts must be valid public hostnames."); }
  if (url.host !== candidate || !isPublicWebUrl(url.toString())) throw new Error("Approved hosts must be valid public hostnames.");
  return url.host;
}

export function crawlFailureMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "Crawler request failed";
  return message.replace(/\s+/g, " ").trim().slice(0, 500) || "Crawler request failed";
}

export function classifyCrawlFailure(error: unknown): { type: CrawlFailureType; retryable: boolean } {
  const message = crawlFailureMessage(error);
  const source = error && typeof error === "object" ? error as { code?: unknown; cause?: { code?: unknown } } : undefined;
  const code = String(source?.code || source?.cause?.code || "");
  if (/^HTTP 429$/.test(message)) return { type: "http_429", retryable: true };
  if (/^HTTP 5\d\d$/.test(message)) return { type: "http_5xx", retryable: true };
  if (["ENOTFOUND", "EAI_AGAIN", "ENODATA"].includes(code)) return { type: "dns", retryable: true };
  if (["ECONNREFUSED", "ECONNRESET", "ECONNABORTED", "EPIPE", "ENETUNREACH", "EHOSTUNREACH"].includes(code)) return { type: "connection", retryable: true };
  if ((error instanceof DOMException && ["TimeoutError", "AbortError"].includes(error.name)) || /\b(timeout|timed out)\b/i.test(message)) return { type: "timeout", retryable: true };
  return { type: "unknown", retryable: false };
}

export function frontierRetryDelayMs(attempts: number, retryAfter?: number) {
  const exponential = FRONTIER_RETRY_BASE_DELAY_MS * (2 ** Math.max(attempts - 1, 0));
  return Math.min(Math.max(exponential, retryAfter || 0), MAX_FRONTIER_RETRY_DELAY_MS);
}

export function scopedCanonicalUrl(candidate: string | undefined, fetchedUrl: URL, allowedHosts: Set<string>) {
  const fallback = canonicalize(fetchedUrl.toString());
  if (!candidate) return fallback;
  try {
    const canonical = canonicalize(candidate);
    return isPublicWebUrl(canonical) && allowedHosts.has(new URL(canonical).host) ? canonical : fallback;
  } catch { return fallback; }
}

export function isAllowedCrawlUrl(url: URL, allowedHosts: ReadonlySet<string>) {
  return isPublicWebUrl(url.toString()) && allowedHosts.has(url.host);
}

export function combineCrawlSignals(timeout: AbortSignal | null | undefined, cancellation: AbortSignal) {
  return timeout ? AbortSignal.any([timeout, cancellation]) : cancellation;
}

export function waitForCrawl(milliseconds: number, cancellation: AbortSignal) {
  if (cancellation.aborted) return Promise.reject(new DOMException("Crawl cancelled", "AbortError"));
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(finish, milliseconds);
    function finish() { cleanup(); resolve(); }
    function abort() { cleanup(); reject(new DOMException("Crawl cancelled", "AbortError")); }
    function cleanup() { clearTimeout(timer); cancellation.removeEventListener("abort", abort); }
    cancellation.addEventListener("abort", abort, { once: true });
  });
}

export function pruneHostThrottles(throttles: Map<string, number>, now = Date.now(), maximum = MAX_HOST_THROTTLES) {
  for (const [host, availableAt] of throttles) if (availableAt <= now) throttles.delete(host);
  if (throttles.size <= maximum) return;
  const surplus = throttles.size - maximum;
  [...throttles.entries()].sort((left, right) => left[1] - right[1]).slice(0, surplus).forEach(([host]) => throttles.delete(host));
}

export function pruneRobotsCache(cache: Map<string, RobotsCacheEntry>, now = Date.now(), maximum = MAX_ROBOTS_CACHE_ENTRIES) {
  for (const [origin, entry] of cache) if (entry.expiresAt <= now) cache.delete(origin);
  if (cache.size <= maximum) return;
  const surplus = cache.size - maximum;
  [...cache.entries()].sort((left, right) => left[1].expiresAt - right[1].expiresAt).slice(0, surplus).forEach(([origin]) => cache.delete(origin));
}

export class Crawler {
  private readonly robots = new Map<string, RobotsCacheEntry>();
  private readonly nextHostRequest = new Map<string, number>();
  private readonly active = new Set<string>();
  private readonly cancellations = new Map<string, AbortController>();
  private readonly pending: string[] = [];
  private readonly maximumConcurrent: number;
  private readonly workerId = randomUUID();

  constructor(private readonly store: SearchStore, maximumConcurrent: unknown = undefined, private readonly report: (event: WebhookEvent, job: CrawlJob) => void = () => {}, private readonly userAgent = DEFAULT_CRAWLER_USER_AGENT) { this.maximumConcurrent = normalizeMaxConcurrentCrawls(maximumConcurrent); }

  private reportJob(event: WebhookEvent, jobId: string) { const job = this.store.getJob(jobId); if (job) this.report(event, job); }

  submit(seedUrl: string, maxPages: unknown, allowedHosts: string[], recrawlMinutes?: unknown, crawlPolicy?: unknown) {
    const seed = safeSeed(seedUrl);
    if (this.store.isDomainBlocked(new URL(seed).hostname)) throw new Error("This domain is blocked from public crawling.");
    const hosts = [...new Set([new URL(seed).host, ...allowedHosts.map(normalizeApprovedHost)])];
    const now = new Date().toISOString();
    const limits = normalizeCrawlLimits(maxPages, recrawlMinutes);
    const job: CrawlJob = { id: randomUUID(), seedUrl: seed, maxPages: limits.maxPages, allowedHosts: hosts, policy: normalizeCrawlPolicy(crawlPolicy), recrawlMinutes: limits.recrawlMinutes, nextRecrawlAt: limits.recrawlMinutes ? Date.now() + limits.recrawlMinutes * 60_000 : undefined, status: "queued", indexed: 0, skipped: 0, failed: 0, createdAt: now, updatedAt: now };
    this.store.createJob(job);
    this.report("crawl.submitted", job);
    this.schedule(job.id);
    return job;
  }

  resume() { this.store.recoverInterruptedJobs(); this.store.runnableJobs().forEach((job) => this.schedule(job.id)); }
  runDueRecrawls() { this.store.dueRecrawls(Date.now()).forEach((job) => { if (this.store.restartForRecrawl(job.id)) this.schedule(job.id); }); }
  private schedule(jobId: string) { if (this.active.has(jobId) || this.pending.includes(jobId)) return; this.pending.push(jobId); this.drain(); }
  private drain() { while (this.active.size < this.maximumConcurrent && this.pending.length) { const jobId = this.pending.shift()!; void this.run(jobId); } }
  restart(jobId: string) {
    const restarted = this.store.restartJob(jobId);
    if (restarted) { this.reportJob("crawl.restarted", jobId); this.schedule(jobId); }
    return restarted;
  }
  retryFailed(jobId: string) {
    const retried = this.store.retryFailedFrontier(jobId);
    if (retried) { this.reportJob("crawl.retry_queued", jobId); this.schedule(jobId); }
    return retried;
  }
  requeueDocument(url: string, jobId?: string) { const requeued = this.store.requeueDocument(url, jobId); if (requeued?.status === "queued") this.schedule(requeued.jobId); return requeued; }
  cancel(jobId: string) {
    const cancelled = this.store.cancelJob(jobId);
    if (cancelled) { const index = this.pending.indexOf(jobId); if (index >= 0) this.pending.splice(index, 1); this.cancellations.get(jobId)?.abort(); this.reportJob("crawl.cancelled", jobId); }
    return cancelled;
  }
  pause(jobId: string) { const paused = this.store.pauseJob(jobId); if (paused) { const index = this.pending.indexOf(jobId); if (index >= 0) this.pending.splice(index, 1); this.cancellations.get(jobId)?.abort(); this.reportJob("crawl.paused", jobId); } return paused; }
  resumeJob(jobId: string) { const resumed = this.store.resumeJob(jobId); if (resumed) { this.reportJob("crawl.resumed", jobId); this.schedule(jobId); } return resumed; }

  private async robotsFor(url: URL, allowedHosts: ReadonlySet<string>, cancellation: AbortSignal) {
    pruneRobotsCache(this.robots);
    let cached = this.robots.get(url.origin);
    if (!cached) {
      let text = "";
      try {
        const response = await this.fetchWithRetry(new URL("/robots.txt", url.origin), { headers: { "User-Agent": this.userAgent, Accept: "text/plain" }, signal: AbortSignal.timeout(8_000) }, allowedHosts, cancellation);
        text = response.ok ? await readResponseText(response, MAX_ROBOTS_BYTES) : "";
      } catch { /* An unavailable robots policy expires so it can be retried later. */ }
      cached = { text, expiresAt: Date.now() + ROBOTS_CACHE_TTL_MS };
      this.robots.set(url.origin, cached);
      pruneRobotsCache(this.robots);
    }
    return { ...robotsPolicy(cached.text, url, this.userAgent), text: cached.text };
  }

  private async fetchWithRetry(url: URL, init: RequestInit, allowedHosts: ReadonlySet<string>, cancellation: AbortSignal, attempts = 3) {
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        let target = url;
        for (let redirect = 0; redirect < 6; redirect++) {
          if (!isAllowedCrawlUrl(target, allowedHosts)) throw new Error("Blocked off-scope URL");
          await this.assertPublicTarget(target);
          const response = await fetchPublicTarget(target, init, cancellation);
           if (response.status < 300 || response.status === 304 || response.status >= 400) {
             if (response.status < 500 && response.status !== 429) return response;
             const retryAfter = retryAfterMs(response.headers.get("retry-after"));
             if (retryAfter !== undefined) this.nextHostRequest.set(target.host, Math.max(this.nextHostRequest.get(target.host) || 0, Date.now() + retryAfter));
              const error = new Error(`HTTP ${response.status}`) as Error & { retryAfter?: number };
              error.retryAfter = retryAfter;
              lastError = error;
             break;
           }
          const location = response.headers.get("location");
          if (!location) throw new Error("Redirect without location");
          target = new URL(location, target);
        }
        if (!lastError) lastError = new Error("Too many redirects");
      } catch (error) { lastError = error; }
      if (cancellation.aborted) throw lastError instanceof Error ? lastError : new Error("Crawl cancelled");
       const waitUntil = this.nextHostRequest.get(url.host) || 0;
       await waitForCrawl(Math.max(500 * (2 ** attempt), waitUntil - Date.now(), 0), cancellation);
    }
    throw lastError instanceof Error ? lastError : new Error("Request failed");
  }

  private async assertPublicTarget(url: URL) {
    if (!isPublicWebUrl(url.toString())) throw new Error("Blocked non-public URL");
    await resolvePublicAddresses(url.hostname);
  }

  private async enqueueSitemaps(jobId: string, seed: URL, allowedHosts: Set<string>, cancellation: AbortSignal) {
    const sitemapUrls = new Set<string>([new URL("/sitemap.xml", seed.origin).toString()]);
    try {
      const robots = await this.robotsFor(seed, allowedHosts, cancellation);
      for (const location of robotsSitemaps(robots.text)) {
        try {
          const sitemap = new URL(location, seed.origin);
          if (isAllowedCrawlUrl(sitemap, allowedHosts)) sitemapUrls.add(sitemap.toString());
        } catch { /* Ignore malformed robots Sitemap directives. */ }
      }
    } catch { /* The conventional sitemap remains useful when robots is unavailable. */ }
    const queue = [...sitemapUrls].map((url) => ({ url, depth: 0 }));
    const seen = new Set<string>();
    while (queue.length && seen.size < MAX_SITEMAP_DOCUMENTS && !cancellation.aborted) {
      const next = queue.shift()!;
      if (seen.has(next.url) || next.depth > MAX_SITEMAP_DEPTH) continue;
      seen.add(next.url);
      try {
        const sitemap = new URL(next.url);
        const response = await this.fetchWithRetry(sitemap, { headers: { "User-Agent": this.userAgent, Accept: "application/xml,text/xml" }, signal: AbortSignal.timeout(15_000) }, allowedHosts, cancellation);
        if (!response.ok) continue;
        const entries = sitemapEntries(await readResponseText(response, MAX_SITEMAP_BYTES), sitemap.toString());
        entries.urls.filter((url) => allowedHosts.has(new URL(url).host)).forEach((url) => this.store.enqueue(jobId, url, 1));
        if (next.depth < MAX_SITEMAP_DEPTH) entries.sitemaps.filter((url) => allowedHosts.has(new URL(url).host)).forEach((url) => queue.push({ url, depth: next.depth + 1 }));
      } catch { /* Sitemap discovery is opportunistic. */ }
    }
  }

  async run(jobId: string) {
    if (this.active.has(jobId)) return;
    this.active.add(jobId);
    const controller = new AbortController();
    this.cancellations.set(jobId, controller);
    try {
      const job = this.store.getJob(jobId);
      if (!job || job.status === "paused" || job.status === "cancelled") return;
      this.store.updateJob(jobId, { status: "running" });
      this.reportJob("crawl.running", jobId);
      const allowedHosts = new Set(job.allowedHosts);
       await this.enqueueSitemaps(jobId, new URL(job.seedUrl), allowedHosts, controller.signal);
      while (true) {
        const state = this.store.getJob(jobId);
        if (controller.signal.aborted || !state || state.status === "cancelled" || state.status === "paused" || state.indexed + state.skipped + state.failed >= state.maxPages) break;
        const next = this.store.claimNextUrl(jobId, this.workerId, FRONTIER_LEASE_MS);
        if (!next) { if (this.store.hasPendingFrontier(jobId)) { await waitForCrawl(250, controller.signal); continue; } break; }
        const url = new URL(next.url);
        const heartbeat = setInterval(() => this.store.heartbeatLease(jobId, next.url, this.workerId, FRONTIER_LEASE_MS), FRONTIER_HEARTBEAT_MS);
        const waitUntil = this.nextHostRequest.get(url.host) || 0;
        if (waitUntil > Date.now()) { clearInterval(heartbeat); this.store.defer(jobId, next.url, waitUntil, this.workerId); await waitForCrawl(Math.min(waitUntil - Date.now(), 1000), controller.signal); continue; }
        let failed = false;
        try {
          if (!isAllowedCrawlUrl(url, allowedHosts)) { this.store.recordSkipReason(jobId, "out_of_scope", true); continue; }
          const policy = await this.robotsFor(url, allowedHosts, controller.signal);
          if (controller.signal.aborted) break;
          if (!policy.allowed) { this.store.recordSkipReason(jobId, "robots_disallowed", true); continue; }
           this.nextHostRequest.set(url.host, Date.now() + Math.max(policy.crawlDelayMs, state.policy?.requestIntervalMs || 1_000));
          pruneHostThrottles(this.nextHostRequest);
           const validators = this.store.validators(next.url);
            const headers: Record<string, string> = { "User-Agent": this.userAgent, Accept: "text/html,application/xhtml+xml" };
           if (validators?.etag) headers["If-None-Match"] = validators.etag;
           if (validators?.lastModified) headers["If-Modified-Since"] = validators.lastModified;
            const response = await this.fetchWithRetry(url, { redirect: "follow", headers, signal: AbortSignal.timeout(15_000) }, allowedHosts, controller.signal, 1);
           if (controller.signal.aborted) break;
           const finalUrl = new URL(response.url);
           if (response.status === 304) { this.store.touchDocument(next.url); this.store.updateJob(jobId, { indexed: state.indexed + 1 }); continue; }
          if (!response.ok) { this.store.recordSkipReason(jobId, "http_response", true); continue; }
          if (!allowsContentType(response.headers.get("content-type"), state.policy || normalizeCrawlPolicy(undefined))) { this.store.recordSkipReason(jobId, "content_type", true); continue; }
          if (!isAllowedCrawlUrl(finalUrl, allowedHosts)) { this.store.recordSkipReason(jobId, "out_of_scope", true); continue; }
           const extracted = extractDocument(await readResponseText(response, MAX_DOCUMENT_BYTES), finalUrl.toString());
           const headerDirectives = robotsDirectives(response.headers.get("x-robots-tag"));
           const document = { ...extracted, noindex: extracted.noindex || headerDirectives.noindex, nofollow: extracted.nofollow || headerDirectives.nofollow };
          if (controller.signal.aborted) break;
          if (!document.text) { this.store.recordSkipReason(jobId, "empty_document", true); continue; }
           const canonical = scopedCanonicalUrl(document.canonicalUrl, finalUrl, allowedHosts);
           const canonicalOutcome = !document.canonicalUrl ? "none" : canonical === document.canonicalUrl ? "accepted" : "rejected";
           const hash = createHash("sha256").update(document.text).digest("hex");
           if (document.noindex) {
             this.store.recordSkipReason(jobId, "noindex", true);
             this.store.recordPageDiagnostic(jobId, { url: next.url, host: url.host, noindex: true, nofollow: document.nofollow, canonicalUrl: document.canonicalUrl, canonicalOutcome, indexed: false });
           } else {
              const links = document.links.filter((link) => allowedHosts.has(new URL(link).host)).map(canonicalize);
              const contentType = response.headers.get("content-type") || "";
              const documentType = contentType.includes("application/xhtml+xml") ? "xhtml" : "html";
              const indexed = this.store.index(canonical, canonical, document.title, document.text, hash, { etag: response.headers.get("etag"), lastModified: response.headers.get("last-modified") }, links, { language: inferDocumentLanguage(`${document.title} ${document.text}`), documentType });
             this.store.recordPageDiagnostic(jobId, { url: next.url, host: url.host, noindex: false, nofollow: document.nofollow, canonicalUrl: document.canonicalUrl, canonicalOutcome, duplicateOf: indexed.duplicateOf, indexed: indexed.indexed });
             if (indexed.indexed) this.store.updateJob(jobId, { indexed: state.indexed + 1 });
             else this.store.recordSkipReason(jobId, "duplicate_content", true);
           }
          if (!document.nofollow) document.links.filter((link) => allowedHosts.has(new URL(link).host)).forEach((link) => this.store.enqueue(jobId, link, next.depth + 1));
        } catch (error) {
          if (!controller.signal.aborted) {
            const message = crawlFailureMessage(error);
            const failure = classifyCrawlFailure(error);
            const retryAfter = error && typeof error === "object" && "retryAfter" in error ? Number((error as { retryAfter?: unknown }).retryAfter) : undefined;
            const result = failure.retryable
              ? this.store.scheduleRetry(jobId, next.url, message, failure.type, frontierRetryDelayMs(this.store.frontierAttempts(jobId, next.url), retryAfter), MAX_FRONTIER_ATTEMPTS, this.workerId)
              : (this.store.markFailed(jobId, next.url, message, failure.type, this.workerId), { terminal: true });
            failed = true;
            if (result.terminal) this.store.updateJob(jobId, { failed: state.failed + 1, error: message });
          }
        } finally { clearInterval(heartbeat); if (!controller.signal.aborted && !failed) this.store.markFetched(jobId, next.url, this.workerId); }
      }
      if (!["cancelled", "paused"].includes(this.store.getJob(jobId)?.status || "") && !this.store.hasPendingFrontier(jobId)) { this.store.updateJob(jobId, { status: "complete" }); this.reportJob("crawl.completed", jobId); }
    } catch (error) { if (!controller.signal.aborted && !["cancelled", "paused"].includes(this.store.getJob(jobId)?.status || "")) { this.store.updateJob(jobId, { status: "failed", error: crawlFailureMessage(error) }); this.reportJob("crawl.failed", jobId); } }
    finally { this.active.delete(jobId); if (this.cancellations.get(jobId) === controller) this.cancellations.delete(jobId); this.drain(); }
  }
}
