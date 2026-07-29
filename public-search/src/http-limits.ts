export const HTTP_HEADERS_TIMEOUT_MS = 10_000;
export const HTTP_REQUEST_TIMEOUT_MS = 30_000;
export const HTTP_KEEP_ALIVE_TIMEOUT_MS = 5_000;
export const HTTP_MAX_HEADERS = 100;

type ConfigurableHttpServer = {
  headersTimeout: number;
  requestTimeout: number;
  keepAliveTimeout: number;
  maxHeadersCount: number | null;
};

export function applyHttpLimits(server: ConfigurableHttpServer) {
  server.headersTimeout = HTTP_HEADERS_TIMEOUT_MS;
  server.requestTimeout = HTTP_REQUEST_TIMEOUT_MS;
  server.keepAliveTimeout = HTTP_KEEP_ALIVE_TIMEOUT_MS;
  server.maxHeadersCount = HTTP_MAX_HEADERS;
  return server;
}
