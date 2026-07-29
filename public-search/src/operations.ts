import { createHmac } from "node:crypto";
import type { OperationsConfig, WebhookEvent } from "./config";
import type { CrawlJob } from "./types";

export const MAX_WEBHOOK_QUEUE = 100;
export const MAX_WEBHOOK_PAYLOAD_BYTES = 8_192;
export const WEBHOOK_TIMEOUT_MS = 5_000;

type OperationsEvent = { event: WebhookEvent; occurredAt: string; job: Record<string, unknown> };
type LogSink = (entry: Record<string, unknown>) => void;
type Fetcher = typeof fetch;

function boundedText(value: unknown, maximum: number) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, maximum) : undefined;
}

function publicJob(job: CrawlJob) {
  return {
    id: boundedText(job.id, 100),
    status: job.status,
    seedHost: new URL(job.seedUrl).host.slice(0, 253),
    maxPages: job.maxPages,
    indexed: job.indexed,
    skipped: job.skipped,
    failed: job.failed,
    error: boundedText(job.error, 500),
  };
}

export function operationPayload(event: WebhookEvent, job: CrawlJob, occurredAt = new Date().toISOString()) {
  const payload: OperationsEvent = { event, occurredAt, job: publicJob(job) };
  const encoded = JSON.stringify(payload);
  if (Buffer.byteLength(encoded) > MAX_WEBHOOK_PAYLOAD_BYTES) throw new Error("Webhook payload exceeded its safety limit.");
  return encoded;
}

export class OperationsReporter {
  private readonly pending: Array<{ event: WebhookEvent; payload: string }> = [];
  private sending: Promise<void> | undefined;

  constructor(private readonly config: OperationsConfig, private readonly log: LogSink = (entry) => console.log(JSON.stringify(entry)), private readonly fetcher: Fetcher = fetch) {}

  emit(event: WebhookEvent, job: CrawlJob) {
    const occurredAt = new Date().toISOString();
    const payload = operationPayload(event, job, occurredAt);
    this.log({ event, occurredAt, jobId: job.id, status: job.status, indexed: job.indexed, skipped: job.skipped, failed: job.failed });
    if (!this.config.webhook?.events.has(event)) return;
    if (this.pending.length >= MAX_WEBHOOK_QUEUE) {
      this.log({ event: "webhook.dropped", occurredAt, reason: "queue_full", alertEvent: event, jobId: job.id });
      return;
    }
    this.pending.push({ event, payload });
    if (!this.sending) setImmediate(() => { void this.flush(); });
  }

  async flush() {
    if (this.sending) return this.sending;
    this.sending = this.deliver();
    try { await this.sending; } finally { this.sending = undefined; }
  }

  private async deliver() {
    while (this.pending.length) {
      const alert = this.pending.shift()!;
      const webhook = this.config.webhook;
      if (!webhook) return;
      const timestamp = String(Math.floor(Date.now() / 1_000));
      const signature = createHmac("sha256", webhook.secret).update(`${timestamp}.${alert.payload}`).digest("hex");
      try {
        const response = await this.fetcher(webhook.url, { method: "POST", headers: { "content-type": "application/json", "x-atlas-event": alert.event, "x-atlas-timestamp": timestamp, "x-atlas-signature": `sha256=${signature}` }, body: alert.payload, signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS) });
        if (!response.ok) this.log({ event: "webhook.failed", status: response.status, alertEvent: alert.event });
      } catch {
        this.log({ event: "webhook.failed", reason: "delivery_error", alertEvent: alert.event });
      }
    }
  }
}
