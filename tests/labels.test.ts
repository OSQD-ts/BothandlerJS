import { describe, expect, it } from "vitest";
import { BotHandler, createFacts, ManualClock } from "../src/index.js";
import type { RequestFacts } from "../src/types.js";

/**
 * Labels, and the two things a label can switch.
 *
 * A name on its own still changes nothing. What these cover is the pair of explicit
 * switches a label can carry — keep this actor out of the live feed, and do not analyse
 * it at all — and above all that the second one keeps working, because the obvious way
 * to build it fails silently: a skipped actor is never recorded, so if the switch lived on
 * the actor's state it would age out with that state and the actor would be judged again
 * on its next request, with nobody told.
 */
const CURL = { host: "shop.test", "user-agent": "curl/8.4.0", accept: "*/*" };

function engine(clock = new ManualClock(1_700_000_000_000)): BotHandler {
  return new BotHandler({ onWarning: () => {}, metrics: true, clock, actorWindowMs: 60_000 });
}

const request = (ip: string, at: number, path = "/"): RequestFacts => createFacts({ method: "GET", url: path, headers: CURL, ip, timestamp: at });

describe("a label that switches analysis off", () => {
  it("skips detection entirely for that actor, and says why", async () => {
    const handler = engine();
    const t = 1_700_000_000_000;
    expect((await handler.assess(request("203.0.113.10", t))).verdict, "curl, judged normally").toBe("confirmed-bot");

    handler.labelActor("203.0.113.10", { name: "our uptime monitor", skipAnalysis: true });
    const skipped = await handler.assess(request("203.0.113.10", t + 1));
    expect(skipped.bypass).toBe("label");
    expect(skipped.verdict).toBe("unknown");
    expect(skipped.evidence).toEqual([]);
    expect(handler.metrics()?.bypassed.label).toBe(1);
  });

  /**
   * The failure this is designed around. The actor is skipped, so it is never recorded,
   * so its state ages out of the registry — and the switch has to survive that.
   */
  it("keeps skipping after the actor has aged out of the registry", async () => {
    const clock = new ManualClock(1_700_000_000_000);
    const handler = engine(clock);
    await handler.assess(request("203.0.113.11", clock.now()));
    handler.labelActor("203.0.113.11", { name: "monitor", skipAnalysis: true });

    clock.set(clock.now() + 10 * 60_000);
    expect(handler.registry.peek("203.0.113.11"), "the actor itself is long gone").toBeUndefined();
    expect((await handler.assess(request("203.0.113.11", clock.now()))).bypass).toBe("label");
  });

  /** What `labelActor` was always documented as being for: labelling what you already know. */
  it("applies to an actor the handler has never seen", async () => {
    const handler = engine();
    handler.labelActor("198.51.100.200", { name: "partner feed", skipAnalysis: true });
    expect((await handler.assess(request("198.51.100.200", 1_700_000_000_000))).bypass).toBe("label");
  });

  it("stops applying once the label is removed, or forgotten", async () => {
    const handler = engine();
    const t = 1_700_000_000_000;
    handler.labelActor("203.0.113.12", { name: "monitor", skipAnalysis: true });
    handler.labelActor("203.0.113.12", undefined);
    expect((await handler.assess(request("203.0.113.12", t))).bypass).toBeUndefined();

    handler.labelActor("203.0.113.12", { name: "monitor", skipAnalysis: true });
    handler.forgetActor("203.0.113.12");
    expect((await handler.assess(request("203.0.113.12", t + 1))).bypass, "forgetting is total").toBeUndefined();
  });

  /**
   * The site's baseline is measured over the traffic it judges. An actor that is not
   * judged answering 404 all day must not move it, for the same reason an allowlisted
   * health check does not.
   */
  it("keeps a skipped actor's outcomes out of the site baseline", async () => {
    const handler = new BotHandler({ onWarning: () => {}, site: { warmupRequests: 2 } });
    handler.labelActor("203.0.113.13", { name: "monitor", skipAnalysis: true });
    for (let i = 0; i < 5; i++) {
      const facts = request("203.0.113.13", 1_700_000_000_000 + i, `/gone/${i}`);
      await handler.assess(facts);
      handler.recordOutcome(facts, 404);
    }
    expect(handler.site?.missRate ?? 0).toBe(0);
  });
});

describe("a label that only hides", () => {
  /** Hiding is a view. The request is still judged, decided and counted. */
  it("changes nothing about how the actor is judged", async () => {
    const handler = engine();
    handler.labelActor("203.0.113.14", { name: "noisy but fine", hideFromFeed: true });
    const assessed = await handler.assess(request("203.0.113.14", 1_700_000_000_000));
    expect(assessed.bypass).toBeUndefined();
    expect(assessed.verdict).toBe("confirmed-bot");
  });

  it("reports its switches, and a plain name reports none", () => {
    const handler = engine();
    handler.labelActor("203.0.113.15", { name: "hidden one", hideFromFeed: true });
    handler.labelActor("203.0.113.16", "just a name");
    expect(handler.actorLabelEntries().get("203.0.113.15")).toEqual({ name: "hidden one", hideFromFeed: true });
    expect(handler.actorLabelEntries().get("203.0.113.16")).toEqual({ name: "just a name" });
  });
});

describe("the name itself", () => {
  it("is still only a name when given as a string", async () => {
    const handler = engine();
    handler.labelActor("203.0.113.17", "a note");
    expect((await handler.assess(request("203.0.113.17", 1_700_000_000_000))).verdict).toBe("confirmed-bot");
  });

  it("follows an actor that ages out and comes back", async () => {
    const clock = new ManualClock(1_700_000_000_000);
    const handler = engine(clock);
    await handler.assess(request("203.0.113.18", clock.now()));
    handler.labelActor("203.0.113.18", "remembered");
    clock.set(clock.now() + 10 * 60_000);
    const back = await handler.assess(request("203.0.113.18", clock.now()));
    expect(back.actor.label).toBe("remembered");
  });

  /** Kept until removed, so bounded — past the limit it says so rather than dropping one. */
  it("refuses a label past the limit and warns", () => {
    const warnings: string[] = [];
    const handler = new BotHandler({ onWarning: (message) => warnings.push(message) });
    for (let i = 0; i < 10_000; i++) handler.labelActor(`k${i}`, "x");
    handler.labelActor("one-too-many", "x");
    expect(handler.actorLabels().has("one-too-many")).toBe(false);
    expect(warnings.at(-1)).toContain("which is the limit");
    // Relabelling one that exists is still allowed.
    handler.labelActor("k0", "renamed");
    expect(handler.actorLabels().get("k0")).toBe("renamed");
  });
});
