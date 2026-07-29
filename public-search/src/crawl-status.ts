import type { CrawlStatus, FrontierState } from "./types";

const statuses = new Set<CrawlStatus>(["queued", "running", "paused", "complete", "cancelled", "failed"]);
const frontierStates = new Set<FrontierState>(["queued", "processing", "fetched", "failed"]);

export class CrawlStatusFilterError extends Error {}

export function normalizeCrawlStatus(value: string | null) {
  if (value === null || value === "") return undefined;
  if (!statuses.has(value as CrawlStatus)) throw new CrawlStatusFilterError("status must be queued, running, paused, complete, cancelled, or failed.");
  return value as CrawlStatus;
}

export function normalizeFrontierState(value: string | null) {
  if (value === null || value === "") return undefined;
  if (!frontierStates.has(value as FrontierState)) throw new CrawlStatusFilterError("state must be queued, processing, fetched, or failed.");
  return value as FrontierState;
}
