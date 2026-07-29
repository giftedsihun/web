export function allowedCorsOrigins(environment: NodeJS.ProcessEnv) {
  const values = environment.PUBLIC_SEARCH_CORS_ORIGINS?.split(",") || [];
  const origins = new Set<string>();
  for (const value of values) {
    const candidate = value.trim();
    if (!candidate) continue;
    let url: URL;
    try { url = new URL(candidate); } catch { throw new Error("PUBLIC_SEARCH_CORS_ORIGINS must contain comma-separated HTTP(S) origins."); }
    if (!/^https?:$/.test(url.protocol) || url.origin !== candidate || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("PUBLIC_SEARCH_CORS_ORIGINS must contain comma-separated HTTP(S) origins.");
    origins.add(url.origin);
  }
  return origins;
}

export function corsResponseHeaders(origin: string | undefined, allowedOrigins: ReadonlySet<string>): Record<string, string> {
  if (!origin || !allowedOrigins.has(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    vary: "Origin",
  };
}
