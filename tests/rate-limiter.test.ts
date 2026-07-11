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
