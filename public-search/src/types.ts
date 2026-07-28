export type CrawlStatus = "queued" | "running" | "complete" | "cancelled" | "failed";

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
};

export type SearchResult = {
  title: string;
  url: string;
  preview: string;
  indexedAt: string;
  score: number;
};
