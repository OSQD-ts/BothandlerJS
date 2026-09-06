import { describe, expect, it } from "vitest";
import { ChallengeService, solveProofOfWork } from "../src/index.js";
import { analyseMovement, parseInteractionReport, probeShapeFor, scoreCapabilities, scoreMovement, verifyInteraction } from "../src/challenge/interaction.js";
import { MemoryStore } from "../src/stores/memory.js";
import { ManualClock } from "../src/internal/clock.js";
import type { PointerSample } from "../src/challenge/interaction.js";

const SECRET = "a".repeat(32);
const FULL_BROWSER = { cssApplied: true, layout: true, fontMetrics: true, animationFrame: true, mediaQuery: true, hiddenIsHidden: true };
const NO_BROWSER = { cssApplied: false, layout: false, fontMetrics: false, animationFrame: false, mediaQuery: false, hiddenIsHidden: false };

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** What every naive automation library produces: interpolate, at a fixed tick. */
function linearPath(steps = 25): PointerSample[] {
  return Array.from({ length: steps }, () => ({ dx: 12, dy: 5, dt: 16 }));
}

/** The same line with noise bolted on — the cheapest thing an author tries next. */
function jitteredPath(steps = 25, rand = seeded(7)): PointerSample[] {
  return Array.from({ length: steps }, () => ({
    dx: round2(12 + (rand() - 0.5) * 6),
    dy: round2(5 + (rand() - 0.5) * 6),
    dt: 16 + Math.round((rand() - 0.5) * 6),
  }));
}

/**
 * A hand: a minimum-jerk ballistic movement that overshoots, then corrective
 * sub-movements, with the event stream arriving unevenly.
 */
function humanPath(steps = 22, rand = seeded(3)): PointerSample[] {
  const out: PointerSample[] = [];
  let px = 0;
  let py = 0;
  const ballistic = Math.round(steps * 0.7);
  for (let i = 1; i <= ballistic; i++) {
    const t = i / ballistic;
    const s = 10 * t ** 3 - 15 * t ** 4 + 6 * t ** 5;
    const x = 300 * s * 1.06 + (rand() - 0.5) * 1.5;
    const y = 120 * s * 1.06 + Math.sin(t * Math.PI) * 16 + (rand() - 0.5) * 1.5;
    out.push({ dx: round2(x - px), dy: round2(y - py), dt: 8 + Math.round(rand() * 16) });
    px = x;
    py = y;
  }
  for (let i = ballistic; i < steps; i++) {
    const x = 300 + (rand() - 0.5) * 3;
    const y = 120 + (rand() - 0.5) * 3;
    out.push({ dx: round2(x - px), dy: round2(y - py), dt: 14 + Math.round(rand() * 24) });
    px = x;
    py = y;
  }
  return out;
}

/** Deterministic, so a threshold that only passes on a lucky afternoon fails here. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

describe("measuring a pointer path", () => {
  it("reads a straight constant-velocity path as machine-made", () => {
    const analysis = analyseMovement(linearPath());
    expect(analysis.distanceVariation).toBeCloseTo(0, 10);
    expect(analysis.speedVariation).toBeCloseTo(0, 10);
    expect(analysis.timingVariation).toBe(0);
    expect(analysis.straightness).toBeCloseTo(1, 3);
    expect(analysis.accelerationChanges).toBe(0);
    expect(scoreMovement(analysis)).toBe(0);
  });

  it("reads a hand as a hand", () => {
    const analysis = analyseMovement(humanPath());
    // Ballistic movement: fast into the move, braking at the target.
    expect(analysis.speedVariation).toBeGreaterThan(0.5);
    expect(analysis.straightness).toBeLessThan(0.95);
    expect(scoreMovement(analysis)).toBeGreaterThan(0.7);
  });

  /**
   * The separation this whole file exists for, and the reason the weights are not even.
   *
   * Bolting noise onto a straight line is nearly free, and it maxes out the two cheapest
   * terms — direction changes and sub-pixel coordinates — immediately. It barely moves
   * the speed profile or the straightness, which is why those two carry most of the
   * score. Without that weighting a jittered lerp scored 0.50 against a person's 0.94;
   * with it the gap is wide enough to sit a threshold in.
   */
  it("separates a jittered line from a hand by a usable margin", () => {
    const bot = scoreMovement(analyseMovement(jitteredPath()));
    const person = scoreMovement(analyseMovement(humanPath()));
    expect(bot).toBeLessThan(0.5);
    expect(person).toBeGreaterThan(0.7);
    expect(person - bot).toBeGreaterThan(0.3);
  });

  /**
   * The pointer appearing is not the pointer moving.
   *
   * A perfectly even synthetic path measured through a real browser scored 0.76 on
   * distance variation — indistinguishable from a person — because of exactly one
   * sample: the pointer's first appearance, a 60x60 jump recorded 1.25 seconds after
   * load. One outlier in twenty-six was enough, and an attacker who noticed could buy a
   * natural-looking score with a single deliberate teleport.
   */
  it("excludes a discontinuity rather than reading it as movement", () => {
    const even = Array.from({ length: 25 }, () => ({ dx: 8.33, dy: 12.6, dt: 17 }));
    const withTeleport = [{ dx: 60, dy: 60, dt: 1252 }, ...even];

    // Not exactly zero: the coefficient of variation over identical floats lands around
    // 1e-16, which is the arithmetic being honest rather than a signal.
    expect(analyseMovement(even).distanceVariation).toBeCloseTo(0, 10);
    // The jump is dropped whole, so the measurement is of the movement that happened.
    expect(analyseMovement(withTeleport).distanceVariation).toBeCloseTo(0, 10);
    expect(analyseMovement(withTeleport).samples).toBe(25);
    expect(scoreMovement(analyseMovement(withTeleport))).toBeLessThan(0.2);
  });

  /**
   * Speed is distance over time, so jittering the event timing alone manufactures speed
   * variation for free — and jittery dispatch timing is what any awaited automation loop
   * produces without trying. Distance per sample reads only where the pointer went.
   */
  it("does not mistake ragged event timing for organic movement", () => {
    const evenStepsRaggedTiming = Array.from({ length: 24 }, () => ({ dx: 12.5, dy: 4.5, dt: 6 + Math.round(Math.random() * 14) }));
    const analysis = analyseMovement(evenStepsRaggedTiming);
    expect(analysis.speedVariation).toBeGreaterThan(0.2);        // the free variation
    expect(analysis.distanceVariation).toBeCloseTo(0, 10);       // and the term that resists it
    expect(scoreMovement(analysis)).toBeLessThan(0.4);
  });

  it("says nothing about a path too short to describe", () => {
    expect(scoreMovement(analyseMovement([{ dx: 3, dy: 1, dt: 12 }]))).toBe(0);
    expect(analyseMovement([]).samples).toBe(0);
  });
});

describe("reading a report off the wire", () => {
  it("survives anything an attacker can put in the body", () => {
    expect(parseInteractionReport(null)).toBeUndefined();
    expect(parseInteractionReport("not an object")).toBeUndefined();
    expect(parseInteractionReport(42)).toBeUndefined();

    const report = parseInteractionReport({ trusted: "yes", via: "telepathy", msToActivate: "soon", path: "nope", capabilities: null });
    expect(report).toBeDefined();
    // A string is not `true`, and `via` falls back rather than being believed.
    expect(report?.trusted).toBe(false);
    expect(report?.via).toBe("other");
    expect(report?.msToActivate).toBe(0);
    expect(report?.path).toEqual([]);
  });

  it("bounds the path rather than measuring whatever arrives", () => {
    const huge = Array.from({ length: 5000 }, () => [1, 1, 16]);
    expect(parseInteractionReport({ trusted: true, path: huge })?.path.length).toBeLessThanOrEqual(128);
  });

  it("drops samples that describe something no hand does", () => {
    const report = parseInteractionReport({
      trusted: true,
      path: [[1, 1, 16], [Number.NaN, 1, 16], [1, Number.POSITIVE_INFINITY, 16], [99_999, 1, 16], [1, 1, -5], [1, 1, 999_999], [2, 2, 20]],
    });
    expect(report?.path).toEqual([{ dx: 1, dy: 1, dt: 16 }, { dx: 2, dy: 2, dt: 20 }]);
  });

  it("ignores capability names it does not know, so the object cannot be padded", () => {
    const report = parseInteractionReport({ trusted: true, capabilities: { cssApplied: true, inventedByAnAttacker: true } });
    expect(report?.capabilities).toEqual({ cssApplied: true });
    expect(scoreCapabilities(report?.capabilities ?? {})).toBeLessThan(0.5);
  });
});

describe("what an interaction is worth", () => {
  const person = { trusted: true as const, via: "pointer" as const, msToActivate: 2400, path: humanPath(), capabilities: FULL_BROWSER };

  it("accepts a person in a browser", () => {
    const outcome = verifyInteraction(person, 2500);
    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.level).toBe("interaction");
  });

  it("refuses a synthesised activation", () => {
    expect(verifyInteraction({ ...person, trusted: false }, 2500)).toMatchObject({ ok: false });
  });

  it("refuses an answer that arrived too fast, measured by the server", () => {
    // The client claims it took 2400ms. The server knows the challenge was issued 200ms
    // ago, and the server is the one that decides.
    const outcome = verifyInteraction(person, 200);
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toMatch(/sooner than a person/);
  });

  it("refuses a report with no interaction in it at all", () => {
    expect(verifyInteraction(undefined, 5000)).toMatchObject({ ok: false });
  });

  it("refuses a client that claims to have taken longer than the challenge existed", () => {
    const outcome = verifyInteraction({ ...person, msToActivate: 600_000 }, 3000);
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toMatch(/longer than the challenge/);
  });

  /**
   * A path has to fit inside the session it claims to have happened in.
   *
   * Checked against the server's own elapsed measurement, so it is a contradiction with
   * something known rather than with something the client also asserted. Fabricated paths
   * are where it bites: a report describing eight seconds of pointer movement inside a
   * one-and-a-half second challenge did not happen.
   */
  it("refuses a path longer than the challenge it happened in", () => {
    const long = Array.from({ length: 40 }, (_, index) => ({ dx: 8 + (index % 7) * 3, dy: 3 + (index % 5) * 2, dt: 200 }));
    const outcome = verifyInteraction({ ...person, via: "pointer", path: long, msToActivate: 1200 }, 1500);
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toMatch(/inside a 1500ms challenge/);
  });

  it("accepts a path that comfortably fits the session", () => {
    const long = Array.from({ length: 40 }, (_, index) => ({ dx: 8 + (index % 7) * 3, dy: 3 + (index % 5) * 2, dt: 200 }));
    expect(verifyInteraction({ ...person, via: "pointer", path: long, msToActivate: 20_000 }, 30_000).ok).toBe(true);
  });

  it("allows enough slack for clock skew and a restored page", () => {
    expect(verifyInteraction({ ...person, msToActivate: 20_000 }, 3000).ok).toBe(true);
  });

  it("expects no path from a tap, and does not grade a phone down for it", () => {
    // Touch produces almost no pointermove. Reporting a tap as a mouse would score zero
    // for movement and quietly downgrade every phone.
    const outcome = verifyInteraction({ trusted: true, via: "touch", msToActivate: 2000, path: [], capabilities: FULL_BROWSER }, 2500);
    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.level).toBe("interaction");
  });

  /**
   * The gap the capability probes exist to close. A client that never rendered anything
   * can still POST a plausible-looking report — but it cannot report a computed style
   * that nothing computed.
   */
  it("refuses a client that reports no browser behind it", () => {
    expect(verifyInteraction({ ...person, via: "keyboard", path: [], capabilities: NO_BROWSER }, 5000)).toMatchObject({ ok: false });
  });

  it("does not penalise a keyboard, a screen reader or voice control", () => {
    // No pointer path, and none expected. Scored on capabilities alone rather than
    // marked down for the absence, because the alternative puts assistive technology on
    // the wrong side of the check.
    const outcome = verifyInteraction({ trusted: true, via: "keyboard", msToActivate: 3000, path: [], capabilities: FULL_BROWSER }, 3000);
    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.level).toBe("interaction");
  });

  it("grades a real browser with a fake path down rather than refusing it", () => {
    // It ran a browser, which is the cost this feature exists to impose. It did not
    // move like a person, so it does not get the stronger clearance.
    const outcome = verifyInteraction({ ...person, path: linearPath() }, 2500);
    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.level).toBe("pow");
  });

  /**
   * A path too short to describe is no evidence, not bad evidence.
   *
   * Scoring it as zero was tried, on the reasoning that a pointer activation showing no
   * movement describes something that did not happen. Measured, it was wrong in both
   * directions at once: it downgraded somebody whose cursor already rested on the control
   * to `pow`, and it caught nobody, because `via` is a field the client fills in — an
   * attacker with no path to show simply writes "keyboard". A rule that only ever costs
   * honest people something is not strictness, it is a bug.
   */
  it("does not penalise a pointer that barely moved", () => {
    const barely = [
      { dx: 2, dy: 1, dt: 30 },
      { dx: 1, dy: 0, dt: 40 },
    ];
    expect(verifyInteraction({ ...person, path: barely }, 2500)).toMatchObject({ ok: true, level: "interaction" });
    expect(verifyInteraction({ ...person, path: [] }, 2500)).toMatchObject({ ok: true, level: "interaction" });
  });

  it("still marks down a path it can measure and does not like", () => {
    // The discrimination that works: a claim about movement the client *did* report.
    const outcome = verifyInteraction({ ...person, path: linearPath() }, 2500);
    expect(outcome.ok && outcome.level).toBe("pow");
  });
});

describe("the nonce-bound layout probe", () => {
  const shape = (nonce: string): { boxes: number; height: number } => probeShapeFor(nonce, SECRET);
  const answerFor = (nonce: string): number => shape(nonce).boxes * shape(nonce).height;
  const person = { trusted: true as const, via: "keyboard" as const, msToActivate: 2400, path: [], capabilities: FULL_BROWSER };

  it("asks a different question for different nonces", () => {
    const answers = new Set(["aaaa", "bbbb", "cccc", "abcd", "zzzz", "9f3a", "0000"].map(answerFor));
    expect(answers.size).toBeGreaterThan(3);
    for (const nonce of ["aaaa", "zzzz", "0000"]) {
      expect(shape(nonce).boxes).toBeGreaterThanOrEqual(4);
      expect(shape(nonce).height).toBeGreaterThanOrEqual(3);
      // Deterministic for a given secret, so both sides agree without exchanging it.
      expect(answerFor(nonce)).toBe(answerFor(nonce));
    }
  });

  /**
   * The client cannot compute the answer, only measure it.
   *
   * An earlier version fixed the height in the stylesheet and derived the count from the
   * nonce in the page's own script, which made the expected answer a formula an attacker
   * reads once and hardcodes for ever: a client that never rendered anything answered it
   * correctly five times out of five. Under the secret there is no formula to read.
   */
  it("is unpredictable without the signing secret", () => {
    const withOurs = answerFor("some-nonce");
    const withTheirs = probeShapeFor("some-nonce", "an-attackers-guess-at-the-secret");
    expect(withTheirs.boxes * withTheirs.height).not.toBe(withOurs);
  });

  it("accepts the answer to the question it asked", () => {
    expect(verifyInteraction({ ...person, layoutHeight: answerFor("abc123") }, 3000, undefined, shape("abc123")).ok).toBe(true);
  });

  /**
   * The attack this probe exists for. Every other answer in a report is the same from one
   * challenge to the next, so a report captured once from a real browser could be replayed
   * against fresh challenges for ever. Measured before the probe existed: one captured
   * report accepted for five consecutive challenges.
   */
  it("refuses an answer to a different challenge", () => {
    const outcome = verifyInteraction({ ...person, layoutHeight: answerFor("an-older-nonce") }, 3000, undefined, shape("a-fresh-nonce"));
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toMatch(/layout probe answered/);
  });

  it("refuses a report that skipped the probe", () => {
    expect(verifyInteraction(person, 3000, undefined, shape("abc123"))).toMatchObject({ ok: false });
  });

  it("allows a pixel of slack and no more", () => {
    const exact = answerFor("abc123");
    expect(verifyInteraction({ ...person, layoutHeight: exact + 1 }, 3000, undefined, shape("abc123")).ok).toBe(true);
    expect(verifyInteraction({ ...person, layoutHeight: exact + 2 }, 3000, undefined, shape("abc123")).ok).toBe(false);
  });

  it("skips the check when nothing is expected, so the analysis stays callable alone", () => {
    expect(verifyInteraction(person, 3000).ok).toBe(true);
  });

  it("bounds an absurd measurement rather than believing it", () => {
    expect(parseInteractionReport({ trusted: true, layoutHeight: 1e9 })?.layoutHeight).toBeUndefined();
    expect(parseInteractionReport({ trusted: true, layoutHeight: -5 })?.layoutHeight).toBeUndefined();
    expect(parseInteractionReport({ trusted: true, layoutHeight: Number.NaN })?.layoutHeight).toBeUndefined();
    expect(parseInteractionReport({ trusted: true, layoutHeight: 21 })?.layoutHeight).toBe(21);
  });
});

describe("what the operator is told", () => {
  /**
   * A refusal that came from the grading carries its score.
   *
   * The score histogram exists so an operator can see where to put `interactionAt`.
   * Feeding it only from successes hands them a distribution with everything below the
   * threshold cut out — which is exactly the part of the shape the decision turns on.
   */
  it("keeps the score on a refusal that was graded", () => {
    const NOTHING = { cssApplied: false, layout: false, fontMetrics: false, animationFrame: false, mediaQuery: false, hiddenIsHidden: false };
    const outcome = verifyInteraction({ trusted: true, via: "keyboard", msToActivate: 2000, path: [], capabilities: NOTHING }, 3000);
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.score).toBe(0);
    expect(outcome.ok === false && outcome.notes?.join(" ")).toMatch(/missing:/);
  });

  it("carries no score for a refusal decided before any grading", () => {
    // Nothing was measured, so reporting a number would be inventing one.
    const outcome = verifyInteraction({ trusted: false, via: "keyboard", msToActivate: 1, path: [], capabilities: {} }, 3000);
    expect(outcome.ok === false && outcome.score).toBeUndefined();
  });

  it("names the probes that failed rather than only counting them", () => {
    const outcome = verifyInteraction(
      { trusted: true, via: "keyboard", msToActivate: 2000, path: [], capabilities: { ...FULL_BROWSER, fontMetrics: false, animationFrame: false } },
      3000,
    );
    expect(outcome.ok).toBe(true);
    // "capabilities 70%" says something is wrong; the names say whether it is bots or a
    // population whose browsers cannot answer one particular question.
    expect(outcome.ok && outcome.notes.join(" ")).toMatch(/missing: fontMetrics, animationFrame/);
  });
});

describe("the challenge service, with a gesture asked for", () => {
  function service(interaction: boolean): { service: ChallengeService; clock: ManualClock } {
    const clock = new ManualClock(1_000_000);
    return { service: new ChallengeService({ secrets: [SECRET], difficulty: 8, store: new MemoryStore({ clock }), clock, ...(interaction ? { interaction: true } : {}) }), clock };
  }

  function nonceOf(challenge: string): string {
    return JSON.parse(Buffer.from(challenge.split(".")[0] as string, "base64url").toString()).nonce as string;
  }

  function solve(body: string): { challenge: string; solution: string } {
    const challenge = /"challenge":"([^"]+)"/.exec(body)?.[1] as string;
    return { challenge, solution: solveProofOfWork(nonceOf(challenge), 8) as string };
  }

  /**
   * Two minutes is the budget for a puzzle a machine solves in milliseconds. Asking for a
   * gesture means the page stops and waits for a person to read it and act, and a person
   * using a screen reader that announces the whole page — or on a slow device, or simply
   * interrupted — runs out of it and is told to reload, having done nothing wrong.
   */
  it("gives a person longer when it is waiting for one, and leaves the plain page alone", () => {
    const ttl = (svc: ChallengeService): number => (svc as unknown as { challengeTtlMs: number }).challengeTtlMs;
    expect(ttl(new ChallengeService({ secrets: [SECRET] }))).toBe(120_000);
    expect(ttl(new ChallengeService({ secrets: [SECRET], interaction: true }))).toBe(600_000);
    // An explicit setting still wins in both directions.
    expect(ttl(new ChallengeService({ secrets: [SECRET], interaction: true, challengeTtlMs: 45_000 }))).toBe(45_000);
  });

  it("renders the control and the probes only when asked to", () => {
    expect(service(true).service.issue("203.0.113.1").body).toContain('id="confirm"');
    const plain = service(false).service.issue("203.0.113.1").body;
    expect(plain).not.toContain('id="confirm"');
    // And none of the machinery either: the plain interstitial is unchanged.
    expect(plain).not.toContain("cssApplied");
    expect(plain).not.toContain("pointermove");
  });

  it("refuses a solved puzzle with no gesture behind it", async () => {
    const { service: svc, clock } = service(true);
    const { challenge, solution } = solve(svc.issue("203.0.113.1").body);
    clock.advance(3000);
    expect(await svc.verifySolution("203.0.113.1", { challenge, solution })).toMatchObject({ ok: false, status: 400 });
  });

  it("grants interaction clearance for a person, and says what it measured", async () => {
    const { service: svc, clock } = service(true);
    const { challenge, solution } = solve(svc.issue("203.0.113.1").body);
    clock.advance(3000);
    const outcome = await svc.verifySolution("203.0.113.1", {
      challenge,
      solution,
      interaction: { trusted: true, via: "pointer", msToActivate: 2900, path: humanPath().map((s) => [s.dx, s.dy, s.dt]), capabilities: FULL_BROWSER, layoutHeight: probeShapeFor(nonceOf(challenge), SECRET).boxes * probeShapeFor(nonceOf(challenge), SECRET).height },
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.level).toBe("interaction");
    expect(outcome.ok && outcome.notes?.join(" ")).toMatch(/capabilities 100%/);
  });

  it("still grants pow clearance when no gesture was asked for", async () => {
    const { service: svc } = service(false);
    const { challenge, solution } = solve(svc.issue("203.0.113.1").body);
    const outcome = await svc.verifySolution("203.0.113.1", { challenge, solution });
    expect(outcome).toMatchObject({ ok: true, level: "pow" });
  });

  /** The clock is the server's, so waiting is a real cost the attacker cannot skip. */
  it("refuses an answer returned faster than the floor, however the client times it", async () => {
    const { service: svc, clock } = service(true);
    const { challenge, solution } = solve(svc.issue("203.0.113.1").body);
    clock.advance(400);
    const outcome = await svc.verifySolution("203.0.113.1", {
      challenge,
      solution,
      interaction: { trusted: true, via: "pointer", msToActivate: 99_999, path: humanPath().map((s) => [s.dx, s.dy, s.dt]), capabilities: FULL_BROWSER, layoutHeight: probeShapeFor(nonceOf(challenge), SECRET).boxes * probeShapeFor(nonceOf(challenge), SECRET).height },
    });
    expect(outcome).toMatchObject({ ok: false });
  });
});
