export type SessionTab = { title: string; url: string; closedAt?: string };
export type TabSession = { tabs: SessionTab[]; activeUrl: string; recentlyClosed: SessionTab[] };
export type SearchDateResult = { url: string; indexedAt: string };

export function clampCrawlLimit(value: number | undefined) {
  return Math.min(Math.max(Math.floor(value ?? 10), 1), 50);
}

export function normalizeSession(value: Partial<TabSession> | undefined): TabSession {
  const validTabs = (tabs: unknown): SessionTab[] => Array.isArray(tabs)
    ? tabs.filter((tab): tab is SessionTab => !!tab && typeof (tab as SessionTab).url === "string" && typeof (tab as SessionTab).title === "string").slice(0, 20)
    : [];
  return { tabs: validTabs(value?.tabs), activeUrl: typeof value?.activeUrl === "string" ? value.activeUrl : "", recentlyClosed: validTabs(value?.recentlyClosed) };
}

export function matchesSearchFilters(result: SearchDateResult, domain = "", from = "", to = "") {
  let host = "";
  try { host = new URL(result.url).hostname.toLowerCase(); } catch { return !domain; }
  const indexedDate = result.indexedAt.slice(0, 10);
  return (!domain || host.includes(domain.trim().toLowerCase())) && (!from || indexedDate >= from) && (!to || indexedDate <= to);
}

export function crawlProgressValue(indexed: number, skipped: number, failed: number, limit: number) {
  return Math.min(Math.max(indexed + skipped + failed, 0), clampCrawlLimit(limit));
}

export function noteImportKey(sourceUrl: string, quote: string, body: string) {
  return `${sourceUrl}\u0000${quote}\u0000${body}`;
}
