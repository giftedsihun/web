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

export function koreanNgrams(value: string) {
  const normalized = value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const grams = new Set<string>();
  for (const word of normalized.split(/\s+/)) {
    if (!word) continue;
    if (word.length < 2) grams.add(word);
    for (let index = 0; index < word.length - 1; index++) grams.add(word.slice(index, index + 2));
  }
  return [...grams];
}

export function isSafeCrawlerUrl(value: string) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (!/^https?:$/.test(url.protocol) || !host || host === "localhost" || host.endsWith(".local")) return false;
    if (/^\d+(?:\.\d+){3}$/.test(host) || host.includes(":")) return isPublicIpAddress(host);
    return true;
  } catch { return false; }
}

export function isPublicIpAddress(address: string) {
  const value = address.toLowerCase().replace(/^\[|\]$/g, "");
  const ipv4 = value.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const octets = ipv4.slice(1).map(Number);
    if (octets.some((octet) => octet > 255)) return false;
    const [first, second, third] = octets;
    return first > 0 && first < 224 && first !== 10 && first !== 127 && !(first === 100 && second >= 64 && second <= 127) && !(first === 169 && second === 254) && !(first === 172 && second >= 16 && second <= 31) && !(first === 192 && (second === 0 || second === 168)) && !(first === 198 && (second === 18 || second === 19 || second === 51 && third === 100)) && !(first === 203 && second === 0 && third === 113);
  }
  if (!value.includes(":")) return false;
  // Block local, multicast, documentation, and IPv4-transition ranges that can reach private IPv4 space.
  if (value === "::" || value === "::1" || /^(?:fc|fd|fe[89ab]|ff)/.test(value) || /^2001:0?db8:/i.test(value) || /^2001:0{0,3}0:/i.test(value)) return false;
  const mapped = value.match(/^(?:::ffff:|::)(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPublicIpAddress(mapped[1]);
  return true;
}
