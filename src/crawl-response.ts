export const MAX_ROBOTS_BYTES = 512 * 1024;
export const MAX_SITEMAP_BYTES = 2 * 1024 * 1024;
export const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;

export class CrawlResponseTooLargeError extends Error {
  constructor() { super("Crawl response exceeds the size limit."); }
}

export async function readCrawlResponseText(response: Response, maximumBytes: number) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) throw new CrawlResponseTooLargeError();
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) throw new CrawlResponseTooLargeError();
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString("utf8");
}
