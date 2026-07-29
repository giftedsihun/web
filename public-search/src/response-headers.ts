export const API_SECURITY_HEADERS = {
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  "cross-origin-resource-policy": "same-site",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
} as const;

export function apiResponseHeaders(headers: Record<string, string> = {}) {
  return { ...API_SECURITY_HEADERS, ...headers };
}
