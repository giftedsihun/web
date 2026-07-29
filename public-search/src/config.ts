export function requireAdminToken(environment: NodeJS.ProcessEnv) {
  const token = environment.PUBLIC_SEARCH_ADMIN_TOKEN?.trim();
  if (!token) throw new Error("PUBLIC_SEARCH_ADMIN_TOKEN must be set before starting public-search.");
  return token;
}

export const DEFAULT_WEBHOOK_EVENTS = ["crawl.completed", "crawl.failed", "crawl.cancelled"] as const;
export const WEBHOOK_EVENTS = ["crawl.submitted", "crawl.running", "crawl.completed", "crawl.failed", "crawl.cancelled", "crawl.paused", "crawl.resumed", "crawl.restarted", "crawl.retry_queued"] as const;
export type WebhookEvent = typeof WEBHOOK_EVENTS[number];

export type OperationsConfig = {
  webhook?: { url: string; secret: string; events: ReadonlySet<WebhookEvent> };
};

export function loadOperationsConfig(environment: NodeJS.ProcessEnv): OperationsConfig {
  const rawUrl = environment.PUBLIC_SEARCH_WEBHOOK_URL?.trim();
  const secret = environment.PUBLIC_SEARCH_WEBHOOK_SECRET?.trim();
  if (!rawUrl && !secret) return {};
  if (!rawUrl || !secret) throw new Error("PUBLIC_SEARCH_WEBHOOK_URL and PUBLIC_SEARCH_WEBHOOK_SECRET must be set together.");
  if (secret.length < 16 || secret.length > 512) throw new Error("PUBLIC_SEARCH_WEBHOOK_SECRET must be between 16 and 512 characters.");

  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new Error("PUBLIC_SEARCH_WEBHOOK_URL must be an HTTPS URL."); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || rawUrl.length > 2_000) throw new Error("PUBLIC_SEARCH_WEBHOOK_URL must be an HTTPS URL without credentials or fragments.");

  const configuredEvents = environment.PUBLIC_SEARCH_WEBHOOK_EVENTS?.split(",").map((value) => value.trim()).filter(Boolean) ?? [...DEFAULT_WEBHOOK_EVENTS];
  if (!configuredEvents.length || configuredEvents.length > WEBHOOK_EVENTS.length) throw new Error("PUBLIC_SEARCH_WEBHOOK_EVENTS must contain one or more supported events.");
  const events = new Set<WebhookEvent>();
  for (const event of configuredEvents) {
    if (!(WEBHOOK_EVENTS as readonly string[]).includes(event)) throw new Error("PUBLIC_SEARCH_WEBHOOK_EVENTS contains an unsupported event.");
    events.add(event as WebhookEvent);
  }
  return { webhook: { url: url.toString(), secret, events } };
}
