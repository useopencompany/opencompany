export type RateLimitDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

export interface ApiRateLimiter {
  consume(input: {
    key: string;
    bucket: string;
    limit: number;
    windowMs: number;
  }): RateLimitDecision | Promise<RateLimitDecision>;
}

type Counter = { count: number; resetAt: number };

// This protects an instance from accidental or abusive bursts. It is deliberately not a new
// durability dependency: authorization, billing, and command idempotency remain authoritative in
// Postgres, so losing these counters can only relax a defense-in-depth limit after a restart.
export class InMemoryApiRateLimiter implements ApiRateLimiter {
  private readonly counters = new Map<string, Counter>();

  constructor(private readonly now: () => number = Date.now) {}

  consume(input: {
    key: string;
    bucket: string;
    limit: number;
    windowMs: number;
  }): RateLimitDecision {
    const now = this.now();
    const counterKey = `${input.bucket}:${input.key}`;
    const prior = this.counters.get(counterKey);
    const counter =
      !prior || prior.resetAt <= now ? { count: 0, resetAt: now + input.windowMs } : prior;
    counter.count += 1;
    this.counters.set(counterKey, counter);
    if (counter.count <= input.limit) return { allowed: true };
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((counter.resetAt - now) / 1_000)),
    };
  }
}
