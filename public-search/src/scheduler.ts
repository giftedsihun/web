export const DEFAULT_MAX_CONCURRENT_CRAWLS = 2;
export const MAX_CONCURRENT_CRAWLS = 10;

export class SchedulerConfigError extends Error {}

export function normalizeMaxConcurrentCrawls(value: unknown) {
  if (value === undefined || value === "") return DEFAULT_MAX_CONCURRENT_CRAWLS;
  const numeric = typeof value === "string" ? Number(value) : value;
  if (typeof numeric !== "number" || !Number.isFinite(numeric) || !Number.isInteger(numeric) || numeric < 1 || numeric > MAX_CONCURRENT_CRAWLS) throw new SchedulerConfigError(`PUBLIC_SEARCH_MAX_CONCURRENT_CRAWLS must be an integer from 1 to ${MAX_CONCURRENT_CRAWLS}.`);
  return numeric;
}
