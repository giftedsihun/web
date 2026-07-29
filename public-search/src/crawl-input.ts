export const DEFAULT_MAX_PAGES = 100;
export const MAX_CRAWL_PAGES = 10_000;
export const MIN_RECRAWL_MINUTES = 15;
export const MAX_RECRAWL_MINUTES = 43_200;

export class CrawlInputError extends Error {}

function finiteInteger(value: unknown, field: string) {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) throw new CrawlInputError(`${field} must be a finite integer.`);
  return value;
}

export function normalizeCrawlLimits(maxPages: unknown = DEFAULT_MAX_PAGES, recrawlMinutes?: unknown) {
  const pages = Math.min(Math.max(finiteInteger(maxPages, "maxPages"), 1), MAX_CRAWL_PAGES);
  if (recrawlMinutes === undefined || recrawlMinutes === null || recrawlMinutes === 0) return { maxPages: pages, recrawlMinutes: undefined };
  const minutes = finiteInteger(recrawlMinutes, "recrawlMinutes");
  if (minutes < 0) throw new CrawlInputError("recrawlMinutes must not be negative.");
  return { maxPages: pages, recrawlMinutes: Math.min(Math.max(minutes, MIN_RECRAWL_MINUTES), MAX_RECRAWL_MINUTES) };
}
