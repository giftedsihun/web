export const MAX_REQUEST_BODY_BYTES = 64 * 1024;

export class RequestBodyTooLargeError extends Error {
  constructor() { super("Request body exceeds 64 KiB limit."); }
}

export class UnsupportedMediaTypeError extends Error {
  constructor() { super("Content-Type must be application/json."); }
}

export function requireJsonContentType(contentType: string | undefined) {
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json" && !mediaType?.endsWith("+json")) throw new UnsupportedMediaTypeError();
}

export async function readJsonBody(source: AsyncIterable<Uint8Array | string>, contentLength?: string) {
  const declaredLength = Number(contentLength);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BODY_BYTES) throw new RequestBodyTooLargeError();

  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of source) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_REQUEST_BODY_BYTES) throw new RequestBodyTooLargeError();
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}
