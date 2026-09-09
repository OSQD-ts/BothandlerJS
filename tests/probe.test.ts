import { describe, expect, it } from "vitest";
import { BotHandler, createFacts } from "../src/index.js";
import type { HandleResult } from "../src/core.js";
import type { Assessment, Evidence } from "../src/types.js";
import type { MarkerProbeOptions } from "../src/probe/index.js";
import { driftBetween, identityShape, readMarker } from "../src/probe/marker.js";
import { identityDriftDetector, markerFanoutDetector, markerIntegrityDetector, markerPersistenceDetector } from "../src/detectors/marker.js";
import { ActorState } from "../src/state.js";
import { MarkerProbe } from "../src/probe/index.js";
import { ManualClock } from "../src/internal/clock.js";
import { makeContext } from "./helpers.js";
import type { IdentityShape } from "../src/probe/marker.js";
import { parseUserAgent } from "../src/internal/ua.js";

/**
 * The marker cookie, and what it makes visible.
 *
 * Every other correlation in this library joins requests by **actor key**, which comes
 * from the address. That join is wrong in both directions — an office puts hundreds of
 * people behind one key, a proxy pool spreads one scraper across thousands — and the
 * cost of it was a detector that could not be written: a client arriving as Chrome and
 * then as curl is indistinguishable from two people sharing a connection.
 *
 * A signed cookie removes the ambiguity, so these tests are mostly about the two things
 * that follow from that. It must see a rotation that headers alone cannot (below, across
 * a change of address, which is the case an IP join gets exactly backwards). And it must
 * stay silent on the ordinary browsing it now has a much sharper instrument for.
 */
const SECRET = "a-marker-secret-long-enough-to-be-accepted-here";
const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const IOS = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
/** What "Request desktop site" sends from that same iPhone: still Safari, now a Mac. */
const IOS_DESKTOP = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const BASE = { host: "shop.test", accept: "text/html,application/xhtml+xml", "accept-language": "en-GB,en;q=0.9" };

function engine(probe: MarkerProbeOptions | false = { secrets: [SECRET], secure: false }): BotHandler {
  return new BotHandler({ onWarning: () => {}, metrics: false, ...(probe === false ? {} : { probe }) });
}

function request(ua: string, options: { cookie?: string; ip?: string; url?: string } = {}) {
  return createFacts({
    method: "GET",
    url: options.url ?? "/",
    headers: { ...BASE, "user-agent": ua, ...(options.cookie === undefined ? {} : { cookie: options.cookie }) },
    ip: options.ip ?? "203.0.113.5",
  });
}

function issuedCookie(result: HandleResult): string | undefined {
  const { outcome } = result;
  if (outcome.kind === "continue") return outcome.responseHeaders?.["set-cookie"];
  if (outcome.kind === "respond") return outcome.headers["set-cookie"];
  return undefined;
}

/** The `name=value` a browser would send back from a `Set-Cookie`. */
function held(result: HandleResult): string {
  const cookie = issuedCookie(result);
  if (cookie === undefined) throw new Error("expected a marker to have been issued");
  return cookie.split(";")[0] as string;
}

const evidenceFor = (result: { assessment: Assessment }, id: string): Evidence | undefined =>
  result.assessment.evidence.find((item) => item.detector === id);

describe("handing out a marker", () => {
  it("issues one to a client that is not holding a valid one", async () => {
    const cookie = issuedCookie(await engine().handle(request(CHROME)));
    expect(cookie).toBeDefined();
    expect(cookie).toContain("__bh_m=");
    // A marker nothing in a page needs to read is a marker script cannot steal.
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
  });

  it("does not set one again while the client holds a good one", async () => {
    // `Set-Cookie` makes a response uncacheable by shared caches, so reissuing on every
    // request would quietly cost a site its cache-hit ratio to learn nothing new.
    const handler = engine();
    const cookie = held(await handler.handle(request(CHROME)));
    for (let i = 0; i < 5; i++) {
      expect(issuedCookie(await handler.handle(request(CHROME, { cookie })))).toBeUndefined();
    }
  });

  it("does not issue one to a verified crawler", async () => {
    // Googlebot keeps no cookies, so a marker sent to it is a header that never returns
    // and an issuance count that means nothing.
    const handler = new BotHandler({
      onWarning: () => {},
      metrics: false,
      probe: { secrets: [SECRET], secure: false },
      crawlerRanges: { googlebot: ["66.249.64.0/19"] },
    });
    const result = await handler.handle(
      createFacts({
        method: "GET",
        url: "/",
        headers: { host: "shop.test", "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" },
        ip: "66.249.66.1",
      }),
    );
    expect(result.assessment.botClass).toBe("verified-bot");
    expect(issuedCookie(result)).toBeUndefined();
  });

  it("stays entirely out of the way when no probe is configured", async () => {
    const handler = engine(false);
    const result = await handler.handle(request(CHROME));
    expect(issuedCookie(result)).toBeUndefined();
    expect(result.assessment.marker).toBeUndefined();
    expect(handler.describeDetectors().some((detector) => detector.id.startsWith("marker") || detector.id === "identity-drift")).toBe(false);
  });
});

describe("reading what comes back", () => {
  it("sees one client claiming two browsers, even across a change of address", async () => {
    // The case an address-based join gets backwards in both directions. Here the address
    // changes *and* the identity changes, and only the marker ties the two requests
    // together — which is what makes this evidence rather than a guess.
    const handler = engine();
    const cookie = held(await handler.handle(request(CHROME, { ip: "203.0.113.5" })));
    const result = await handler.handle(request("curl/8.4.0", { cookie, ip: "198.51.100.9" }));

    const drift = evidenceFor(result, "identity-drift");
    expect(drift).toBeDefined();
    expect(drift?.certainty).toBe("strong");
    expect(drift?.botClass).toBe("impersonator");
  });

  it("treats a desktop-site toggle as the soft case it is", async () => {
    // A real person on a phone produces exactly this, so it must not carry the weight
    // that a changed browser family carries, and it must not deny anybody.
    const handler = engine();
    const cookie = held(await handler.handle(request(IOS)));
    const result = await handler.handle(request(IOS_DESKTOP, { cookie }));

    const drift = evidenceFor(result, "identity-drift");
    expect(drift?.certainty).toBe("moderate");
    expect(drift?.botClass).toBe("unknown");
    expect(result.assessment.verdict).not.toBe("confirmed-bot");
    expect(result.decision.action).toBe("allow");
  });

  it("can be told to say nothing about the soft case at all", async () => {
    const { identityDriftDetector, defaultDetectors } = await import("../src/detectors/index.js");
    const handler = new BotHandler({
      onWarning: () => {},
      metrics: false,
      probe: { secrets: [SECRET], secure: false },
      detectors: [...defaultDetectors(), identityDriftDetector({ reportSoftDrift: false })],
    });
    const cookie = held(await handler.handle(request(IOS)));
    expect(evidenceFor(await handler.handle(request(IOS_DESKTOP, { cookie })), "identity-drift")).toBeUndefined();
  });

  it("reports a marker it did not sign", async () => {
    const handler = engine();
    const cookie = held(await handler.handle(request(CHROME)));
    const tampered = `${cookie.slice(0, -4)}AAAA`;
    const result = await handler.handle(request(CHROME, { cookie: tampered }));

    const forged = evidenceFor(result, "marker-integrity");
    expect(forged?.certainty).toBe("strong");
    expect(forged?.summary).toContain("never signed");
  });

  it("does not call somebody else's cookie a forged marker", async () => {
    // `forged` is `strong` evidence, so anything that reads a foreign value as tampering
    // is a way to accuse ordinary visitors. A sibling host under a shared `domain`, or an
    // application that happens to use the name, sets values that are not shaped like ours
    // at all — and tampering keeps the shape, because tampering means altering what we
    // sent.
    const handler = engine();
    for (const foreign of ["session-value-from-somewhere-else", "null", "abc123", "a".repeat(400), "%%%%", "🎉🎉"]) {
      const result = await handler.handle(request(CHROME, { cookie: `__bh_m=${foreign}` }));
      expect(result.assessment.marker?.reading.kind, foreign.slice(0, 20)).toBe("absent");
      expect(evidenceFor(result, "marker-integrity"), foreign.slice(0, 20)).toBeUndefined();
    }
  });

  it("still reports a marker of ours that was edited", async () => {
    const handler = engine();
    const cookie = held(await handler.handle(request(CHROME)));
    const result = await handler.handle(request(CHROME, { cookie: `${cookie.slice(0, -4)}AAAA` }));
    expect(evidenceFor(result, "marker-integrity")?.certainty).toBe("strong");
  });

  it("does not call an expired marker a forged one", async () => {
    // A cookie outliving its window is what cookies do, and saying otherwise would
    // accuse everybody who left a tab open.
    const handler = new BotHandler({ onWarning: () => {}, metrics: false, probe: { secrets: [SECRET], secure: false, ttlMs: 1 } });
    const cookie = held(await handler.handle(request(CHROME)));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const result = await handler.handle(request(CHROME, { cookie }));
    expect(result.assessment.marker?.reading.kind).toBe("expired");
    expect(evidenceFor(result, "marker-integrity")).toBeUndefined();
    expect(evidenceFor(result, "identity-drift")).toBeUndefined();
  });

  it("stops accepting a cached marker the moment it expires", async () => {
    // Verifying a marker is an HMAC, and a session presents the same cookie on every
    // request, so successful verifications are cached. The cache must not become a way
    // for an expired marker to keep working: expiry is re-checked on every hit.
    const handler = new BotHandler({ onWarning: () => {}, metrics: false, probe: { secrets: [SECRET], secure: false, ttlMs: 40 } });
    const cookie = held(await handler.handle(request(CHROME)));

    // Verified and cached.
    expect((await handler.handle(request(CHROME, { cookie }))).assessment.marker?.reading.kind).toBe("valid");
    await new Promise((resolve) => setTimeout(resolve, 60));
    // Same string, same cache entry, and no longer good.
    const result = await handler.handle(request(CHROME, { cookie }));
    expect(result.assessment.marker?.reading.kind).toBe("expired");
    expect(evidenceFor(result, "identity-drift")).toBeUndefined();
  });

  it("never caches a marker it could not verify", async () => {
    // Caching failures would let anybody fill the cache with unique junk.
    const handler = engine();
    const cookie = held(await handler.handle(request(CHROME)));
    const tampered = `${cookie.slice(0, -4)}AAAA`;
    for (let i = 0; i < 3; i++) {
      expect((await handler.handle(request(CHROME, { cookie: tampered }))).assessment.marker?.reading.kind).toBe("forged");
    }
  });

  it("notices a client that keeps cookies but never ours", async () => {
    // A scraper replaying a captured session header: it sends the one cookie it was
    // told to, and stores nothing it is given.
    const handler = engine();
    let result = await handler.handle(request("curl/8.4.0", { cookie: "session=captured-elsewhere" }));
    for (let i = 0; i < 7; i++) {
      result = await handler.handle(request("curl/8.4.0", { url: `/p${i}`, cookie: "session=captured-elsewhere" }));
    }

    const persistence = evidenceFor(result, "marker-persistence");
    expect(persistence?.certainty).toBe("moderate");
    expect(persistence?.summary).toContain("never returned the one this server set");
  });

  it("leaves a client that sends no cookies at all to session-integrity", async () => {
    // The overlapping version of this detector double-counted one observation, and the
    // population it landed on was people who block cookies. Measured on the corpus: it
    // took `cookies-blocked` from 21 to 38 and put +24 on five ordinary sessions.
    const handler = engine();
    let result = await handler.handle(request(CHROME));
    for (let i = 0; i < 9; i++) result = await handler.handle(request(CHROME, { url: `/p${i}` }));
    expect(evidenceFor(result, "marker-persistence")).toBeUndefined();
  });

  it("says nothing at all about an ordinary browsing session", async () => {
    // The whole point of a sharper instrument is that it stays quiet on the traffic it
    // is not looking for.
    const handler = engine();
    const cookie = held(await handler.handle(request(CHROME)));
    for (let i = 0; i < 10; i++) {
      const result = await handler.handle(request(CHROME, { cookie, url: `/products/${i}` }));
      const noise = result.assessment.evidence.filter(
        (item) => item.detector === "identity-drift" || item.detector.startsWith("marker-"),
      );
      expect(noise, `request ${i} produced ${JSON.stringify(noise)}`).toEqual([]);
      expect(result.assessment.verdict).not.toBe("confirmed-bot");
    }
  });
});

describe("what the probe refuses to do", () => {
  it("will not start without a secret it can rely on", () => {
    // A secret invented at startup would read every marker minted by another replica —
    // or by this one before a restart — as forged, which turns the strongest signal here
    // into a machine for accusing ordinary visitors.
    expect(() => engine({ secrets: [] })).toThrow(/at least one secret/);
    expect(() => engine({ secrets: ["short"] })).toThrow(/at least 32/);
  });

  it("refuses a cookie configuration it could never issue", () => {
    // These used to construct happily and then throw once per request, forever. Every one
    // of those throws lands in the adapter's fail-open path, so the site keeps serving
    // while detection is entirely off and the operator collects an error per request.
    expect(() => engine({ secrets: [SECRET], cookieName: "bad name;" })).toThrow(/cannot issue a cookie/);
    expect(() => engine({ secrets: [SECRET], domain: "not a domain!" })).toThrow(/cannot issue a cookie/);
    expect(() => engine({ secrets: [SECRET], sameSite: "None", secure: false })).toThrow(/cannot issue a cookie/);
  });

  it("accepts the configurations it can issue", () => {
    expect(() => engine({ secrets: [SECRET], cookieName: "__custom_marker", domain: "shop.example", sameSite: "Strict" })).not.toThrow();
    expect(() => engine({ secrets: [SECRET], sameSite: "None" })).not.toThrow();
  });

  it("keeps working across a secret rotation", async () => {
    const before = engine();
    const cookie = held(await before.handle(request(CHROME)));
    const after = engine({ secrets: ["a-second-marker-secret-long-enough-to-pass", SECRET], secure: false });
    const result = await after.handle(request(CHROME, { cookie }));
    // Still ours, so neither forged nor drifted. The drift assertion is the load-bearing
    // one: deriving the stored identity under the *signing* secret would mean that
    // prepending a new key silently re-described every visitor as a different browser,
    // and every one of them would be reported at `strong` as an impersonator.
    expect(result.assessment.marker?.reading.kind).toBe("valid");
    expect(evidenceFor(result, "marker-integrity")).toBeUndefined();
    expect(evidenceFor(result, "identity-drift")).toBeUndefined();
  });
});

/**
 * A reaction is better evidence than an observation, because the stimulus was ours. We
 * chose when the challenge went out, so what a client does in the seconds after it is a
 * response to it rather than a pattern found by looking hard enough at ordinary traffic.
 */
describe("what a client does when it is challenged", () => {
  const CHALLENGE = "a-challenge-secret-long-enough-to-be-accepted";
  const rules = [{ id: "challenge-clients", match: { botClass: "http-client" as const }, action: "challenge" as const }];

  function challenging(probe = true): BotHandler {
    return new BotHandler({
      onWarning: () => {},
      metrics: false,
      challenge: { secrets: [CHALLENGE] },
      rules,
      ...(probe ? { probe: { secrets: [SECRET], secure: false } } : {}),
    });
  }

  it("issues the marker alongside the challenge page", async () => {
    // A client that is about to be asked a question is exactly the one worth being able
    // to recognise when it answers, so the challenge response carries a marker too.
    const result = await challenging().handle(request("curl/8.4.0"));
    expect(result.outcome.kind).toBe("respond");
    expect(issuedCookie(result)).toBeDefined();
  });

  it("reports a client that changes what it claims to be right after being asked", async () => {
    const handler = challenging();
    const cookie = held(await handler.handle(request("curl/8.4.0")));
    const result = await handler.handle(request(CHROME, { cookie }));

    const reaction = evidenceFor(result, "challenge-reaction");
    expect(reaction?.certainty).toBe("strong");
    expect(reaction?.botClass).toBe("impersonator");
    expect(reaction?.summary).toContain("holding the same marker");
  });

  it("reports the same change a tier lower when only an address ties the two requests", async () => {
    // Without a marker the join is the address, and a busy NAT will eventually put a
    // different person's browser in the seconds after somebody else was challenged.
    const handler = challenging(false);
    await handler.handle(request("curl/8.4.0"));
    const result = await handler.handle(request(CHROME));

    const reaction = evidenceFor(result, "challenge-reaction");
    expect(reaction?.certainty).toBe("moderate");
    expect(reaction?.summary).not.toContain("holding the same marker");
  });

  it("says nothing when the client comes back as what it was", async () => {
    const handler = challenging();
    const cookie = held(await handler.handle(request("curl/8.4.0")));
    expect(evidenceFor(await handler.handle(request("curl/8.4.0", { cookie })), "challenge-reaction")).toBeUndefined();
  });

  it("reports a client asked repeatedly that has never answered", async () => {
    const handler = challenging(false);
    let result = await handler.handle(request("curl/8.4.0"));
    for (let i = 0; i < 6; i++) result = await handler.handle(request("curl/8.4.0", { url: `/p${i}` }));

    const reaction = evidenceFor(result, "challenge-reaction");
    expect(reaction?.certainty).toBe("moderate");
    expect(reaction?.summary).toMatch(/Challenged \d+ times and has never returned a solution/);
  });

  it("is absent entirely when no challenge is configured", async () => {
    expect(engine().describeDetectors().some((detector) => detector.id === "challenge-reaction")).toBe(false);
  });
});

describe("one marker, many networks", () => {
  it("counts the networks a single marker is presented from", async () => {
    const handler = engine();
    const cookie = held(await handler.handle(request(CHROME)));
    let result = await handler.handle(request(CHROME, { cookie }));
    for (let i = 1; i < 20; i++) result = await handler.handle(request(CHROME, { cookie, ip: `198.51.${i}.7` }));

    const fanout = evidenceFor(result, "marker-fanout");
    expect(fanout?.certainty).toBe("moderate");
    expect(fanout?.botClass).toBe("scraper");
    expect(result.assessment.marker?.networks).toBeGreaterThanOrEqual(16);
  });

  it("says nothing about a client that moves between a handful of networks", async () => {
    // A phone between wifi and cellular, a laptop between home and an office. This is
    // the case the threshold exists to leave alone.
    const handler = engine();
    const cookie = held(await handler.handle(request(CHROME)));
    let result = await handler.handle(request(CHROME, { cookie }));
    for (let i = 1; i < 5; i++) result = await handler.handle(request(CHROME, { cookie, ip: `198.51.${i}.7` }));
    expect(evidenceFor(result, "marker-fanout")).toBeUndefined();
  });

  it("estimates the count closely enough for the threshold to mean something", async () => {
    // The networks are sketched into 128 bits rather than remembered, because
    // remembering them measured at 55.6 MB with both caps full. The sketch carries a few
    // percent of error in either direction, so this pins the accuracy the threshold
    // depends on rather than pretending it is exact.
    const handler = engine();
    const cookie = held(await handler.handle(request(CHROME)));
    let result = await handler.handle(request(CHROME, { cookie }));
    for (let i = 1; i < 32; i++) result = await handler.handle(request(CHROME, { cookie, ip: `198.51.${i}.7` }));
    const estimate = result.assessment.marker?.networks ?? 0;
    expect(estimate).toBeGreaterThanOrEqual(28);
    expect(estimate).toBeLessThanOrEqual(38);
  });

  it("counts a network rather than an address", async () => {
    // A lease renewed inside one `/24` is not movement, and counting addresses would
    // report every visitor whose router reconnected.
    const handler = engine();
    const cookie = held(await handler.handle(request(CHROME)));
    let result = await handler.handle(request(CHROME, { cookie }));
    for (let i = 1; i < 30; i++) result = await handler.handle(request(CHROME, { cookie, ip: `203.0.113.${i}` }));
    expect(result.assessment.marker?.networks).toBe(1);
    expect(evidenceFor(result, "marker-fanout")).toBeUndefined();
  });
});

/**
 * The two switches that change what the library *does* rather than only what it reads.
 * Each has a way of being quietly wrong that would show up as a detector firing on
 * everybody, which is the worst way to find out.
 */
describe("saying so when the configuration cannot work", () => {
  function warningsFrom(config: Record<string, unknown>): string[] {
    const seen: string[] = [];
    new BotHandler({ onWarning: (message) => seen.push(message), metrics: false, ...config });
    return seen;
  }

  it("refuses a marker and a clearance that would overwrite each other", () => {
    expect(
      () =>
        new BotHandler({
          onWarning: () => {},
          probe: { secrets: [SECRET], cookieName: "__shared" },
          challenge: { secrets: ["a-challenge-secret-long-enough-to-be-accepted"], cookieName: "__shared" },
        }),
    ).toThrow(/would overwrite the other/);
  });

  it("says when the marker will travel in the clear", () => {
    expect(warningsFrom({ probe: { secrets: [SECRET], secure: false } }).join(" ")).toMatch(/plain HTTP/);
    expect(warningsFrom({ probe: { secrets: [SECRET] } }).join(" ")).not.toMatch(/plain HTTP/);
  });

  it("says when a marker would expire before it could correlate anything", () => {
    expect(warningsFrom({ probe: { secrets: [SECRET], ttlMs: 5_000 } }).join(" ")).toMatch(/expires within a minute/);
  });

  it("says when a domain would stop the marker being stored at all", () => {
    // The failure this catches is silent and total: a marker nothing stores comes back
    // never, and `marker-persistence` would then report every visitor who keeps cookies.
    expect(warningsFrom({ probe: { secrets: [SECRET], domain: "localhost" } }).join(" ")).toMatch(/never be stored/);
  });

  it("says when a baseline is being drawn from too little traffic", () => {
    expect(warningsFrom({ site: { warmupRequests: 50 } }).join(" ")).toMatch(/is not one/);
    expect(warningsFrom({ site: {} }).join(" ")).not.toMatch(/is not one/);
  });
});

/**
 * What counts as "the same client" when it describes itself slightly differently.
 *
 * The version is excluded for a recognised browser because updating from 130 to 131 is
 * not a change of identity. Everything *un*recognised was getting the opposite treatment
 * — its whole User-Agent, version and all — so `curl/8.4.0` and `curl/8.5.0` read as two
 * different clients, and any auto-updating integration accused itself of impersonation at
 * `strong` the first time it upgraded inside a marker's lifetime.
 */
describe("a client that upgrades itself", () => {
  const shapeOf = (agent: string): IdentityShape =>
    identityShape(
      createFacts({ method: "GET", url: "/", headers: { ...BASE, "user-agent": agent }, ip: "203.0.113.1" }),
      parseUserAgent(agent),
    );
  const browserChanged = (a: string, b: string): boolean => driftBetween(shapeOf(a), shapeOf(b)).browser;

  it("does not report a version bump as a change of identity", () => {
    const bumps: Array<[string, string]> = [
      ["curl/8.4.0", "curl/8.5.0"],
      ["python-requests/2.31.0", "python-requests/2.32.0"],
      ["MyApp/3.4.1 (iOS 17.2; iPhone14,3)", "MyApp/3.4.2 (iOS 17.2; iPhone14,3)"],
      ["FeedFetcher/1.2 (+https://example.test/bot)", "FeedFetcher/1.3 (+https://example.test/bot)"],
      [CHROME, CHROME.replace("122.0.0.0", "123.0.0.0")],
    ];
    for (const [before, after] of bumps) {
      expect(browserChanged(before, after), `${before} -> ${after}`).toBe(false);
    }
  });

  it("still reports one client becoming a different one", () => {
    const changes: Array<[string, string]> = [
      ["curl/8.4.0", "Wget/1.21.4"],
      ["curl/8.4.0", "python-requests/2.31.0"],
      [CHROME, "curl/8.4.0"],
      // Two unrecognised clients must stay distinguishable: stripping versions must not
      // collapse everything that is merely unfamiliar into one identity.
      ["AppOne/1.0 (Linux)", "AppTwo/1.0 (Linux)"],
    ];
    for (const [before, after] of changes) {
      expect(browserChanged(before, after), `${before} -> ${after}`).toBe(true);
    }
  });

  it("reaches an ordinary browsing session end to end", async () => {
    // The unit above is the mechanism; this is the promise it exists to keep.
    const handler = engine();
    const cookie = held(await handler.handle(request("curl/8.4.0")));
    const result = await handler.handle(request("curl/8.5.0", { cookie }));
    expect(evidenceFor(result, "identity-drift")).toBeUndefined();
  });
});

/**
 * The guard clauses, one at a time.
 *
 * Everything above drives the detectors through a whole handler, which is the right way
 * to test what they *say*. It is the wrong way to reach the branches where they say
 * nothing: a detector that returns early because its source is switched off is, from
 * outside, indistinguishable from one that ran and found nothing. These build the
 * context directly and check the difference, because "silent for the wrong reason" is
 * the failure mode that survives every other test in this file.
 */
describe("the marker detectors when their source has nothing to say", () => {
  it("stays silent when no marker probe is configured at all", () => {
    // `ctx.marker` is undefined whenever `probe` is off. Three of the four read it, and
    // each has to survive that rather than reason from a missing value.
    const ctx = makeContext({ headers: { host: "shop.test", "user-agent": CHROME } });
    for (const detector of [identityDriftDetector(), markerIntegrityDetector(), markerPersistenceDetector(), markerFanoutDetector()]) {
      expect(detector.inspect(ctx), detector.id).toBeUndefined();
    }
  });

  it("says nothing about a forged marker until the count clears the threshold", () => {
    const state = new ActorState("203.0.113.9", 1_700_000_000_000);
    const observation = {
      reading: { kind: "forged" } as const,
      drift: undefined,
      shape: identityShape(request(CHROME), parseUserAgent(CHROME)),
      networks: 0,
    };
    const ctx = makeContext({ state, marker: observation, headers: { host: "shop.test", "user-agent": CHROME } });
    // One forgery, a threshold of two: the evidence is real but the case is not made yet.
    state.noteMarker(false, true, undefined);
    expect(markerIntegrityDetector({ minForgeries: 2 }).inspect(ctx)).toBeUndefined();
    state.noteMarker(false, true, undefined);
    expect(markerIntegrityDetector({ minForgeries: 2 }).inspect(ctx)).toBeDefined();
  });

  it("names the one thing that drifted rather than always naming both", () => {
    const shapeOf = (ua: string): IdentityShape => identityShape(request(ua), parseUserAgent(ua));
    const cases: Array<[IdentityShape, IdentityShape, string]> = [
      [shapeOf(CHROME), { ...shapeOf(CHROME), o: "windows" }, "platform"],
      [shapeOf(CHROME), { ...shapeOf(CHROME), l: "ja" }, "language"],
      [shapeOf(CHROME), { ...shapeOf(CHROME), o: "windows", l: "ja" }, "platform and language"],
    ];
    for (const [issued, now, expected] of cases) {
      const drift = driftBetween(issued, now);
      const ctx = makeContext({
        marker: { reading: { kind: "valid", claims: {} as never }, drift, shape: now, networks: 0 },
        headers: { host: "shop.test", "user-agent": CHROME },
      });
      const evidence = identityDriftDetector().inspect(ctx) as Evidence | undefined;
      expect(evidence?.summary, expected).toContain(expected);
    }
  });

  /** An empty cookie value is a cookie header that exists and says nothing. */
  it("reads an empty marker as absent rather than as tampering", () => {
    expect(readMarker("", [SECRET], 1_700_000_000_000).kind).toBe("absent");
    expect(readMarker(undefined, [SECRET], 1_700_000_000_000).kind).toBe("absent");
    // And a value that could not have come from here is absent too, not forged: the
    // shape check is what keeps somebody else's cookie of the same name out of the count.
    expect(readMarker("not-a-token", [SECRET], 1_700_000_000_000).kind).toBe("absent");
  });
});

/**
 * The switches, and what turning them off is allowed to do.
 *
 * Every bound in the probe can be set to zero to turn its structure off entirely — no
 * fanout sketch, no verification cache, no watched paths. That is a legitimate way to
 * run: they are memory, and somebody counting bytes should be able to decline them. What
 * is not legitimate is for a switched-off structure to become an accusation, so each of
 * these checks that the answer is "nothing to say" rather than "zero, confidently".
 */
describe("the probe with its optional structures switched off", () => {
  const clock = () => new ManualClock(1_700_000_000_000);
  /** The `name=value` a browser would send back, from a marker this probe just minted. */
  const markerValue = (probe: MarkerProbe): string => {
    const cookie = probe.issue(probe.observe(request(CHROME), parseUserAgent(CHROME)));
    return (cookie.split(";")[0] as string).split("=").slice(1).join("=");
  };

  it("counts no networks at all when marker tracking is off", () => {
    const probe = new MarkerProbe({ secrets: [SECRET], maxTrackedMarkers: 0, clock: clock() });
    // A *valid* marker, from several addresses: the count is only ever reached for one, so
    // a client without a marker would pass this test without exercising anything.
    const value = markerValue(probe);
    let observed = probe.observe(request(CHROME, { cookie: `__bh_m=${value}` }), parseUserAgent(CHROME));
    expect(observed.reading.kind).toBe("valid");
    for (const ip of ["198.51.100.1", "203.0.113.200", "192.0.2.44"]) {
      observed = probe.observe(request(CHROME, { cookie: `__bh_m=${value}`, ip }), parseUserAgent(CHROME));
    }
    expect(observed.networks).toBe(0);
    // And the detector reading it stays silent rather than reporting a client on no networks.
    expect(markerFanoutDetector({ minNetworks: 1 }).inspect(makeContext({ marker: observed, headers: { host: "shop.test", "user-agent": CHROME } }))).toBeUndefined();
  });

  it("still verifies markers with the verification cache switched off", async () => {
    const handler = new BotHandler({ onWarning: () => {}, metrics: false, probe: { secrets: [SECRET], secure: false, maxVerifiedMarkers: 0 } });
    const first = await handler.handle(request(CHROME));
    const cookie = held(first);
    const second = await handler.handle(request(CHROME, { cookie }));
    // A marker that verified is not re-issued, which is the observable proof it verified.
    expect(issuedCookie(second)).toBeUndefined();
  });

  /**
   * A marker whose cache entry outlives the marker.
   *
   * Both lifetimes are the same length, so this needs the two to have started at
   * different moments: a marker verified fifty seconds into its minute is cached for a
   * minute from *then*, and for the ten seconds between the token expiring and the cache
   * entry doing so the cache is holding a marker that is no longer valid. Checking expiry
   * on the way out of the cache rather than trusting what is in it is what makes those
   * ten seconds a refusal instead of an acceptance — and it is the only window in which
   * that check does any work at all, which is why it is the one worth writing down.
   */
  it("stops accepting a cached marker the moment it expires", () => {
    const time = clock();
    const probe = new MarkerProbe({ secrets: [SECRET], ttlMs: 60_000, clock: time });
    const value = markerValue(probe);

    const carrying = (): ReturnType<MarkerProbe["observe"]> =>
      probe.observe(request(CHROME, { cookie: `__bh_m=${value}` }), parseUserAgent(CHROME));

    time.set(time.now() + 50_000);
    expect(carrying().reading.kind, "verified with ten seconds left, and now cached").toBe("valid");

    time.set(time.now() + 11_000);
    // The cache entry has another forty-nine seconds to run. The marker does not.
    expect(carrying().reading.kind).toBe("expired");
  });

  /**
   * The sketch saturates rather than overflowing.
   *
   * With every bit of the 128 set, linear counting's estimate is a logarithm of zero.
   * The question it answers — "is one marker moving across a pool" — was answered long
   * before that, so it saturates at the configured ceiling instead.
   */
  it("saturates the network count instead of dividing by zero", () => {
    const probe = new MarkerProbe({ secrets: [SECRET], maxNetworksPerMarker: 40, clock: clock() });
    const value = markerValue(probe);

    // Comfortably past the coupon-collector point for 128 bits, so every bit is set and
    // the estimate would be `-128 · ln(0)` if it were computed rather than capped.
    let last = 0;
    for (let a = 0; a < 4000; a++) {
      const ip = `${(a % 250) + 1}.${Math.floor(a / 250) + 1}.0.1`;
      last = probe.observe(request(CHROME, { cookie: `__bh_m=${value}`, ip }), parseUserAgent(CHROME)).networks;
    }
    expect(Number.isFinite(last), "not an infinity, which is what a logarithm of zero gives").toBe(true);
    expect(last).toBe(40);
  });

  it("refuses to start with a cookie configuration it could never issue", () => {
    // `SameSite=None` without `Secure` is rejected by every current browser, and by the
    // serializer. Failing here beats failing once per request forever.
    expect(() => new MarkerProbe({ secrets: [SECRET], sameSite: "None", secure: false, clock: clock() })).toThrow(
      /cannot issue a cookie with this configuration/,
    );
  });
});
