export type SearchSort = "relevance" | "newest";
export type SearchLanguage = "ko" | "en" | "ja" | "zh" | "other";
export type SearchDocumentType = "html" | "xhtml";
export class SearchOptionsError extends Error {}

export function normalizeSearchSort(value: string | null): SearchSort {
  if (!value || value === "relevance") return "relevance";
  if (value === "newest") return "newest";
  throw new SearchOptionsError("sort must be relevance or newest.");
}

export function normalizeSearchDomain(value: string | null) {
  if (!value) return undefined;
  const domain = value.trim().toLowerCase();
  if (!domain || domain.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(domain)) throw new SearchOptionsError("domain must be a valid hostname.");
  return domain;
}

export function normalizeSearchLanguage(value: string | null): SearchLanguage | undefined {
  if (!value) return undefined;
  if (["ko", "en", "ja", "zh", "other"].includes(value)) return value as SearchLanguage;
  throw new SearchOptionsError("language must be ko, en, ja, zh, or other.");
}

export function normalizeSearchDocumentType(value: string | null): SearchDocumentType | undefined {
  if (!value) return undefined;
  if (value === "html" || value === "xhtml") return value;
  throw new SearchOptionsError("documentType must be html or xhtml.");
}

export function normalizeSearchDate(value: string | null, name: "from" | "to") {
  if (!value) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new SearchOptionsError(`${name} must be an ISO date (YYYY-MM-DD).`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new SearchOptionsError(`${name} must be an ISO date (YYYY-MM-DD).`);
  return value;
}

export function ensureSearchDateRange(from?: string, to?: string) {
  if (from && to && from > to) throw new SearchOptionsError("from must be on or before to.");
}
