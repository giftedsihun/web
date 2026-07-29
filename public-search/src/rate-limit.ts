type WindowEntry = { startedAt: number; count: number };

export type RateLimitResult = { allowed: true } | { allowed: false; retryAfterSeconds: number };

export class FixedWindowRateLimiter {
  private readonly entries = new Map<string, WindowEntry>();

  constructor(private readonly limit: number, private readonly windowMs: number, private readonly maximumEntries = 10_000) {}

  check(key: string, now = Date.now()): RateLimitResult {
    const entry = this.entries.get(key);
    if (!entry || now - entry.startedAt >= this.windowMs) {
      this.prune(now);
      this.entries.set(key, { startedAt: now, count: 1 });
      return { allowed: true };
    }
    if (entry.count >= this.limit) return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((this.windowMs - (now - entry.startedAt)) / 1_000)) };
    entry.count += 1;
    return { allowed: true };
  }

  private prune(now: number) {
    for (const [key, entry] of this.entries) if (now - entry.startedAt >= this.windowMs) this.entries.delete(key);
    while (this.entries.size >= this.maximumEntries) this.entries.delete(this.entries.keys().next().value!);
  }
}
