export type CrawlStatus = "queued" | "running" | "paused" | "complete" | "cancelled" | "failed";
export type FrontierState = "queued" | "processing" | "fetched" | "failed";

export type FrontierEntry = {
  url: string;
  state: FrontierState;
  attempts: number;
  host: string;
  availableAt: number;
  discoveredAt: string;
  lastError?: string | null;
  depth: number;
};

export type CrawlJob = {
  id: string;
  seedUrl: string;
  maxPages: number;
  allowedHosts: string[];
  recrawlMinutes?: number;
  nextRecrawlAt?: number;
  status: CrawlStatus;
  indexed: number;
  skipped: number;
  failed: number;
  createdAt: string;
  updatedAt: string;
  error?: string;
  skipReasons?: Record<string, number>;
  policy?: import("./crawl-policy").CrawlPolicy;
};

export type SearchResult = {
  title: string;
  url: string;
  preview: string;
  indexedAt: string;
  score: number;
};

export type CrawlPageDiagnostic = {
  url: string;
  host: string;
  noindex: boolean;
  nofollow: boolean;
  canonicalUrl?: string | null;
  canonicalOutcome: "none" | "accepted" | "rejected";
  duplicateOf?: string | null;
  indexed: boolean;
  updatedAt: string;
};

export type HostHealthMetric = { host: string; urls: number; attempted: number; retries: number; failed: number; errors: number; lastError?: string | null };

export type SearchFacets = { domains: Array<{ domain: string; count: number }>; dates: Array<{ date: string; count: number }> };
export type SearchSuggestion = { value: string; label: string; kind: "title" | "domain" };

export type AuditEntry = { id: number; action: string; target: string; details: string; createdAt: string };
export type DocumentQuality = { titleLength: number; textLength: number; wordCount: number; textHash: string; hasValidators: boolean };
export type DocumentInspection = { url: string; canonicalUrl?: string | null; title: string; indexedAt: string; etag?: string | null; lastModified?: string | null; quality: DocumentQuality; crawlJobs: Array<{ id: string; status: CrawlStatus; state: FrontierState; depth: number; updatedAt: string }> };
