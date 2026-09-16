import { describe, expect, it } from "vitest";
import { BotHandler } from "../src/index.js";
import { failingResolver, makeFacts } from "./helpers.js";

describe("the registry as a list", () => {
  it("ranks the actors it is holding by how much they are asking for", async () => {
    const handler = new BotHandler({ resolver: failingResolver() });
    for (let i = 0; i < 5; i++) await handler.assess(makeFacts({ ip: "203.0.113.1", path: `/p${i}`, headers: { host: "x", "user-agent": "curl/8.4.0" } }));
    await handler.assess(makeFacts({ ip: "198.51.100.1", headers: { host: "x", "user-agent": "curl/8.4.0" } }));

    // The fixture's clock, not the wall clock: `makeFacts` timestamps every request at
    // a fixed instant, and a rate is measured against the time the requests claim.
    const top = handler.registry.top(10, 1_700_000_000_000);
    expect(top.map((actor) => actor.key)).toEqual(["203.0.113.1", "198.51.100.1"]);
    expect(top[0]!.requests).toBe(5);
    expect(top[0]!.distinctPaths).toBe(5);
    expect(top[0]!.recentRate).toBe(5);
  });

  /**
   * The registry holds `maxActors` clients and the dashboard used to be able to see only
   * the busiest page of them, which is the wrong half of the point: the feed's ring
   * already shows what is loudest, and this list exists for the population behind it.
   */
  it("pages past the busiest, by offset", async () => {
    const handler = new BotHandler({ resolver: failingResolver() });
    // Six actors, each asking for one fewer than the last, so the ranking is unambiguous.
    for (let actor = 0; actor < 6; actor++) {
      for (let request = 0; request <= 6 - actor; request++) {
        await handler.assess(makeFacts({ ip: `198.51.100.${actor}`, path: `/p${request}`, headers: { host: "x", "user-agent": "curl/8.4.0" } }));
      }
    }
    const at = 1_700_000_000_000;
    const all = handler.registry.top(10, at).map((actor) => actor.key);
    expect(all).toHaveLength(6);

    expect(handler.registry.top(2, at, 0).map((actor) => actor.key)).toEqual(all.slice(0, 2));
    expect(handler.registry.top(2, at, 2).map((actor) => actor.key)).toEqual(all.slice(2, 4));
    // A page that runs off the end is short rather than wrong, which is what tells the
    // dashboard it has reached the quiet end of the list.
    expect(handler.registry.top(4, at, 4).map((actor) => actor.key)).toEqual(all.slice(4));
    expect(handler.registry.top(2, at, 99)).toEqual([]);
    // Omitted means the front, so every existing caller keeps its behaviour.
    expect(handler.registry.top(3, at).map((actor) => actor.key)).toEqual(all.slice(0, 3));
    // A negative offset is a number somebody typed, not a request to read backwards.
    expect(handler.registry.top(2, at, -5).map((actor) => actor.key)).toEqual(all.slice(0, 2));
  });

  /** Listing the registry must not be the thing that changes it. */
  it("is a read: it records nothing and evicts nothing", async () => {
    const handler = new BotHandler({ resolver: failingResolver() });
    await handler.assess(makeFacts({ ip: "203.0.113.1", headers: { host: "x", "user-agent": "curl/8.4.0" } }));
    handler.registry.top(10, Date.now());
    handler.registry.top(10, Date.now());
    expect(handler.registry.peek("203.0.113.1")?.snapshot(1_700_000_000_000).requests).toBe(1);
    expect(handler.registry.size).toBe(1);
  });

  it("says nothing about cadence until it has enough gaps to say something", async () => {
    const handler = new BotHandler({ resolver: failingResolver() });
    await handler.assess(makeFacts({ ip: "203.0.113.1", headers: { host: "x", "user-agent": "curl/8.4.0" } }));
    expect(handler.registry.top(1, 1_700_000_000_000)[0]!.cadenceCv).toBeUndefined();
  });
});
