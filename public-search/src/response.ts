export const MAX_ROBOTS_BYTES = 512 * 1024;
export const MAX_SITEMAP_BYTES = 2 * 1024 * 1024;
export const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;

export class ResponseBodyTooLargeError extends Error {
  constructor() { super("Response body exceeds the crawler size limit."); }
}

export async function readResponseText(response: Response, maximumBytes: number) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) throw new ResponseBodyTooLargeError();
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) throw new ResponseBodyTooLargeError();
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString("utf8");
}
