import { describe, expect, it } from "vitest";
import { callerId, createRateLimiter } from "../../src/rate-limit.js";

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("token bucket", () => {
  it("allows a burst then throttles", () => {
    const c = clock();
    const limiter = createRateLimiter({ requestsPerMinute: 60, burst: 5, now: c.now });

    for (let i = 0; i < 5; i++) expect(limiter.check("k")).toBeNull();
    expect(limiter.check("k")).toBeGreaterThan(0);
  });

  it("refills continuously rather than in window jumps", () => {
    // A fixed window would let a caller spend a full quota at the end of one
    // window and again at the start of the next -- 2x the nominal rate.
    const c = clock();
    const limiter = createRateLimiter({ requestsPerMinute: 60, burst: 2, now: c.now });

    expect(limiter.check("k")).toBeNull();
    expect(limiter.check("k")).toBeNull();
    expect(limiter.check("k")).not.toBeNull();

    c.advance(1000); // 60/min == 1 token per second
    expect(limiter.check("k")).toBeNull();
    expect(limiter.check("k")).not.toBeNull();
  });

  it("never accumulates more than the burst capacity", () => {
    const c = clock();
    const limiter = createRateLimiter({ requestsPerMinute: 60, burst: 3, now: c.now });

    c.advance(600_000); // idle ten minutes
    for (let i = 0; i < 3; i++) expect(limiter.check("k")).toBeNull();
    expect(limiter.check("k")).not.toBeNull();
  });

  it("keeps callers independent", () => {
    const c = clock();
    const limiter = createRateLimiter({ requestsPerMinute: 60, burst: 1, now: c.now });

    expect(limiter.check("alice")).toBeNull();
    expect(limiter.check("alice")).not.toBeNull();
    expect(limiter.check("bob")).toBeNull();
  });

  it("reports a usable retry delay", () => {
    const c = clock();
    const limiter = createRateLimiter({ requestsPerMinute: 60, burst: 1, now: c.now });
    limiter.check("k");
    const wait = limiter.check("k");
    expect(wait).toBeGreaterThanOrEqual(1);

    c.advance(wait! * 1000);
    expect(limiter.check("k")).toBeNull();
  });

  it("is disabled at zero", () => {
    const limiter = createRateLimiter({ requestsPerMinute: 0 });
    for (let i = 0; i < 1000; i++) expect(limiter.check("k")).toBeNull();
  });
});

describe("bucket map bounds", () => {
  it("evicts idle callers so the map cannot grow without bound", () => {
    // Unauthenticated callers are keyed by a header they control, so the map
    // itself is an attack surface.
    const c = clock();
    const limiter = createRateLimiter({
      requestsPerMinute: 60,
      burst: 2,
      now: c.now,
      idleEvictionMs: 60_000,
      maxTrackedCallers: 10,
    });

    for (let i = 0; i < 10; i++) limiter.check(`ip:${i}`);
    expect(limiter.size()).toBe(10);

    c.advance(120_000);
    limiter.check("ip:new");
    expect(limiter.size()).toBeLessThanOrEqual(10);
  });

  it("sheds rather than growing when every tracked caller is active", () => {
    const c = clock();
    const limiter = createRateLimiter({
      requestsPerMinute: 60,
      burst: 5,
      now: c.now,
      maxTrackedCallers: 3,
    });

    for (let i = 0; i < 3; i++) expect(limiter.check(`ip:${i}`)).toBeNull();
    expect(limiter.check("ip:overflow")).not.toBeNull();
    expect(limiter.size()).toBeLessThanOrEqual(3);
  });
});

describe("caller identity", () => {
  it("prefers the authenticated key over any header", () => {
    expect(callerId("key_abc", "1.2.3.4")).toBe("key_abc");
  });

  it("falls back to the first forwarded IP", () => {
    expect(callerId(null, "1.2.3.4, 5.6.7.8")).toBe("ip:1.2.3.4");
    expect(callerId(null, undefined)).toBe("anonymous");
  });
});
