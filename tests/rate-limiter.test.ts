import { describe, expect, test } from "vitest";

import { RateLimitError } from "../src/errors.js";
import { RateLimiter } from "../src/rate-limiter.js";

function createClock(start = 0) {
  let current = start;
  const sleeps: number[] = [];

  return {
    sleeps,
    now: () => current,
    sleep: (milliseconds: number) => {
      sleeps.push(milliseconds);
      current += milliseconds;
      return Promise.resolve();
    },
    set: (value: number) => {
      current = value;
    },
  };
}

function createDeferredSleep() {
  const requested: number[] = [];
  const resolvers: Array<() => void> = [];

  return {
    requested,
    sleep: (milliseconds: number) => {
      requested.push(milliseconds);
      return new Promise<void>((resolve) => {
        resolvers.push(resolve);
      });
    },
    resolveNext: () => {
      const resolve = resolvers.shift();
      if (resolve === undefined) {
        throw new Error("No deferred sleep is pending");
      }
      resolve();
    },
  };
}

describe("RateLimiter", () => {
  test("allows two acquisitions and rejects the third at capacity", async () => {
    const clock = createClock(100);
    const limiter = new RateLimiter({
      maxRequests: 2,
      windowMs: 1000,
      now: clock.now,
      sleep: clock.sleep,
    });

    await limiter.acquire();
    await limiter.acquire();

    await expect(limiter.acquire()).rejects.toThrow("2 requests per 1s window");
  });

  test("does not consume a slot when an acquisition fails", async () => {
    const clock = createClock(0);
    const limiter = new RateLimiter({
      maxRequests: 2,
      windowMs: 1000,
      now: clock.now,
      sleep: clock.sleep,
    });

    await limiter.acquire();
    clock.set(100);
    await limiter.acquire();
    await expect(limiter.acquire()).rejects.toBeInstanceOf(RateLimitError);

    clock.set(1001);
    await expect(limiter.acquire()).resolves.toBeUndefined();
  });

  test("keeps a timestamp exactly at the cutoff and removes it after the window", async () => {
    const clock = createClock(1000);
    const limiter = new RateLimiter({
      maxRequests: 1,
      windowMs: 1000,
      now: clock.now,
      sleep: clock.sleep,
    });

    await limiter.acquire();
    clock.set(2000);
    await expect(limiter.acquire()).rejects.toBeInstanceOf(RateLimitError);

    clock.set(2000.001);
    await expect(limiter.acquire()).resolves.toBeUndefined();
  });

  test("sleeps for the active backoff and acquires using the advanced clock", async () => {
    const clock = createClock(1000);
    const limiter = new RateLimiter({
      maxRequests: 1,
      windowMs: 1000,
      now: clock.now,
      sleep: clock.sleep,
    });

    await limiter.acquire();
    expect(limiter.handle429(1.001)).toBe(1.001);
    clock.set(1990);

    await expect(limiter.acquire()).resolves.toBeUndefined();
    expect(clock.sleeps).toEqual([11]);
  });

  test("rechecks an extended backoff after the first sleep resolves", async () => {
    const clock = createClock();
    const deferred = createDeferredSleep();
    const limiter = new RateLimiter({
      maxRequests: 1,
      windowMs: 1000,
      now: clock.now,
      sleep: deferred.sleep,
    });

    expect(limiter.handle429(1)).toBe(1);
    const acquisition = limiter.acquire();
    await Promise.resolve();
    expect(deferred.requested).toEqual([1000]);

    expect(limiter.handle429(2)).toBe(2);
    clock.set(1000);
    deferred.resolveNext();
    await Promise.resolve();
    expect(deferred.requested).toEqual([1000, 1000]);

    clock.set(2000);
    deferred.resolveNext();
    await expect(acquisition).resolves.toBeUndefined();
  });

  test("sleeps again when injected sleep wakes before the deadline", async () => {
    let current = 0;
    let firstSleep = true;
    const sleeps: number[] = [];
    const limiter = new RateLimiter({
      maxRequests: 1,
      windowMs: 1000,
      now: () => current,
      sleep: (milliseconds: number) => {
        sleeps.push(milliseconds);
        current += firstSleep ? milliseconds - 1 : milliseconds;
        firstSleep = false;
        return Promise.resolve();
      },
    });

    expect(limiter.handle429(1)).toBe(1);
    await limiter.acquire();

    expect(sleeps).toEqual([1000, 1]);
  });

  test("uses exponential retry delays and caps them at 60 seconds", () => {
    const clock = createClock();
    const limiter = new RateLimiter({
      maxRequests: 1,
      windowMs: 1000,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(limiter.handle429()).toBe(2);
    expect(limiter.handle429()).toBe(4);
    expect(limiter.handle429()).toBe(8);

    for (let attempt = 0; attempt < 10; attempt += 1) {
      limiter.handle429();
    }
    expect(limiter.handle429()).toBe(60);
  });

  test("uses a positive explicit retry-after value for backoff", async () => {
    const clock = createClock(1000);
    const limiter = new RateLimiter({
      maxRequests: 1,
      windowMs: 1000,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(limiter.handle429(3.5)).toBe(3.5);
    clock.set(2000);
    await limiter.acquire();

    expect(clock.sleeps).toEqual([2500]);
  });

  test("does not shorten a longer active backoff with a shorter retry-after", async () => {
    const clock = createClock();
    const limiter = new RateLimiter({
      maxRequests: 1,
      windowMs: 1000,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(limiter.handle429(10)).toBe(10);
    clock.set(100);
    expect(limiter.handle429(1)).toBe(1);
    clock.set(5000);

    await limiter.acquire();

    expect(clock.sleeps).toEqual([5000]);
  });

  test("falls back to exponential delay when retry-after is zero", () => {
    const clock = createClock();
    const limiter = new RateLimiter({
      maxRequests: 1,
      windowMs: 1000,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(limiter.handle429(0)).toBe(2);
    expect(limiter.handle429()).toBe(4);
  });

  test("resetBackoff clears the count and pending sleep state", async () => {
    const clock = createClock(100);
    const limiter = new RateLimiter({
      maxRequests: 1,
      windowMs: 1000,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(limiter.handle429()).toBe(2);
    limiter.resetBackoff();

    await limiter.acquire();
    expect(clock.sleeps).toEqual([]);
    expect(limiter.handle429()).toBe(2);
  });
});
