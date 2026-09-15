// Per-client-IP lockout for credential failures (access code, X-API-Key, bearer tokens).
// The secrets are long random strings, so this is belt-and-braces against online guessing
// and against a leaked-but-rotated key being hammered; it is not a general request limiter.
import { IncomingMessage } from 'node:http';

export interface FailureLimiterOptions {
  /** Failures allowed per IP inside the window before requests are refused. */
  maxFailures: number;
  windowMs: number;
}

export class FailureLimiter {
  private readonly failures = new Map<string, number[]>();

  constructor(private readonly options: FailureLimiterOptions) {}

  /** True when this IP has exhausted its failures for the current window. */
  isBlocked(ip: string, now = Date.now()): boolean {
    return this.recent(ip, now).length >= this.options.maxFailures;
  }

  recordFailure(ip: string, now = Date.now()): void {
    this.failures.set(ip, [...this.recent(ip, now), now]);
  }

  private recent(ip: string, now: number): number[] {
    const cutoff = now - this.options.windowMs;
    const kept = (this.failures.get(ip) ?? []).filter((at) => at > cutoff);
    if (kept.length === 0) this.failures.delete(ip);
    else this.failures.set(ip, kept);
    return kept;
  }

  /** Drops expired entries so idle IPs don't accumulate. */
  prune(now = Date.now()): void {
    for (const ip of this.failures.keys()) this.recent(ip, now);
  }
}

/**
 * The connecting client's IP. Behind Heroku's router the real client is the *last*
 * X-Forwarded-For entry (the router appends it), so client-supplied entries can't spoof it.
 */
export function clientIp(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  const raw = Array.isArray(forwarded) ? forwarded.join(',') : forwarded;
  const last = raw?.split(',').pop()?.trim();
  return last || req.socket.remoteAddress || 'unknown';
}
