import { describe, expect, it } from "vitest";
import { BotHandler, createFacts } from "../src/index.js";
import type { Assessment, Evidence, RequestFacts } from "../src/types.js";
import { SiteProfile } from "../src/site/index.js";
import { distributedWalkDetector, missBaselineDetector } from "../src/detectors/site-baseline.js";
import { ManualClock } from "../src/internal/clock.js";
import { ActorState } from "../src/state.js";
import { makeContext } from "./helpers.js";
import { systemClock } from "../src/internal/clock.js";

/**
 * Comparing a client with the rest of the traffic.
 *
 * These detectors answer questions a fixed rule cannot — is this path one anybody else
 * has ever asked for, is this miss rate unusual *here*, is this range being walked by
 * five hundred clients none of which walks enough of it to notice. The power and the
 * danger are the same thing: the answer depends on everybody else, so a mistake lands on
 * everybody at once.
 *
 * So roughly half of what follows is about the cases that must stay quiet. A popular
 * catalogue looks a great deal like an enumeration if you only count clients and ids,
 * and a site mid-migration looks like a scanner if you only count misses.
 */
const BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const HEADERS = { host: "shop.test", accept: "text/html,application/xhtml+xml", "accept-language": "en-GB,en;q=0.9", "user-agent": BROWSER };

/** A warmup small enough to run in a test and large enough to be a real gate. */
const WARMUP = 200;

function engine(site: Record<string, unknown> | false = { warmupRequests: WARMUP }): BotHandler {
  return new BotHandler({ onWarning: () => {}, metrics: false, ...(site === false ? {} : { site }) });
}

function request(path: string, ip: string, at = 1_700_000_000_000): RequestFacts {
  return createFacts({ method: "GET", url: path, headers: HEADERS, ip, timestamp: at });
}

const found = (assessment: Assessment, id: string): Evidence | undefined => assessment.evidence.find((item) => item.detector === id);

/** Ordinary traffic, so the profile has something to be a baseline of. */
async function warm(handler: BotHandler, at = 1_700_000_000_000): Promise<void> {
  for (let i = 0; i < WARMUP + 20; i++) {
    const facts = request(`/warm/${i % 40}`, `192.0.2.${(i % 200) + 1}`, at + i);
    await handler.assess(facts);
    handler.recordOutcome(facts, 200);
  }
}

describe("before it knows anything", () => {
  it("says nothing at all while the profile is cold", async () => {
    // Every path is novel when none has been seen, so a profile consulted early does not
    // merely fail — it fails confidently, about everybody.
    const handler = engine();
    let assessment: Assessment | undefined;
    for (let i = 0; i < 60; i++) assessment = await handler.assess(request(`/never-seen/${i}`, "203.0.113.9", 1_700_000_000_000 + i));
    expect(found(assessment as Assessment, "path-novelty")).toBeUndefined();
  });

  /**
   * The same for the walk, which has its own reason to be careful.
   *
   * A cold profile has walk records — they are filed from the first request — but no
   * baseline to read them against, so `spreadOf` withholds them entirely. Sixty requests
   * marching straight up a numeric range is the most walk-shaped traffic there is, and
   * while the profile is cold it is still sixty requests the site has no opinion about.
   */
  it("says nothing about a walk while the profile is cold", async () => {
    const handler = engine();
    let assessment: Assessment | undefined;
    for (let i = 1; i <= 60; i++) assessment = await handler.assess(request(`/product/${i}`, `198.51.100.${i}`, 1_700_000_000_000 + i));
    expect(found(assessment as Assessment, "distributed-walk")).toBeUndefined();
  });

  it("is absent entirely when no profile is configured", async () => {
    const handler = engine(false);
    const installed = handler.describeDetectors().map((entry) => entry.id);
    expect(installed).not.toContain("path-novelty");
    expect(installed).not.toContain("distributed-walk");
    expect(installed).not.toContain("miss-baseline");
  });
});

describe("an enumeration split across many clients", () => {
  it("sees a range walked by clients that individually walk almost none of it", async () => {
    // The threat every per-actor threshold misses by construction: 40 clients take 10 ids
    // each, so nobody trips `id-enumeration`, and the range is still walked end to end.
    const handler = engine();
    await warm(handler);

    let assessment: Assessment | undefined;
    let at = 1_700_000_100_000;
    for (let actor = 0; actor < 40; actor++) {
      for (let step = 0; step < 10; step++) {
        assessment = await handler.assess(request(`/user/${actor * 10 + step}`, `198.51.100.${actor + 1}`, (at += 500)));
      }
    }

    const walk = found(assessment as Assessment, "distributed-walk");
    expect(walk?.certainty).toBe("moderate");
    expect(walk?.botClass).toBe("scraper");
    expect(walk?.summary).toContain("/user/#");
    // Nobody walked enough alone for the per-actor detector to have fired.
    expect(found(assessment as Assessment, "id-enumeration")).toBeUndefined();
  });

  it("leaves a popular catalogue alone", async () => {
    // Many clients on numbered pages is what a shop is. What a shop also has, and an
    // enumeration does not, is people returning to the same popular items.
    const handler = engine();
    await warm(handler);

    const popular = [3, 7, 11, 19, 23];
    let assessment: Assessment | undefined;
    let at = 1_700_000_100_000;
    for (let visitor = 0; visitor < 60; visitor++) {
      for (let view = 0; view < 8; view++) {
        const id = popular[(visitor + view) % popular.length] as number;
        assessment = await handler.assess(request(`/product/${id}`, `198.51.100.${visitor + 1}`, (at += 400)));
      }
    }
    expect(found(assessment as Assessment, "distributed-walk")).toBeUndefined();
  });

  it("leaves a range that is sampled rather than covered alone", async () => {
    const handler = engine();
    await warm(handler);
    let assessment: Assessment | undefined;
    let at = 1_700_000_100_000;
    // 40 clients, a wide range, but only a scattering of it actually requested.
    for (let actor = 0; actor < 40; actor++) {
      for (let step = 0; step < 6; step++) {
        assessment = await handler.assess(request(`/order/${(actor * 97 + step * 31) % 20_000}`, `198.51.100.${actor + 1}`, (at += 500)));
      }
    }
    expect(found(assessment as Assessment, "distributed-walk")).toBeUndefined();
  });
});

describe("paths nobody else has ever asked for", () => {
  it("reports a client walking a list this site has never served", async () => {
    const handler = engine();
    await warm(handler);

    let assessment: Assessment | undefined;
    let at = 1_700_000_200_000;
    for (let i = 0; i < 40; i++) {
      assessment = await handler.assess(request(`/wp-content/plugins/thing-${i}/readme.txt`, "203.0.113.44", (at += 700)));
    }

    const novelty = found(assessment as Assessment, "path-novelty");
    expect(novelty?.certainty).toBe("moderate");
    expect(novelty?.summary).toContain("no other client has ever asked");
  });

  it("leaves a visitor reading pages other people also read alone", async () => {
    const handler = engine();
    await warm(handler);
    let assessment: Assessment | undefined;
    let at = 1_700_000_200_000;
    for (let i = 0; i < 40; i++) assessment = await handler.assess(request(`/warm/${i % 40}`, "203.0.113.45", (at += 700)));
    expect(found(assessment as Assessment, "path-novelty")).toBeUndefined();
  });

  it("tolerates a visitor whose path is occasionally new", async () => {
    // A search page, a per-article slug, a long-tail item nobody has viewed this hour.
    // The share is the signal; a novel path now and then is ordinary.
    const handler = engine();
    await warm(handler);
    let assessment: Assessment | undefined;
    let at = 1_700_000_200_000;
    for (let i = 0; i < 40; i++) {
      const path = i % 4 === 0 ? `/article/brand-new-${i}` : `/warm/${i % 40}`;
      assessment = await handler.assess(request(path, "203.0.113.46", (at += 700)));
    }
    expect(found(assessment as Assessment, "path-novelty")).toBeUndefined();
  });
});

describe("missing more than this site's visitors do", () => {
  it("reports a client whose miss rate dwarfs the site's", async () => {
    const handler = engine();
    await warm(handler);

    let assessment: Assessment | undefined;
    let at = 1_700_000_300_000;
    for (let i = 0; i < 30; i++) {
      const facts = request(`/admin-${i}.php`, "203.0.113.50", (at += 600));
      assessment = await handler.assess(facts);
      handler.recordOutcome(facts, 404);
    }

    const miss = found(assessment as Assessment, "miss-baseline");
    expect(miss?.certainty).toBe("moderate");
    expect(miss?.summary).toContain("across the site");
  });

  it("says nothing when the whole site is missing that often", async () => {
    // Mid-migration, half the URLs are gone. A fixed threshold reports everybody here;
    // comparing against the site's own rate is the entire point.
    const handler = engine();
    let at = 1_700_000_000_000;
    for (let i = 0; i < WARMUP + 20; i++) {
      const facts = request(`/warm/${i % 40}`, `192.0.2.${(i % 200) + 1}`, (at += 100));
      await handler.assess(facts);
      handler.recordOutcome(facts, i % 10 < 7 ? 404 : 200);
    }

    let assessment: Assessment | undefined;
    for (let i = 0; i < 30; i++) {
      const facts = request(`/warm/${i % 40}`, "203.0.113.51", (at += 600));
      assessment = await handler.assess(facts);
      handler.recordOutcome(facts, 404);
    }
    expect(found(assessment as Assessment, "miss-baseline")).toBeUndefined();
  });
});

/**
 * The bitmap that holds a walk.
 *
 * Ids are held as 1024 bits over the range rather than as a set of numbers, because a
 * client picks its own paths and therefore picks how many shapes exist — `/anything/1`
 * creates one. Holding the ids measured at 45 MB for a table anybody could fill on
 * purpose; the bitmap is 128 bytes however wide the range gets, and coarsens rather than
 * grows. What follows is the arithmetic surviving that coarsening, which is the part
 * that can silently stop working.
 */
describe("how a walk is remembered", () => {
  const profile = (): SiteProfile => {
    const made = new SiteProfile({ clock: systemClock, warmupRequests: 1 });
    made.record("/warm", "seed");
    return made;
  };

  it("reads a full range as fully covered, whatever the scale", () => {
    const wide = profile();
    for (let i = 0; i < 20_000; i++) wide.recordWalk("/user/#", i, `a${i % 64}`);
    const spread = wide.spreadOf("/user/#");
    expect(spread?.coverage).toBe(1);
    // Coarsened, and the estimate of how many ids that stands for is still right.
    expect(spread?.scale).toBeGreaterThan(1);
    expect(spread?.ids).toBe(20_000);
  });

  it("keeps the revisit ratio meaningful after coarsening", () => {
    // The trap: once a bucket stands for 32 ids, comparing visits with *buckets* reads a
    // clean enumeration as 32 visits apiece, and the bigger the walk the more certainly
    // it is missed. The ratio has to be against the ids the buckets stand for.
    const wide = profile();
    for (let i = 0; i < 20_000; i++) wide.recordWalk("/user/#", i, `a${i % 64}`);
    const spread = wide.spreadOf("/user/#");
    expect((spread as { visits: number }).visits / (spread as { ids: number }).ids).toBeCloseTo(1, 5);
  });

  it("is exact while the range still fits", () => {
    const narrow = profile();
    for (let i = 0; i < 400; i++) narrow.recordWalk("/user/#", i, "a");
    const spread = narrow.spreadOf("/user/#");
    expect(spread?.scale).toBe(1);
    expect(spread?.ids).toBe(400);
    expect(spread?.coverage).toBe(1);
  });

  it("does not read scattered requests as a covered range", () => {
    const scattered = profile();
    for (let i = 0; i < 200; i++) scattered.recordWalk("/user/#", (i * 977) % 100_000, "a");
    expect(scattered.spreadOf("/user/#")?.coverage).toBeLessThan(0.4);
  });

  it("does not grow with the range a client asks for", () => {
    // The property the whole structure exists for.
    const huge = profile();
    for (let i = 0; i < 5000; i++) huge.recordWalk("/user/#", i * 2000, "a");
    const spread = huge.spreadOf("/user/#");
    expect(spread?.buckets).toBeLessThanOrEqual(1024);
  });
});

describe("a path nobody had ever asked for that everybody suddenly wants", () => {
  it("reports a probe arriving from many unrelated clients at once", async () => {
    const handler = engine();
    await warm(handler);

    let assessment: Assessment | undefined;
    let at = 1_700_000_400_000;
    // The shape of a freshly disclosed vulnerability: one new URL, many clients, one
    // request each, and nothing there to serve them.
    for (let client = 0; client < 20; client++) {
      const facts = request("/_ignition/execute-solution", `198.51.101.${client + 1}`, (at += 3000));
      assessment = await handler.assess(facts);
      handler.recordOutcome(facts, 404);
    }

    const campaign = found(assessment as Assessment, "path-campaign");
    expect(campaign?.certainty).toBe("moderate");
    expect(campaign?.summary).toContain("unrelated clients");
  });

  it("leaves a launch alone", async () => {
    // The case that makes counting clients alone useless: a page goes up, a newsletter
    // goes out, and a path that did not exist yesterday is requested by everybody. What
    // separates it from a probe is that the site actually has something to serve.
    const handler = engine();
    await warm(handler);

    let assessment: Assessment | undefined;
    let at = 1_700_000_400_000;
    for (let visitor = 0; visitor < 30; visitor++) {
      const facts = request("/blog/the-new-thing", `198.51.102.${visitor + 1}`, (at += 3000));
      assessment = await handler.assess(facts);
      handler.recordOutcome(facts, 200);
    }
    expect(found(assessment as Assessment, "path-campaign")).toBeUndefined();
  });

  it("says nothing about one client poking at one new path", async () => {
    const handler = engine();
    await warm(handler);
    let assessment: Assessment | undefined;
    let at = 1_700_000_400_000;
    for (let i = 0; i < 20; i++) {
      const facts = request("/.env", "198.51.103.9", (at += 1000));
      assessment = await handler.assess(facts);
      handler.recordOutcome(facts, 404);
    }
    // One client is `path-novelty`'s business, not this detector's.
    expect(found(assessment as Assessment, "path-campaign")).toBeUndefined();
  });

  it("does not watch a path the site has always served", async () => {
    // Only newly-appeared paths are watched, which is what keeps the table small and
    // what stops a busy old page reading as a surge.
    const handler = engine();
    await warm(handler);
    let assessment: Assessment | undefined;
    let at = 1_700_000_400_000;
    for (let client = 0; client < 20; client++) {
      const facts = request("/warm/3", `198.51.104.${client + 1}`, (at += 3000));
      assessment = await handler.assess(facts);
      handler.recordOutcome(facts, 404);
    }
    expect(found(assessment as Assessment, "path-campaign")).toBeUndefined();
  });
});

/**
 * The baseline has to be measured over the traffic it judges.
 *
 * Adapters report an outcome for every response, including the ones detection never
 * looked at, while `assess` returns early for an allowlisted address or an ignored path.
 * Left asymmetric, a health check or an asset path answering 404 all day sets the
 * baseline that decides whether anybody else's misses are unusual — measured, a run in
 * which every judged request was answered 200 reported a site miss rate of 0.89.
 */
describe("what counts towards the baseline", () => {
  it("ignores the outcomes of traffic it never judged", async () => {
    const handler = new BotHandler({
      onWarning: () => {},
      metrics: false,
      site: { warmupRequests: 10 },
      allowlist: ["192.0.2.0/24"],
      ignorePaths: ["/health"],
    });

    let at = 1_700_000_000_000;
    const answer = async (path: string, ip: string, status: number): Promise<void> => {
      const facts = createFacts({ method: "GET", url: path, headers: HEADERS, ip, timestamp: (at += 100) });
      await handler.assess(facts);
      handler.recordOutcome(facts, status);
    };

    for (let i = 0; i < 30; i++) await answer(`/page-${i}`, "203.0.113.5", 200);
    // Neither of these is assessed, so neither may shape the baseline.
    for (let i = 0; i < 60; i++) await answer("/health", "203.0.113.6", 404);
    for (let i = 0; i < 60; i++) await answer(`/thing-${i}`, "192.0.2.9", 404);

    expect(handler.site?.missRate).toBe(0);
  });

  it("still counts ordinary misses", async () => {
    const handler = new BotHandler({ onWarning: () => {}, metrics: false, site: { warmupRequests: 10 } });
    let at = 1_700_000_000_000;
    for (let i = 0; i < 40; i++) {
      const facts = createFacts({ method: "GET", url: `/p-${i}`, headers: HEADERS, ip: "203.0.113.5", timestamp: (at += 100) });
      await handler.assess(facts);
      handler.recordOutcome(facts, i % 4 === 0 ? 404 : 200);
    }
    expect(handler.site?.missRate).toBeCloseTo(0.25, 2);
  });
});

/**
 * A shop whose catalogue runs to six figures, browsed normally.
 *
 * This is the case that broke `distributed-walk` and could not have been found in a
 * small fixture. Ids spread over a wide range coarsen the bitmap until one bucket stands
 * for hundreds of ids; ordinary browsing then touches nearly every bucket, coverage reads
 * 1.0, and `touched * scale` extrapolates to hundreds of thousands of ids nobody
 * requested — so the revisit ratio looked perfect too. Measured before the fix: sixty
 * long-tail shoppers, every single one reported.
 */
describe("a large catalogue browsed by ordinary people", () => {
  const CATALOGUE = 200_000;

  /**
   * Zipf-ish and deterministic: most views land on a few popular items, the tail lands
   * anywhere. The tail has to be genuinely wide — an earlier version of this used
   * `Math.sin` and produced only 2,491 distinct ids from 4,000 requests, which left
   * coverage at 0.50 and meant the test passed with the bug still in place.
   */
  function pick(seed: number): number {
    // A linear congruential step, which spreads across the catalogue properly.
    const spread = (Math.imul(seed + 1, 1_664_525) + 1_013_904_223) >>> 0;
    return spread % 10 < 4 ? spread % 200 : spread % CATALOGUE;
  }

  it("reports none of them, and still catches a walk on the same site", async () => {
    const handler = new BotHandler({ onWarning: () => {}, metrics: false, site: { warmupRequests: 800, maxPaths: 4000 } });
    let at = 1_700_000_000_000;
    const visit = async (ip: string, path: string): Promise<Assessment> => {
      const facts = createFacts({ method: "GET", url: path, headers: HEADERS, ip, timestamp: (at += 700) });
      const assessment = await handler.assess(facts);
      handler.recordOutcome(facts, 200);
      return assessment;
    };

    for (let i = 0; i < 9000; i++) await visit(`198.51.${(i % 250) + 1}.${(i % 200) + 1}`, `/product/${pick(i)}`);

    for (let shopper = 0; shopper < 20; shopper++) {
      let last: Assessment | undefined;
      for (let page = 0; page < 40; page++) last = await visit(`203.0.113.${shopper + 1}`, `/product/${pick(shopper * 1000 + page)}`);
      expect(found(last as Assessment, "distributed-walk"), `shopper ${shopper}`).toBeUndefined();
    }

    // The same site, the same profile, and the shape it is actually looking for.
    let walker: Assessment | undefined;
    for (let actor = 0; actor < 12; actor++) {
      for (let step = 0; step < 30; step++) walker = await visit(`198.51.201.${actor + 1}`, `/user/${actor * 30 + step}`);
    }
    expect(found(walker as Assessment, "distributed-walk")).toBeDefined();
  });
});

/**
 * The guard clauses again, this time on the site side.
 *
 * A baseline detector that returns early because the profile is cold looks exactly like
 * one that ran and was satisfied, so the only way to tell them apart is to build the
 * profile by hand and ask.
 */
describe("the baseline detectors when the profile cannot answer", () => {
  const profile = (observed: number): SiteProfile => {
    const site = new SiteProfile({ warmupRequests: WARMUP, clock: systemClock });
    for (let i = 0; i < observed; i++) site.record(`/warm/${i % 40}`, `192.0.2.${(i % 200) + 1}`);
    return site;
  };

  /** How far through warmup a profile is, which is the only honest thing to say while cold. */
  it("reports how much it has seen, warm or not", () => {
    const cold = profile(3);
    expect(cold.requestsObserved).toBe(3);
    expect(cold.warm).toBe(false);
    expect(cold.missRate, "a cold profile answers nothing, rather than answering zero").toBeUndefined();

    const warmed = profile(WARMUP);
    expect(warmed.requestsObserved).toBe(WARMUP);
    expect(warmed.warm).toBe(true);
  });

  it("has no walk spread for a range nobody has walked", () => {
    const cold = profile(3);
    cold.recordWalk("/product/:id", 41, "192.0.2.7");
    expect(cold.spreadOf("/product/:id"), "recorded, but the profile has no baseline to read it against").toBeUndefined();

    const site = profile(WARMUP);
    expect(site.spreadOf("/product/:id"), "warm, but nothing recorded under this template").toBeUndefined();
    // And a single id is a window of one bucket, which is coverage of 1 — not a gap.
    site.recordWalk("/product/:id", 41, "192.0.2.7");
    expect(site.spreadOf("/product/:id")?.coverage).toBe(1);
  });

  /**
   * Both of the profile's tables can be switched off by setting their bound to zero,
   * which is a legitimate way to run — they are memory. What must not happen is a
   * switched-off table answering as though it had looked.
   */
  it("answers nothing rather than zero when path watching is switched off", () => {
    const site = new SiteProfile({ warmupRequests: 2, maxWatchedPaths: 0, clock: systemClock });
    for (let i = 0; i < 40; i++) {
      site.record("/new-thing", `192.0.2.${i + 1}`);
      site.recordOutcome("/new-thing", 404);
    }
    expect(site.warm).toBe(true);
    expect(site.surgeOf("/new-thing"), "not watched, so there is nothing to report").toBeUndefined();
    // The site-wide numbers are unaffected: they are counters, not a table.
    expect(site.missRate).toBe(1);
  });

  /**
   * A walk record can go away while the profile stays warm.
   *
   * The walk table is bounded twice — by the number of templates it will hold and by how
   * long it holds them — so a range that was busy an hour ago and quiet since is dropped
   * while the site's own counters carry on. The detector then asks about a template it
   * has itself just filed and gets nothing back, and the only safe reading of nothing is
   * nothing: a range with no history is not a range being walked.
   */
  it("says nothing about a walk whose record has aged out from under it", () => {
    const clock = new ManualClock(1_700_000_000_000);
    const site = new SiteProfile({ warmupRequests: 10, windowMs: 60_000, clock });
    for (let i = 0; i < 20; i++) site.record("/product/1", `192.0.2.${i + 1}`);
    for (let i = 1; i <= 40; i++) site.recordWalk("/product/:id", i, `198.51.100.${i}`);
    expect(site.warm).toBe(true);
    expect(site.spreadOf("/product/:id")).toBeDefined();

    clock.set(clock.now() + 61_000);
    expect(site.spreadOf("/product/:id"), "the record aged out; the site did not").toBeUndefined();
    expect(site.warm).toBe(true);
    expect(distributedWalkDetector().inspect(makeContext({ site, path: "/product/17", headers: HEADERS }))).toBeUndefined();
  });

  /**
   * An option passed as `undefined` means "unset", not "override the default with nothing".
   *
   * TypeScript forbids the call under `exactOptionalPropertyTypes`, which is why it is
   * cast here — but this is a published class and half its users are writing JavaScript,
   * where `{ warmupRequests: config.warmup }` with nothing configured is the ordinary way
   * to reach it. Spreading that over the defaults without filtering would set the warmup
   * to `undefined`, and `observed >= undefined` is false forever: a profile that never
   * warms and therefore never says anything, silently.
   */
  it("treats an explicitly undefined option as unset", () => {
    const site = new SiteProfile({ warmupRequests: undefined, clock: systemClock } as never);
    site.record("/a", "192.0.2.1");
    expect(site.warm, "the default warmup is thousands of requests, not zero").toBe(false);
  });

  /**
   * A site whose own miss rate is zero.
   *
   * Not reachable through the handler, and deliberately so: every outcome the handler
   * files against an actor is filed against the site in the same call, so by the time an
   * actor has missed twenty times the site has too. It is reachable for anybody sharing a
   * profile between processes, and the ratio it protects is a division by zero — so the
   * branch is exercised where it can be, which is the detector's own front door.
   */
  it("says the site never answers \"not found\" rather than dividing by its rate", () => {
    const site = new SiteProfile({ warmupRequests: WARMUP, clock: systemClock });
    for (let i = 0; i < WARMUP; i++) {
      site.record(`/warm/${i % 40}`, `192.0.2.${(i % 200) + 1}`);
      site.recordOutcome(`/warm/${i % 40}`, 200);
    }
    expect(site.missRate).toBe(0);

    const state = new ActorState("203.0.113.60", 1_700_000_000_000);
    for (let i = 0; i < 25; i++) state.recordOutcome(404);

    const evidence = missBaselineDetector().inspect(makeContext({ state, site, headers: HEADERS })) as Evidence | undefined;
    expect(evidence?.summary).toContain("on a site that otherwise never answers that");
    expect(evidence?.summary, "no percentage, because there is no rate to quote").not.toContain("against");
  });
});
