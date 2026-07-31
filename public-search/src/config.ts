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
  backup?: { intervalMs: number; retention: number };
};

export const MIN_BACKUP_INTERVAL_MINUTES = 15;
export const MAX_BACKUP_INTERVAL_MINUTES = 7 * 24 * 60;
export const DEFAULT_BACKUP_RETENTION = 7;
export const MAX_BACKUP_RETENTION = 365;

export function loadBackupConfig(environment: NodeJS.ProcessEnv): OperationsConfig["backup"] {
  const rawInterval = environment.PUBLIC_SEARCH_BACKUP_INTERVAL_MINUTES?.trim();
  if (!rawInterval) return undefined;
  const minutes = Number(rawInterval);
  if (!Number.isInteger(minutes) || minutes < MIN_BACKUP_INTERVAL_MINUTES || minutes > MAX_BACKUP_INTERVAL_MINUTES) throw new Error(`PUBLIC_SEARCH_BACKUP_INTERVAL_MINUTES must be an integer from ${MIN_BACKUP_INTERVAL_MINUTES} to ${MAX_BACKUP_INTERVAL_MINUTES}.`);
  const rawRetention = environment.PUBLIC_SEARCH_BACKUP_RETENTION?.trim();
  const retention = rawRetention ? Number(rawRetention) : DEFAULT_BACKUP_RETENTION;
  if (!Number.isInteger(retention) || retention < 1 || retention > MAX_BACKUP_RETENTION) throw new Error(`PUBLIC_SEARCH_BACKUP_RETENTION must be an integer from 1 to ${MAX_BACKUP_RETENTION}.`);
  return { intervalMs: minutes * 60_000, retention };
}

export const DEFAULT_CRAWLER_USER_AGENT = "AtlasPublicSearchBot/0.1 (+https://atlas.local/bot)";
export function loadCrawlerUserAgent(environment: NodeJS.ProcessEnv) {
  const value = environment.PUBLIC_SEARCH_CRAWLER_USER_AGENT?.trim();
  if (!value) return DEFAULT_CRAWLER_USER_AGENT;
  if (value.length > 240 || /[\x00-\x1f\x7f]/.test(value)) throw new Error("PUBLIC_SEARCH_CRAWLER_USER_AGENT must be printable and 240 characters or fewer.");
  return value;
}

export function loadOperationsConfig(environment: NodeJS.ProcessEnv): OperationsConfig {
  const backup = loadBackupConfig(environment);
  const rawUrl = environment.PUBLIC_SEARCH_WEBHOOK_URL?.trim();
  const secret = environment.PUBLIC_SEARCH_WEBHOOK_SECRET?.trim();
  if (!rawUrl && !secret) return backup ? { backup } : {};
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
  return { webhook: { url: url.toString(), secret, events }, ...(backup ? { backup } : {}) };
}
