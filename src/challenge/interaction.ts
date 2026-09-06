import { shortHash } from "../internal/crypto.js";

/**
 * The interaction challenge: what a client did on the interstitial, and what that is
 * worth.
 *
 * The proof of work in `pow.ts` demonstrates that a JavaScript engine ran. That is a
 * real cost and it is the whole of what the plain challenge asks for. This asks for
 * something else: evidence that a *browser* rendered the page and that a *person*
 * acted on it.
 *
 * ## What is actually verifiable, stated plainly
 *
 * Everything on this page is reported by the client, and the client is the one place an
 * adversary has complete control. A determined attacker driving a real browser through
 * CDP dispatches genuine input events, produces real layout, and can synthesise pointer
 * paths from a minimum-jerk model — the literature on human motor movement is public and
 * so are the libraries. **Nothing here is proof of humanity and none of it may ever be
 * `certain`.**
 *
 * What it does is move the cost. A scraper that was `fetch()` in a loop must now run a
 * browser engine, render CSS, and synthesise a plausible gesture per request. That is
 * three or four orders of magnitude more expensive per page, and for most bulk
 * extraction it is the difference between worth doing and not.
 *
 * Exactly one signal here is **server-verified** and cannot be fabricated: the elapsed
 * wall-clock time between issuing the challenge and receiving the answer, which comes
 * from the signed token's `iat` rather than from anything the client says. See
 * {@link verifyInteraction}.
 *
 * ## Why the analysis lives here and not in the page
 *
 * If the page scored itself and posted the number, an attacker would post the number.
 * The client sends a bounded, quantised record of what happened; every judgement about
 * it is made on this side.
 */

/**
 * The shape of one challenge's layout probe: how many boxes, and how tall each one is.
 *
 * Both are drawn from the nonce **under the signing secret**, which is the whole point.
 * An earlier version fixed the height at 7px in the stylesheet and derived the count from
 * the nonce in the page's own script, so the expected answer was a formula an attacker
 * could read once and hardcode for ever — a client that never rendered anything answered
 * it correctly five times out of five. Deriving it under the secret means the client
 * cannot compute the answer at all. It can only measure it.
 *
 * That does not make it unforgeable. Both numbers still have to reach the browser to be
 * rendered — the count as elements in the markup, the height as a literal in the
 * stylesheet — so anything willing to parse the page it was served can still find them.
 * What it removes is the *formula*: there is no longer a fixed rule to implement once and
 * reuse. See the honesty section in docs/challenge/interaction.md.
 */
export interface ProbeShape {
  boxes: number;
  height: number;
}

/** Derives {@link ProbeShape} for a nonce. The secret keeps it unpredictable to the client. */
export function probeShapeFor(nonce: string, secret: string): ProbeShape {
  const digest = shortHash(`probe:${nonce}`, secret);
  let a = 0;
  let b = 0;
  for (let i = 0; i < digest.length; i++) {
    if (i % 2 === 0) a += digest.charCodeAt(i);
    else b += digest.charCodeAt(i);
  }
  // Ranges chosen so the block stays small enough to sit off-screen and large enough that
  // the product is not guessable from a short list.
  return { boxes: 4 + (a % 21), height: 3 + (b % 14) };
}

/** One pointer sample: movement since the previous sample, and the gap in milliseconds. */
export interface PointerSample {
  dx: number;
  dy: number;
  dt: number;
}

/**
 * What the interstitial observed. Every field is client-supplied and therefore a claim
 * rather than a fact; see the note at the top of this file.
 */
export interface InteractionReport {
  /**
   * `event.isTrusted` on the activation.
   *
   * False for anything `element.click()` or a synthesised `MouseEvent` produces, which
   * is what a naive automation script reaches for first. A browser driven through the
   * DevTools protocol produces `true`, so this is a floor rather than a test.
   */
  trusted: boolean;
  /**
   * How the control was activated.
   *
   * `pointer` means a mouse, and is the only value from which a path is expected. `touch`
   * covers a tap or a stylus, which legitimately produce almost no movement; `keyboard`
   * covers the space bar, a screen reader, switch access and voice control; `other` is
   * anything the page could not classify.
   */
  via: "pointer" | "touch" | "keyboard" | "other";
  /** Milliseconds from page load to activation, as the *client* measured it. */
  msToActivate: number;
  /** Bounded, quantised pointer path leading up to the activation. */
  path: readonly PointerSample[];
  /** Results of the capability probes. See {@link CAPABILITY_WEIGHTS}. */
  capabilities: Readonly<Record<string, boolean>>;
  /**
   * Measured height of the nonce-bound layout probe, in CSS pixels, or `undefined` when
   * the client reported none. See {@link probeShapeFor}.
   */
  layoutHeight?: number | undefined;
}

/** What the movement looked like, once measured rather than asserted. */
export interface MovementAnalysis {
  samples: number;
  /**
   * Coefficient of variation of the distance covered per sample.
   *
   * The primary spatial measure, and the one that cannot be manufactured by accident:
   * it reads only where the pointer went, never how fast the events arrived.
   */
  distanceVariation: number;
  /** Coefficient of variation of speed. Human movement is ballistic; a lerp is flat. */
  speedVariation: number;
  /** Coefficient of variation of the gaps between samples. */
  timingVariation: number;
  /** Times the speed changed direction — sped up after slowing, or the reverse. */
  accelerationChanges: number;
  /** Net displacement over path length. 1 is a perfectly straight line. */
  straightness: number;
  /** Share of samples carrying a fractional component. */
  fractionalShare: number;
  /** Sum of absolute turn angles, in radians, over the whole path. */
  totalTurning: number;
}

export type InteractionOutcome =
  | { ok: true; level: "interaction" | "pow"; score: number; notes: readonly string[] }
  /**
   * `score` and `notes` are present whenever the refusal came from the grading rather
   * than from a gate reached before it.
   *
   * Carrying them matters more than it looks. The score histogram exists so that an
   * operator can see where to put `interactionAt`, and feeding it only from successes
   * gives them a distribution with everything below the threshold cut out of it — which
   * is precisely the part of the shape the decision depends on.
   */
  | { ok: false; reason: string; score?: number | undefined; notes?: readonly string[] | undefined };

export interface InteractionSettings {
  /**
   * Least time that may pass between issuing a challenge and accepting its answer, ms.
   *
   * Checked against the signed token rather than against anything the client reports,
   * which makes it the one part of this file an attacker cannot lie about. It is also
   * the part that costs them most: a floor of one second is a hard ceiling on how fast
   * a farm can work through challenges, however many browsers it runs.
   */
  minElapsedMs: number;
  /** Score at or above which the clearance is `interaction` rather than `pow`. */
  interactionAt: number;
  /** Score below which the answer is refused outright. */
  refuseBelow: number;
}

export const DEFAULT_INTERACTION_SETTINGS: InteractionSettings = {
  minElapsedMs: 1000,
  // Set from measurement rather than taste: a real browser driven with a
  // constant-velocity path scores 0.60, and a person scores above 0.95. The bar sits
  // between them, so synthesising movement badly earns `pow` and not `interaction`.
  interactionAt: 0.75,
  refuseBelow: 0.2,
};

/** Longest path we will read. A person moving a mouse produces tens of samples, not thousands. */
const MAX_SAMPLES = 128;

/**
 * Longest gap that still counts as one continuous stroke, in milliseconds.
 *
 * A pointer event arriving after a longer pause is not the next instant of a movement —
 * it is the pointer reappearing somewhere else, having entered the window, come back from
 * another application, or simply rested. The distance across that gap is not a distance a
 * hand travelled, and treating it as one wrecks every dispersion measure computed from it.
 *
 * This is not hypothetical. A perfectly even 24-step synthetic path measured through a
 * real browser scored 0.76 on distance variation — indistinguishable from a person — for
 * exactly one reason: the first sample was the pointer's initial appearance, a 60x60 jump
 * recorded 1.25 seconds after load. One outlier in twenty-six. An attacker who noticed
 * that could buy a natural-looking score with a single deliberate teleport.
 */
const CONTINUOUS_GAP_MS = 250;

/**
 * What each capability probe is worth.
 *
 * These are ordered by how hard the capability is to fake *without actually having it*.
 * `cssApplied` is the one that matters most: it asks the page to read back a computed
 * style that only exists if a CSSOM parsed the stylesheet and applied the cascade. An
 * HTTP client that parses HTML has no answer to it, and that is precisely the population
 * a challenge is aimed at.
 *
 * None of them is worth much on its own, and a real browser driven by a script passes
 * every one — which is why they contribute to a score rather than to a verdict.
 */
export const CAPABILITY_WEIGHTS: Readonly<Record<string, number>> = {
  /** A computed style that requires the cascade to have run. */
  cssApplied: 0.30,
  /** Layout produced a non-zero box for a laid-out element. */
  layout: 0.20,
  /** Text measurement differs between two fonts — there is a font engine. */
  fontMetrics: 0.15,
  /** `requestAnimationFrame` fired at a plausible interval — there is a frame loop. */
  animationFrame: 0.15,
  /** A media query evaluated, so the viewport is real. */
  mediaQuery: 0.10,
  /** An element hidden by CSS reports a zero box, so `display` was honoured. */
  hiddenIsHidden: 0.10,
};

/**
 * Measures a pointer path.
 *
 * The statistics are chosen for what they cost to fake convincingly rather than for how
 * well they describe a human. Anyone can add noise to a straight line; producing a path
 * whose *speed profile* is ballistic, whose turning is concentrated near the target, and
 * whose sample timing jitters the way a real event stream does takes deliberate work.
 */
export function analyseMovement(path: readonly PointerSample[]): MovementAnalysis {
  const samples = path.slice(0, MAX_SAMPLES);
  if (samples.length < 2) {
    return { samples: samples.length, distanceVariation: 0, speedVariation: 0, timingVariation: 0, accelerationChanges: 0, straightness: 1, fractionalShare: 0, totalTurning: 0 };
  }

  const speeds: number[] = [];
  const distances: number[] = [];
  const gaps: number[] = [];
  const angles: number[] = [];
  let pathLength = 0;
  let netX = 0;
  let netY = 0;
  let fractional = 0;

  for (const sample of samples) {
    // Discontinuities are excluded from the statistics rather than smoothed: see
    // CONTINUOUS_GAP_MS. The sample is dropped whole, because both its distance and its
    // speed describe a gap rather than a movement.
    if (sample.dt > CONTINUOUS_GAP_MS) continue;
    const distance = Math.hypot(sample.dx, sample.dy);
    // A gap of zero would divide by zero, and several samples in the same millisecond
    // is normal on a high-rate pointer.
    const gap = Math.max(sample.dt, 1);
    speeds.push(distance / gap);
    distances.push(distance);
    gaps.push(gap);
    pathLength += distance;
    netX += sample.dx;
    netY += sample.dy;
    if (!Number.isInteger(sample.dx) || !Number.isInteger(sample.dy)) fractional++;
    if (distance > 0) angles.push(Math.atan2(sample.dy, sample.dx));
  }

  let accelerationChanges = 0;
  for (let i = 2; i < speeds.length; i++) {
    const previous = (speeds[i - 1] as number) - (speeds[i - 2] as number);
    const current = (speeds[i] as number) - (speeds[i - 1] as number);
    if (previous !== 0 && current !== 0 && Math.sign(previous) !== Math.sign(current)) accelerationChanges++;
  }

  let totalTurning = 0;
  for (let i = 1; i < angles.length; i++) {
    let turn = (angles[i] as number) - (angles[i - 1] as number);
    // Wrap into [-pi, pi] so a path crossing the discontinuity is not read as a
    // near-full rotation.
    while (turn > Math.PI) turn -= 2 * Math.PI;
    while (turn < -Math.PI) turn += 2 * Math.PI;
    totalTurning += Math.abs(turn);
  }

  return {
    samples: distances.length,
    distanceVariation: coefficientOfVariation(distances),
    speedVariation: coefficientOfVariation(speeds),
    timingVariation: coefficientOfVariation(gaps),
    accelerationChanges,
    straightness: pathLength === 0 ? 1 : Math.min(1, Math.hypot(netX, netY) / pathLength),
    fractionalShare: fractional / samples.length,
    totalTurning,
  };
}

function coefficientOfVariation(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (mean === 0) return 0;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
}

/**
 * How human-shaped a measured path is, 0 to 1.
 *
 * Each term is a property that costs an attacker something different to reproduce, and
 * the sum is deliberately forgiving: a person making one short, quick, straight-ish
 * movement to a checkbox should not be punished for it. What this separates reliably is
 * *linear interpolation* — the constant-velocity, uniform-timing, integer-coordinate
 * path that every naive automation library produces — from anything organic.
 */
export function scoreMovement(analysis: MovementAnalysis): number {
  if (analysis.samples < 4) return 0;

  // The weights are not evenly spread, and each one is set by what it costs an attacker
  // to reproduce rather than by how well it describes a hand.
  //
  // Speed used to carry most of this, and that was a mistake worth recording: speed is
  // distance over time, so **jittering the event timing alone manufactures speed
  // variation for free** — 0.33 on a perfectly straight constant-step path, measured —
  // and jittery dispatch timing is what any awaited automation loop produces without
  // trying. A robotic straight line scored 0.89 that way.
  //
  // Distance per sample is immune to it. It reads only where the pointer went, never how
  // fast the events arrived, so a constant-step path scores zero however ragged its
  // timing. That is now the primary term, and speed is demoted to a supporting one.
  let score = 0;
  // How much the pointer moved between samples. A person accelerates into the movement
  // and brakes at the target; an interpolation takes even steps.
  score += clamp01(analysis.distanceVariation / 0.55) * 0.3;
  // Curvature. Nobody moves a hand in a straight line, and no naive path does otherwise.
  score += clamp01((1 - analysis.straightness) / 0.2) * 0.25;
  // Speed. Still meaningful, but partly a proxy for timing, so worth less than it looks.
  score += clamp01(analysis.speedVariation / 0.6) * 0.15;
  // Event timing that jitters. Cheap to come by, so cheap to score.
  score += clamp01(analysis.timingVariation / 0.35) * 0.1;
  // Speeding up and slowing down repeatedly. Maxed out by random noise; worth little.
  score += clamp01(analysis.accelerationChanges / 6) * 0.1;
  // Sub-pixel coordinates. Free to fake, and free to check.
  score += clamp01(analysis.fractionalShare / 0.3) * 0.1;

  return clamp01(score);
}

/** How much of the browser is really there, 0 to 1. */
export function scoreCapabilities(capabilities: Readonly<Record<string, boolean>>): number {
  let earned = 0;
  let available = 0;
  for (const [name, weight] of Object.entries(CAPABILITY_WEIGHTS)) {
    available += weight;
    if (capabilities[name] === true) earned += weight;
  }
  return available === 0 ? 0 : earned / available;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Reads an interaction report off the wire.
 *
 * Every field is attacker-supplied, so this is written to be total: anything malformed
 * becomes `undefined` rather than throwing, and every array and number is bounded before
 * it reaches the analysis. A report that arrives as a two-megabyte array of NaN is a
 * request to burn CPU, not an interaction.
 */
export function parseInteractionReport(value: unknown): InteractionReport | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;

  const via = raw["via"];
  const capabilities: Record<string, boolean> = {};
  if (typeof raw["capabilities"] === "object" && raw["capabilities"] !== null) {
    // Read the probes we know about by name rather than walking what arrived. Iterating
    // the supplied object would let a client hand over a million keys and have us walk
    // all of them; there are six probes and there will only ever be six.
    const supplied = raw["capabilities"] as Record<string, unknown>;
    for (const name of Object.keys(CAPABILITY_WEIGHTS)) {
      if (supplied[name] === true) capabilities[name] = true;
      else if (supplied[name] === false) capabilities[name] = false;
    }
  }

  const path: PointerSample[] = [];
  if (Array.isArray(raw["path"])) {
    for (const entry of (raw["path"] as unknown[]).slice(0, MAX_SAMPLES)) {
      if (!Array.isArray(entry) || entry.length < 3) continue;
      const [dx, dy, dt] = entry as unknown[];
      if (typeof dx !== "number" || typeof dy !== "number" || typeof dt !== "number") continue;
      if (!Number.isFinite(dx) || !Number.isFinite(dy) || !Number.isFinite(dt)) continue;
      // A single pointer move of more than a few thousand pixels, or a gap of more than
      // a minute, is not a sample from a person's hand.
      if (Math.abs(dx) > 10_000 || Math.abs(dy) > 10_000 || dt < 0 || dt > 60_000) continue;
      path.push({ dx, dy, dt });
    }
  }

  const layoutHeight = raw["layoutHeight"];

  return {
    trusted: raw["trusted"] === true,
    ...(typeof layoutHeight === "number" && Number.isFinite(layoutHeight) && layoutHeight >= 0 && layoutHeight < 100_000
      ? { layoutHeight }
      : {}),
    via: via === "pointer" || via === "touch" || via === "keyboard" ? via : "other",
    msToActivate: typeof raw["msToActivate"] === "number" && Number.isFinite(raw["msToActivate"]) ? raw["msToActivate"] : 0,
    path,
    capabilities,
  };
}

/**
 * Decides what an interaction report is worth.
 *
 * `elapsedMs` is measured by the server from the signed challenge token, and it is the
 * only argument here that the client cannot influence.
 *
 * ## Why a keyboard activation is not penalised
 *
 * A pointer path is worth something, and its absence is worth nothing either way. Voice
 * control produces no pointer movement; switch access produces machine-regular timing;
 * a screen reader activates the control from the keyboard. Scoring those down would put
 * assistive technology on the wrong side of a check the rest of this library exists to
 * keep people out of, so a keyboard or `other` activation is graded on its capabilities
 * and its timing alone.
 */
export function verifyInteraction(
  report: InteractionReport | undefined,
  elapsedMs: number,
  settings: InteractionSettings = DEFAULT_INTERACTION_SETTINGS,
  expected?: ProbeShape,
): InteractionOutcome {
  if (report === undefined) return { ok: false, reason: "no interaction was reported" };

  // Synthesised events. `element.click()` and `new MouseEvent(...)` both report false,
  // and a client that says false is telling the truth about being automated.
  if (!report.trusted) return { ok: false, reason: "the activation was not a trusted event" };

  // The one check the client cannot lie about: real time passed on this server between
  // handing out the challenge and being handed the answer.
  if (elapsedMs < settings.minElapsedMs) {
    return { ok: false, reason: `answered in ${Math.round(elapsedMs)}ms, sooner than a person reads and acts` };
  }

  // The client's own account of how long it took, checked against the server's. It was
  // parsed and then never read, which left a free consistency check on the table: a
  // client cannot have spent longer deciding than the challenge has existed. A minute of
  // slack absorbs clock skew and a page restored from the back/forward cache.
  if (report.msToActivate > elapsedMs + 60_000) {
    return { ok: false, reason: "the client claims to have taken longer than the challenge has existed" };
  }

  // The one question that is different for every challenge. A report captured from a
  // real browser and replayed carries the previous challenge's answer.
  if (expected !== undefined) {
    const wanted = expected.boxes * expected.height;
    if (report.layoutHeight === undefined) {
      return { ok: false, reason: "the layout probe went unanswered" };
    }
    // A pixel of slack for sub-pixel rounding, and no more: the answer is a product of
    // two integers the page was rendered with.
    if (Math.abs(report.layoutHeight - wanted) > 1) {
      return { ok: false, reason: `the layout probe answered ${report.layoutHeight}px where this challenge asked for ${wanted}px` };
    }
  }

  // The movement has to fit inside the session it claims to have happened in. Checked
  // against the server's own elapsed measurement rather than the client's, so it is a
  // contradiction with something known rather than with something asserted: a path
  // describing eight seconds of pointer movement inside a one-and-a-half second challenge
  // did not happen. Free to check, and fabricated paths are exactly where it bites.
  const claimedMovementMs = report.path.reduce((total, sample) => total + sample.dt, 0);
  if (claimedMovementMs > elapsedMs + 2000) {
    return { ok: false, reason: `the path describes ${Math.round(claimedMovementMs)}ms of movement inside a ${Math.round(elapsedMs)}ms challenge` };
  }

  const notes: string[] = [];
  const capabilityScore = scoreCapabilities(report.capabilities);
  const failed = Object.keys(CAPABILITY_WEIGHTS).filter((name) => report.capabilities[name] !== true);
  // Named rather than summarised. "capabilities 70%" tells an operator that something is
  // wrong; "fontMetrics, animationFrame" tells them whether it is bots or a population
  // whose browsers cannot answer one particular question.
  notes.push(failed.length === 0 ? "capabilities 100%" : `capabilities ${(capabilityScore * 100).toFixed(0)}% (missing: ${failed.join(", ")})`);

  let score = capabilityScore * 0.6;

  // A path long enough to describe is measured. Anything else — a keyboard, a tap, or a
  // mouse that barely moved — is graded on its capabilities alone.
  //
  // Scoring a short pointer path as *zero* was tried first, on the reasoning that a
  // pointer activation showing no movement describes something that did not happen. It
  // was measured and it was wrong in both directions at once. It downgraded honest
  // clients: somebody whose cursor already rested on the control, or who nudged it a few
  // pixels, produced three samples and was marked down for it. And it caught nobody,
  // because `via` is a field the client fills in — an attacker with no path to show
  // simply writes "keyboard" and is graded on capabilities like everybody else. A rule
  // that only ever costs honest people something is not a strict rule, it is a bug.
  //
  // The discrimination that does work is still here: a path of four samples or more that
  // looks interpolated scores zero, and that is a claim about movement the client did
  // report rather than about movement it did not.
  const measurable = report.via === "pointer" && report.path.length >= 4;
  if (measurable) {
    const movement = scoreMovement(analyseMovement(report.path));
    notes.push(`movement ${(movement * 100).toFixed(0)}%`);
    score += movement * 0.4;
  } else {
    notes.push(report.path.length > 0 ? `too little movement to judge (${report.via})` : `no pointer path (${report.via})`);
    score += capabilityScore * 0.4;
  }

  if (score < settings.refuseBelow) {
    return { ok: false, reason: `the browser did not behave like one (${notes.join(", ")})`, score, notes };
  }

  return { ok: true, level: score >= settings.interactionAt ? "interaction" : "pow", score, notes };
}
