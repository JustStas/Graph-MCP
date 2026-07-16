import { RateLimitError } from "./errors.js";

export interface RateLimiterOptions {
  maxRequests: number;
  windowMs: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

const defaultNow = (): number => Number(process.hrtime.bigint()) / 1_000_000;

const defaultSleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

const MAX_TIMER_DELAY_MS = 2_147_483_647;

export class RateLimiter {
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly timestamps: number[] = [];
  private backoffUntil = 0;
  private backoffCount = 0;

  constructor(options: RateLimiterOptions) {
    this.maxRequests = options.maxRequests;
    this.windowMs = options.windowMs;
    this.now = options.now ?? defaultNow;
    this.sleep = options.sleep ?? defaultSleep;
  }

  async acquire(): Promise<void> {
    let now = this.now();
    while (now < this.backoffUntil) {
      await this.sleep(this.backoffUntil - now);
      now = this.now();
    }

    const cutoff = now - this.windowMs;
    while (this.timestamps.length > 0) {
      const timestamp = this.timestamps[0];
      if (timestamp === undefined || timestamp >= cutoff) {
        break;
      }
      this.timestamps.shift();
    }

    if (this.timestamps.length >= this.maxRequests) {
      throw new RateLimitError(
        `Rate limit exceeded: ${this.maxRequests} requests per ${this.windowMs / 1000}s window`,
      );
    }

    this.timestamps.push(this.now());
  }

  handle429(retryAfterSeconds?: number): number {
    this.backoffCount += 1;
    const retryAfterMilliseconds =
      retryAfterSeconds !== undefined && Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
        ? Math.min(retryAfterSeconds * 1000, MAX_TIMER_DELAY_MS)
        : undefined;
    const delayMilliseconds = retryAfterMilliseconds ?? Math.min(2 ** this.backoffCount, 60) * 1000;
    const now = this.now();
    const proposedDeadline = now + delayMilliseconds;
    this.backoffUntil = Math.max(this.backoffUntil, proposedDeadline);
    return (this.backoffUntil - now) / 1000;
  }

  resetBackoff(): void {
    this.backoffCount = 0;
    this.backoffUntil = 0;
  }
}
