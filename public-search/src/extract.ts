export type ExtractedDocument = { title: string; text: string; links: string[]; canonicalUrl?: string };

const decode = (value: string) => value.replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, "\"").replace(/&#39;/gi, "'");
const plainText = (value: string) => decode(value.replace(/<script\b[^>]*>[\s\S]*?<\/script>|<style\b[^>]*>[\s\S]*?<\/style>|<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());

export function canonicalize(value: string) {
  const url = new URL(value);
  url.hash = "";
  url.username = "";
  url.password = "";
  if (url.pathname === "/") url.pathname = "";
  return url.toString();
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
  return { title, text: plainText(html).slice(0, 100_000), links: links.slice(0, 300), canonicalUrl };
}
