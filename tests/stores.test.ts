import { describe, expect, it } from "vitest";
import { ManualClock } from "../src/internal/clock.js";
import { MemoryStore } from "../src/stores/memory.js";
import { RedisStore } from "../src/stores/redis.js";
import type { RedisLike } from "../src/stores/redis.js";

/**
 * The shared store.
 *
 * Two of its methods carry a security property rather than a convenience one.
 * `consumeOnce` is what makes a challenge solution single-use, so a second call
 * returning `true` is a replay; and `increment` defines the window a rate limit is
 * counted in, so a boundary it gets wrong is a limit that is quietly twice what it
 * says. Both are checked against the clock rather than against the wall.
 */

/**
 * Redis, in memory, honestly.
 *
 * Written against the same five commands `RedisLike` declares, including the two
 * behaviours the adapter's comments turn on: `SET … NX` returns `null` when the key
 * exists, and `SET` without `NX` overwrites. A double that returned `"OK"` for both
 * would agree with a broken store as readily as a correct one.
 */
function fakeRedis(): RedisLike & { readonly keys: Map<string, { value: string; expiresAt: number | undefined }>; readonly calls: string[] } {
  const keys = new Map<string, { value: string; expiresAt: number | undefined }>();
  const calls: string[] = [];
  return {
    keys,
    calls,
    async incr(key) {
      calls.push(`incr ${key}`);
      const next = Number(keys.get(key)?.value ?? "0") + 1;
      keys.set(key, { value: String(next), expiresAt: keys.get(key)?.expiresAt });
      return next;
    },
    async pexpire(key, ms) {
      calls.push(`pexpire ${key} ${ms}`);
      const entry = keys.get(key);
      if (entry) entry.expiresAt = ms;
      return 1;
    },
    async set(key, value, _mode, ttl, condition) {
      calls.push(`set ${key} ${condition ?? ""}`.trim());
      if (condition === "NX" && keys.has(key)) return null;
      keys.set(key, { value, expiresAt: ttl });
      return "OK";
    },
    async get(key) {
      return keys.get(key)?.value ?? null;
    },
    async del(key) {
      keys.delete(key);
      return 1;
    },
  };
}

describe("the redis store", () => {
  it("counts within one window and starts again in the next", async () => {
    const clock = new ManualClock(0);
    const store = new RedisStore(fakeRedis(), { clock });

    expect(await store.increment("a", 60_000)).toBe(1);
    expect(await store.increment("a", 60_000)).toBe(2);

    // Still the same fixed window at its last millisecond.
    clock.set(59_999);
    expect(await store.increment("a", 60_000)).toBe(3);

    // And a new bucket the moment it rolls over.
    clock.set(60_000);
    expect(await store.increment("a", 60_000)).toBe(1);
  });

  /** Re-arming on every increment turns a fixed window into one that never expires under load. */
  it("arms the expiry once per window, not once per request", async () => {
    const client = fakeRedis();
    const store = new RedisStore(client, { clock: new ManualClock(0) });
    for (let i = 0; i < 5; i++) await store.increment("a", 60_000);
    expect(client.calls.filter((call) => call.startsWith("pexpire"))).toHaveLength(1);
  });

  it("keeps separate keys separate", async () => {
    const store = new RedisStore(fakeRedis(), { clock: new ManualClock(0) });
    expect(await store.increment("a", 60_000)).toBe(1);
    expect(await store.increment("b", 60_000)).toBe(1);
  });

  it("claims a single-use key exactly once", async () => {
    const client = fakeRedis();
    const store = new RedisStore(client, {});
    expect(await store.consumeOnce("nonce", 60_000)).toBe(true);
    expect(await store.consumeOnce("nonce", 60_000), "a second claim is a replay").toBe(false);
    // The atomicity is in the command, so the command is the thing to assert on.
    expect(client.calls.filter((call) => call.endsWith("NX"))).toHaveLength(2);
  });

  it("overwrites on set, because a value that could not be updated is a value stuck forever", async () => {
    const client = fakeRedis();
    const store = new RedisStore(client, {});
    await store.set("k", "first", 60_000);
    await store.set("k", "second", 60_000);
    expect(await store.get("k")).toBe("second");
    expect(client.calls.filter((call) => call.startsWith("set") && call.endsWith("NX"))).toHaveLength(0);
  });

  it("reports a missing key as undefined rather than null", async () => {
    const store = new RedisStore(fakeRedis(), {});
    expect(await store.get("absent")).toBeUndefined();
  });

  it("deletes", async () => {
    const store = new RedisStore(fakeRedis(), {});
    await store.set("k", "v", 60_000);
    await store.delete("k");
    expect(await store.get("k")).toBeUndefined();
  });

  it("namespaces every key, so one redis can serve several deployments", async () => {
    const client = fakeRedis();
    const store = new RedisStore(client, { prefix: "site-a:", clock: new ManualClock(0) });
    await store.increment("k", 60_000);
    await store.set("k", "v", 60_000);
    await store.consumeOnce("k", 60_000);
    expect([...client.keys.keys()].every((key) => key.startsWith("site-a:"))).toBe(true);
    // And the three uses do not collide with each other inside that namespace.
    expect(new Set(client.keys.keys()).size).toBe(3);
  });

  it("lets a rejection from the client through, so the caller can fail open", async () => {
    const broken = { ...fakeRedis(), incr: () => Promise.reject(new Error("connection refused")) };
    await expect(new RedisStore(broken).increment("a", 60_000)).rejects.toThrow("connection refused");
  });
});

/** The same contract, on the default store, so the two cannot drift apart unnoticed. */
describe("the memory store keeps the same promises", () => {
  it("counts within one window and starts again in the next", async () => {
    const clock = new ManualClock(0);
    const store = new MemoryStore({ clock });
    expect(await store.increment("a", 60_000)).toBe(1);
    expect(await store.increment("a", 60_000)).toBe(2);
    clock.advance(60_001);
    expect(await store.increment("a", 60_000)).toBe(1);
  });

  it("claims a single-use key exactly once, and again once it has expired", async () => {
    const clock = new ManualClock(0);
    const store = new MemoryStore({ clock });
    expect(await store.consumeOnce("nonce", 1_000)).toBe(true);
    expect(await store.consumeOnce("nonce", 1_000)).toBe(false);
    clock.advance(1_001);
    expect(await store.consumeOnce("nonce", 1_000)).toBe(true);
  });

  it("expires a value rather than serving it stale", async () => {
    const clock = new ManualClock(0);
    const store = new MemoryStore({ clock });
    await store.set("k", "v", 1_000);
    expect(await store.get("k")).toBe("v");
    clock.advance(1_001);
    expect(await store.get("k")).toBeUndefined();
  });

  it("deletes", async () => {
    const store = new MemoryStore({ clock: new ManualClock(0) });
    await store.set("k", "v", 60_000);
    await store.delete("k");
    expect(await store.get("k")).toBeUndefined();
  });

  /**
   * The bound is the point — an unbounded store is a client-controlled memory leak —
   * and the eviction it implies is documented on the class rather than hidden.
   */
  it("stays bounded when a client sends unbounded distinct keys", async () => {
    const store = new MemoryStore({ maxCounters: 8, clock: new ManualClock(0) });
    for (let i = 0; i < 200; i++) await store.increment(`k${i}`, 60_000);
    expect(await store.increment("k0", 60_000), "the oldest counters are gone, not merely stale").toBe(1);
  });
});
