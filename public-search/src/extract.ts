export type ExtractedDocument = { title: string; text: string; links: string[]; canonicalUrl?: string; noindex: boolean; nofollow: boolean };

export function koreanNgrams(value: string) {
  const grams = new Set<string>();
  for (const word of value.toLowerCase().split(/[^\p{L}\p{N}]+/u)) { if (word.length === 1) grams.add(word); for (let index = 0; index < word.length - 1; index++) grams.add(word.slice(index, index + 2)); }
  return [...grams].join(" ");
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
  const robots = [...html.matchAll(/<meta\b[^>]*(?:name\s*=\s*["']robots["']|name\s*=\s*robots)[^>]*content\s*=\s*["']([^"']*)["'][^>]*>/gi)].map((match) => match[1].toLowerCase()).join(",");
  const directives = new Set(robots.split(/[\s,]+/).filter(Boolean));
  return { title, text: plainText(html).slice(0, 100_000), links: links.slice(0, 300), canonicalUrl, noindex: directives.has("noindex"), nofollow: directives.has("nofollow") };
}
