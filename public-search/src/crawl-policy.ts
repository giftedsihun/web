export const MAX_CRAWL_DEPTH = 20;
export const MAX_URL_PATTERNS = 20;
export const MAX_PATTERN_LENGTH = 120;
export const MIN_REQUEST_INTERVAL_MS = 1_000;
export const MAX_REQUEST_INTERVAL_MS = 120_000;
const supportedContentTypes = new Set(["text/html", "application/xhtml+xml"]);

export class CrawlPolicyError extends Error {}

export type CrawlPolicy = {
  maxDepth?: number;
  requestIntervalMs?: number;
  includePatterns: string[];
  excludePatterns: string[];
  allowedContentTypes: string[];
};

function patterns(value: unknown, label: string) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_URL_PATTERNS) throw new CrawlPolicyError(`${label} must contain at most ${MAX_URL_PATTERNS} URL patterns.`);
  return value.map((item) => {
    if (typeof item !== "string" || !item.trim() || item.trim().length > MAX_PATTERN_LENGTH) throw new CrawlPolicyError(`${label} contains an invalid URL pattern.`);
    return item.trim();
  });
}

export function normalizeCrawlPolicy(value: unknown): CrawlPolicy {
  if (value === undefined || value === null) return { includePatterns: [], excludePatterns: [], allowedContentTypes: ["text/html", "application/xhtml+xml"] };
  if (typeof value !== "object" || Array.isArray(value)) throw new CrawlPolicyError("crawlPolicy must be an object.");
  const input = value as { maxDepth?: unknown; requestIntervalMs?: unknown; includePatterns?: unknown; excludePatterns?: unknown; allowedContentTypes?: unknown };
  let maxDepth: number | undefined;
  if (input.maxDepth !== undefined && input.maxDepth !== null && input.maxDepth !== "") {
    if (typeof input.maxDepth !== "number" || !Number.isInteger(input.maxDepth) || input.maxDepth < 0) throw new CrawlPolicyError(`maxDepth must be an integer from 0 to ${MAX_CRAWL_DEPTH}.`);
    maxDepth = Math.min(input.maxDepth, MAX_CRAWL_DEPTH);
  }
  let requestIntervalMs: number | undefined;
  if (input.requestIntervalMs !== undefined && input.requestIntervalMs !== null && input.requestIntervalMs !== "") {
    if (typeof input.requestIntervalMs !== "number" || !Number.isInteger(input.requestIntervalMs) || input.requestIntervalMs < MIN_REQUEST_INTERVAL_MS || input.requestIntervalMs > MAX_REQUEST_INTERVAL_MS) throw new CrawlPolicyError(`requestIntervalMs must be an integer from ${MIN_REQUEST_INTERVAL_MS} to ${MAX_REQUEST_INTERVAL_MS}.`);
    requestIntervalMs = input.requestIntervalMs;
  }
  const allowedContentTypes = input.allowedContentTypes === undefined ? ["text/html", "application/xhtml+xml"] : patterns(input.allowedContentTypes, "allowedContentTypes").map((type) => type.toLowerCase());
  if (!allowedContentTypes.length || allowedContentTypes.some((type) => !supportedContentTypes.has(type))) throw new CrawlPolicyError("allowedContentTypes supports text/html and application/xhtml+xml only.");
  return { maxDepth, requestIntervalMs, includePatterns: patterns(input.includePatterns, "includePatterns"), excludePatterns: patterns(input.excludePatterns, "excludePatterns"), allowedContentTypes };
}

function matches(url: string, pattern: string) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(url);
}

export function allowsCrawlUrl(url: string, depth: number, policy: CrawlPolicy) {
  return !crawlUrlSkipReason(url, depth, policy);
}

export type CrawlUrlSkipReason = "depth" | "exclude_pattern" | "include_pattern";

export function crawlUrlSkipReason(url: string, depth: number, policy: CrawlPolicy): CrawlUrlSkipReason | undefined {
  if (policy.maxDepth !== undefined && depth > policy.maxDepth) return "depth";
  if (policy.excludePatterns.some((pattern) => matches(url, pattern))) return "exclude_pattern";
  if (policy.includePatterns.length && !policy.includePatterns.some((pattern) => matches(url, pattern))) return "include_pattern";
  return undefined;
}

export function allowsContentType(value: string | null, policy: CrawlPolicy) {
  const type = value?.split(";", 1)[0].trim().toLowerCase();
  return !!type && policy.allowedContentTypes.includes(type);
}
