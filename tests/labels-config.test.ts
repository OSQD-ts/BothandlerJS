import { describe, expect, it, vi } from "vitest";
import { BotHandler } from "../src/core.js";
import { LabelResolver } from "../src/labels.js";
import { ManualClock } from "../src/internal/clock.js";
import { createFacts } from "../src/facts.js";
import { failingResolver } from "./helpers.js";

/**
 * Naming traffic you already recognise, with the plumbing owned by the library.
 *
 * The integration that asked for this had written it themselves — an env-var format, an
 * `IpRangeSet` per entry, a per-actor cache, a bound on the cache, a relabel path, and an
 * async account lookup. That last piece is the one they were debugging in production, and
 * the tests that matter here are the ones about it.
 */

function facts(ip: string, path = "/") {
  return createFacts({ method: "GET", url: path, headers: { host: "shop.example", "user-agent": "curl/8.4.0" }, ip });
}

function handler(overrides: ConstructorParameters<typeof BotHandler>[0] = {}) {
  return new BotHandler({ resolver: failingResolver(), clock: new ManualClock(1_700_000_000_000), ...overrides });
}

describe("naming known address ranges", () => {
  it("names an actor whose address a source covers", async () => {
    const engine = handler({ labels: { sources: [{ label: "CI runner", cidrs: ["198.51.100.0/24"] }] } });
    await engine.handle(facts("198.51.100.9"));
    expect(engine.actorLabels().get("198.51.100.9")).toBe("CI runner");
  });

  it("leaves an address no source covers alone", async () => {
    const engine = handler({ labels: { sources: [{ label: "CI runner", cidrs: ["198.51.100.0/24"] }] } });
    await engine.handle(facts("203.0.113.9"));
    expect(engine.actorLabels().get("203.0.113.9")).toBeUndefined();
  });

  it("takes the first source that matches, so a narrow range can precede a broad one", async () => {
    const engine = handler({
      labels: {
        sources: [
          { label: "Build box", cidrs: ["198.51.100.9/32"] },
          { label: "Office", cidrs: ["198.51.100.0/24"] },
        ],
      },
    });
    await engine.handle(facts("198.51.100.9"));
    await engine.handle(facts("198.51.100.10"));
    expect(engine.actorLabels().get("198.51.100.9")).toBe("Build box");
    expect(engine.actorLabels().get("198.51.100.10")).toBe("Office");
  });

  it("says so when a source's addresses are not addresses", () => {
    const warnings: string[] = [];
    handler({ labels: { sources: [{ label: "Typo", cidrs: ["198.51.100.0/33"] }] }, onWarning: (message) => warnings.push(message) });
    // A range that matches nothing is a label that never appears, which reads as the
    // feature being broken rather than as the config being wrong.
    expect(warnings.join(" ")).toMatch(/never match/);
    expect(warnings.join(" ")).toMatch(/Typo/);
  });

  it("can hide a named source from the feed without hiding it from analysis", async () => {
    const engine = handler({ labels: { sources: [{ label: "Health check", cidrs: ["198.51.100.0/24"], hideFromFeed: true }] } });
    const result = await engine.handle(facts("198.51.100.9", "/healthz"));
    // Still assessed and still counted — this is a display decision, not `ignorePaths`.
    expect(result.assessment.bypass).toBeUndefined();
    expect(engine.actorLabelEntries().get("198.51.100.9")?.hideFromFeed).toBe(true);
  });

  it("never lets a name change a verdict", async () => {
    const bare = handler();
    const named = handler({ labels: { sources: [{ label: "Office", cidrs: ["198.51.100.0/24"] }] } });
    const a = await bare.assess(facts("198.51.100.9"));
    const b = await named.assess(facts("198.51.100.9"));
    expect(b.verdict).toBe(a.verdict);
    expect(b.score).toBe(a.score);
  });
});

describe("naming an actor the application has to look up", () => {
  it("names it, off the request path, for the next request", async () => {
    const engine = handler({ labels: { resolve: (key) => (key === "203.0.113.9" ? "ada@example.com" : undefined) } });
    await engine.handle(facts("203.0.113.9"));
    // Deliberately not there yet: no request waits for a name.
    await new Promise((resolve) => setImmediate(resolve));
    expect(engine.actorLabels().get("203.0.113.9")).toBe("ada@example.com");
  });

  it("asks once per actor rather than once per request", async () => {
    const resolve = vi.fn(() => "ada");
    const engine = handler({ labels: { resolve } });
    for (let i = 0; i < 5; i++) {
      await engine.handle(facts("203.0.113.9"));
      await new Promise((done) => setImmediate(done));
    }
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  /**
   * The reported bug, and the reason this module exists.
   *
   * Their version marked a key in flight and cleared the flag when the lookup finished. A
   * lookup that *failed* was fine — the catch cleared it. A lookup that **hung** never
   * finished, so the flag was never cleared, so the actor was never named: no error, no
   * log, and account ids in the feed where names should be.
   */
  it("does not strand an actor when the lookup hangs for ever", async () => {
    const clock = new ManualClock(1_700_000_000_000);
    const failures: unknown[] = [];
    let calls = 0;
    const resolver = new LabelResolver(
      {
        resolve: () => {
          calls++;
          // Never settles. Not "slow" — never.
          return new Promise<string>(() => {});
        },
        resolveTimeoutMs: 10,
        retryAfterMs: 1000,
      },
      clock,
      () => {},
      (error) => failures.push(error),
    );

    resolver.see("203.0.113.9", facts("203.0.113.9"));
    await resolver.settle();

    // It gave up, and it said so — which is the half that was silent.
    expect(failures).toHaveLength(1);
    expect(String(failures[0])).toMatch(/timed out/);

    // And the key is not stuck: once the back-off passes it is tried again, rather than
    // being held in flight for the life of the process.
    clock.advance(2000);
    resolver.see("203.0.113.9", facts("203.0.113.9"));
    expect(calls).toBe(2);
  });

  it("reports a lookup that throws, and tries again later", async () => {
    const clock = new ManualClock(1_700_000_000_000);
    const failures: unknown[] = [];
    let calls = 0;
    const resolver = new LabelResolver(
      {
        resolve: () => {
          calls++;
          throw new Error("account service is down");
        },
        retryAfterMs: 1000,
      },
      clock,
      () => {},
      (error) => failures.push(error),
    );
    resolver.see("k", facts("203.0.113.9"));
    await resolver.settle();
    expect(String(failures[0])).toMatch(/account service is down/);

    // Held off rather than hammered: an outage must not turn every request into a lookup.
    resolver.see("k", facts("203.0.113.9"));
    expect(calls).toBe(1);
    clock.advance(2000);
    resolver.see("k", facts("203.0.113.9"));
    expect(calls).toBe(2);
  });

  it("holds off on an actor it asked about and could not name", async () => {
    const clock = new ManualClock(1_700_000_000_000);
    let calls = 0;
    const resolver = new LabelResolver(
      {
        resolve: () => {
          calls++;
          return undefined;
        },
        retryAfterMs: 1000,
      },
      clock,
      () => {},
      () => {},
    );
    for (let i = 0; i < 4; i++) {
      resolver.see("k", facts("203.0.113.9"));
      await resolver.settle();
    }
    expect(calls, "an unnameable actor must not be looked up on every request").toBe(1);
    clock.advance(2000);
    resolver.see("k", facts("203.0.113.9"));
    expect(calls).toBe(2);
  });

  it("prefers a name somebody typed over one it worked out", async () => {
    const engine = handler({ labels: { sources: [{ label: "Office", cidrs: ["198.51.100.0/24"] }] } });
    await engine.handle(facts("198.51.100.9"));
    expect(engine.actorLabels().get("198.51.100.9")).toBe("Office");

    // An operator renaming an actor has said something the configuration did not know.
    engine.labelActor("198.51.100.9", "Ada's laptop");
    await engine.handle(facts("198.51.100.9"));
    expect(engine.actorLabels().get("198.51.100.9")).toBe("Ada's laptop");
  });

  it("does nothing at all when nothing is configured", async () => {
    const resolve = vi.fn();
    const engine = handler({ labels: { resolve } });
    // A dry run is not traffic, so it does not start a lookup either.
    await engine.assess(facts("203.0.113.9"), { record: false });
    await new Promise((done) => setImmediate(done));
    expect(resolve).not.toHaveBeenCalled();
  });
});
