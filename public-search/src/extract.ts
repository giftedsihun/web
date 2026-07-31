export type ExtractedDocument = { title: string; text: string; links: string[]; canonicalUrl?: string; noindex: boolean; nofollow: boolean };

export function robotsDirectives(value: string | null | undefined) {
  const directives = new Set((value || "").toLowerCase().split(/[\s,]+/).filter(Boolean));
  return { noindex: directives.has("noindex") || directives.has("none"), nofollow: directives.has("nofollow") || directives.has("none") };
}

export function koreanNgrams(value: string) {
  const grams = new Set<string>();
  for (const word of value.toLowerCase().split(/[^\p{L}\p{N}]+/u)) { if (word.length === 1) grams.add(word); for (let index = 0; index < word.length - 1; index++) grams.add(word.slice(index, index + 2)); }
  return [...grams].join(" ");
}

const koreanSuffixes = ["으로", "에서", "에게", "까지", "부터", "처럼", "보다", "하고", "이며", "이다", "의", "은", "는", "을", "를", "이", "가", "에", "와", "과", "도", "로", "만"];
const cjkPattern = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/u;
const hangulWord = /^[가-힣]+$/u;

export function normalizeSearchToken(value: string) {
  const normalized = value.normalize("NFKC").toLowerCase();
  // Do not decompose Hangul: its syllables are the units used for Korean n-grams.
  return hangulWord.test(normalized) ? normalized : normalized.normalize("NFD").replace(/\p{M}/gu, "").normalize("NFC");
}

export function koreanStem(word: string) {
  if (!hangulWord.test(word)) return word;
  const suffix = koreanSuffixes.find((candidate) => word.endsWith(candidate) && word.length > candidate.length + 1);
  return suffix ? word.slice(0, -suffix.length) : word;
}

function characterBigrams(word: string) {
  const characters = [...word];
  if (characters.length < 2) return characters;
  return characters.flatMap((character, index) => index < characters.length - 1 ? [character, `${character}${characters[index + 1]}`] : [character]);
}

export function searchTokens(value: string) {
  const tokens = new Set<string>();
  for (const rawWord of value.match(/[\p{L}\p{N}]+/gu) || []) {
    const word = normalizeSearchToken(rawWord);
    if (!word) continue;
    tokens.add(word);
    const stem = koreanStem(word);
    if (stem !== word) tokens.add(stem);
    if (hangulWord.test(word)) characterBigrams(stem).forEach((token) => tokens.add(token));
    else if (cjkPattern.test(word)) characterBigrams(word).forEach((token) => tokens.add(token));
  }
  return [...tokens].join(" ");
}

export function searchFallbackQuery(value: string) {
  const terms: string[] = [];
  for (const rawWord of value.match(/[\p{L}\p{N}]+/gu) || []) {
    const word = normalizeSearchToken(rawWord);
    if (hangulWord.test(word)) terms.push(...characterBigrams(koreanStem(word)));
    else if (cjkPattern.test(word)) terms.push(...characterBigrams(word));
  }
  return [...new Set(terms)].join(" AND ");
}

export function needsTokenFallback(value: string) { return /[가-힣\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/u.test(value); }

export function inferDocumentLanguage(value: string): "ko" | "en" | "ja" | "zh" | "other" {
  const sample = value.slice(0, 20_000);
  const counts = { ko: (sample.match(/[가-힣]/gu) || []).length, ja: (sample.match(/[ぁ-ゟ゠-ヿ]/gu) || []).length, zh: (sample.match(/[㐀-䶿一-鿿豈-﫿]/gu) || []).length, en: (sample.match(/[a-z]/giu) || []).length };
  const [language, count] = (Object.entries(counts) as Array<["ko" | "en" | "ja" | "zh", number]>).sort((left, right) => right[1] - left[1])[0];
  return count >= 3 ? language : "other";
}

const decode = (value: string) => value.replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, "\"").replace(/&#39;/gi, "'");
const plainText = (value: string) => decode(value.replace(/<script\b[^>]*>[\s\S]*?<\/script>|<style\b[^>]*>[\s\S]*?<\/style>|<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());

export function canonicalize(value: string) {
  const url = new URL(value);
  url.hash = "";
  url.username = "";
  url.password = "";
  for (const key of [...url.searchParams.keys()]) {
    if (/^utm_(?:source|medium|campaign|term|content|id)$/i.test(key) || /^(?:fbclid|gclid|dclid|msclkid|mc_[a-z]+)$/i.test(key)) url.searchParams.delete(key);
  }
  if (url.pathname === "/") url.pathname = "";
  return url.toString();
}

export function isPublicWebUrl(value: string) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (!/^https?:$/.test(url.protocol) || !host || host === "localhost" || host.endsWith(".local")) return false;
    return !(/^\d+(?:\.\d+){3}$/.test(host) || host.includes(":")) || isPublicIpAddress(host);
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

function sitemapLocations(xml: string, sourceUrl: string) {
  const locations: string[] = [];
  for (const match of xml.matchAll(/<loc\b[^>]*>([\s\S]*?)<\/loc>/gi)) {
    try {
      const url = canonicalize(new URL(match[1].trim(), sourceUrl).toString());
      if (isPublicWebUrl(url) && !locations.includes(url)) locations.push(url);
    } catch { /* Ignore malformed sitemap locations. */ }
  }
  return locations.slice(0, 5_000);
}

export function sitemapEntries(xml: string, sourceUrl: string) {
  const locations = sitemapLocations(xml, sourceUrl);
  // Sitemap indexes contain sitemap locations, while urlsets contain page locations.
  return /<sitemapindex\b/i.test(xml) ? { urls: [], sitemaps: locations } : { urls: locations, sitemaps: [] };
}

export function sitemapUrls(xml: string, sourceUrl: string) {
  return sitemapEntries(xml, sourceUrl).urls;
}

export function extractDocument(html: string, sourceUrl: string): ExtractedDocument {
  const title = plainText(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || new URL(sourceUrl).hostname).slice(0, 300);
  const canonical = html.match(/<link\b[^>]*rel=["'][^"']*\bcanonical\b[^"']*["'][^>]*href=["']([^"']+)["']/i)?.[1];
  const links: string[] = [];
  for (const match of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["']/gi)) {
    try {
      const url = canonicalize(new URL(match[1], sourceUrl).toString());
      if (/^https?:$/.test(new URL(url).protocol) && !links.includes(url)) links.push(url);
    } catch { /* Skip malformed URLs. */ }
  }
  let canonicalUrl: string | undefined;
  try { if (canonical) canonicalUrl = canonicalize(new URL(canonical, sourceUrl).toString()); } catch { /* Use source URL. */ }
  const robots = [...html.matchAll(/<meta\b[^>]*>/gi)].map((match) => {
    const tag = match[0];
    const name = tag.match(/\bname\s*=\s*(?:["']robots["']|robots\b)/i);
    const content = tag.match(/\bcontent\s*=\s*["']([^"']*)["']/i)?.[1];
    return name && content ? content.toLowerCase() : "";
  }).join(",");
  const directives = robotsDirectives(robots);
  return { title, text: plainText(html).slice(0, 100_000), links: links.slice(0, 300), canonicalUrl, ...directives };
}
