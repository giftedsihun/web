import { createHash, randomUUID } from "node:crypto";
import { extractDocument, canonicalize } from "./extract";
import { robotsPolicy } from "./robots";
import { SearchStore } from "./store";
import type { CrawlJob } from "./types";

const agent = "AtlasPublicSearchBot/0.1 (+https://atlas.local/bot)";

function safeSeed(value: string) {
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol) || !url.hostname || /^(localhost|127\.0\.0\.1|0\.0\.0\.0|::1)$/i.test(url.hostname) || url.hostname.endsWith(".local")) throw new Error("Public HTTP/HTTPS URL only; local network targets are blocked.");
  return canonicalize(url.toString());
}

export class Crawler {
  private readonly robots = new Map<string, string>();
  private readonly nextHostRequest = new Map<string, number>();
  private readonly active = new Set<string>();

  constructor(private readonly store: SearchStore) {}

  submit(seedUrl: string, maxPages: number, allowedHosts: string[], recrawlMinutes?: number) {
    const seed = safeSeed(seedUrl);
    const hosts = [...new Set([new URL(seed).host, ...allowedHosts.map((host) => host.toLowerCase().trim()).filter(Boolean)])];
    const now = new Date().toISOString();
    const frequency = recrawlMinutes ? Math.min(Math.max(Math.floor(recrawlMinutes), 15), 43_200) : undefined;
    const job: CrawlJob = { id: randomUUID(), seedUrl: seed, maxPages: Math.min(Math.max(Math.floor(maxPages), 1), 10_000), allowedHosts: hosts, recrawlMinutes: frequency, nextRecrawlAt: frequency ? Date.now() + frequency * 60_000 : undefined, status: "queued", indexed: 0, skipped: 0, failed: 0, createdAt: now, updatedAt: now };
    this.store.createJob(job);
    void this.run(job.id);
    return job;
  }

  resume() { this.store.runnableJobs().forEach((job) => void this.run(job.id)); }
  runDueRecrawls() { this.store.dueRecrawls(Date.now()).forEach((job) => { if (this.store.restartForRecrawl(job.id)) void this.run(job.id); }); }

  private async robotsFor(url: URL) {
    if (!this.robots.has(url.origin)) {
      try {
        const response = await fetch(`${url.origin}/robots.txt`, { headers: { "User-Agent": agent }, signal: AbortSignal.timeout(8_000) });
        this.robots.set(url.origin, response.ok ? await response.text() : "");
      } catch { this.robots.set(url.origin, ""); }
    }
    return robotsPolicy(this.robots.get(url.origin) || "", url, agent);
  }

  async run(jobId: string) {
    if (this.active.has(jobId)) return;
    this.active.add(jobId);
    try {
      const job = this.store.getJob(jobId);
      if (!job) return;
      this.store.updateJob(jobId, { status: "running" });
      const allowedHosts = new Set(job.allowedHosts);
      while (true) {
        const state = this.store.getJob(jobId);
        if (!state || state.status === "cancelled" || state.indexed + state.skipped + state.failed >= state.maxPages) break;
        const next = this.store.nextUrl(jobId);
        if (!next) { if (this.store.hasQueuedUrl(jobId)) { await new Promise((resolve) => setTimeout(resolve, 250)); continue; } break; }
        const url = new URL(next.url);
        const waitUntil = this.nextHostRequest.get(url.host) || 0;
        if (waitUntil > Date.now()) { this.store.defer(next.url, waitUntil); await new Promise((resolve) => setTimeout(resolve, Math.min(waitUntil - Date.now(), 1000))); continue; }
        this.store.markFetched(next.url);
        try {
          if (!allowedHosts.has(url.host)) { this.store.updateJob(jobId, { skipped: state.skipped + 1 }); continue; }
          const policy = await this.robotsFor(url);
          if (!policy.allowed) { this.store.updateJob(jobId, { skipped: state.skipped + 1 }); continue; }
          this.nextHostRequest.set(url.host, Date.now() + Math.max(policy.crawlDelayMs, 1_000));
          const response = await fetch(url, { redirect: "follow", headers: { "User-Agent": agent, Accept: "text/html,application/xhtml+xml" }, signal: AbortSignal.timeout(15_000) });
          const finalUrl = new URL(response.url);
          if (!response.ok || !response.headers.get("content-type")?.includes("text/html") || !allowedHosts.has(finalUrl.host)) { this.store.updateJob(jobId, { skipped: state.skipped + 1 }); continue; }
          const document = extractDocument(await response.text(), finalUrl.toString());
          if (!document.text) { this.store.updateJob(jobId, { skipped: state.skipped + 1 }); continue; }
          const canonical = document.canonicalUrl || canonicalize(finalUrl.toString());
          const hash = createHash("sha256").update(document.text).digest("hex");
          this.store.index(canonical, document.canonicalUrl, document.title, document.text, hash);
          document.links.filter((link) => allowedHosts.has(new URL(link).host)).forEach((link) => this.store.enqueue(jobId, link));
          this.store.updateJob(jobId, { indexed: state.indexed + 1 });
        } catch { this.store.updateJob(jobId, { failed: state.failed + 1 }); }
      }
      if (this.store.getJob(jobId)?.status !== "cancelled") this.store.updateJob(jobId, { status: "complete" });
    } catch (error) { this.store.updateJob(jobId, { status: "failed", error: error instanceof Error ? error.message : "Crawler failed" }); }
    finally { this.active.delete(jobId); }
  }
}
