import type { ActionName } from "../policy/types.js";
import type { BotClass, Verdict } from "../types.js";

/**
 * The corpus schema.
 *
 * This is a body of *realistic web traffic* — real User-Agent strings, real header
 * sets in the order real clients send them, real behavioural shapes — paired with
 * what the library ought to conclude about each. It exists to answer one question
 * that no unit test can:
 *
 *   > If I point this configuration at the actual internet, who gets hurt?
 *
 * The corpus is deliberately separate from the configuration it tests. Point the
 * runner at your own `BotHandler` and it tells you how *your* policy behaves against
 * every shape of traffic in here — not how the defaults behave.
 *
 * ## Adding cases
 *
 * Add to the file matching the audience, or create a new file and register it in
 * `index.ts`. Every case needs `provenance`: where the shape came from. A fixture
 * somebody invented is worth much less than one copied from a log, and six months
 * later nobody can tell them apart unless it is written down.
 */

/**
 * Who is behind the request — and, more to the point, what it costs to be wrong.
 *
 * This is the axis that matters, because the corpus's central assertion is expressed
 * in terms of it: **no case marked `human` may ever be denied service.** That check
 * runs against every case in the corpus regardless of what its own expectations say,
 * so a new human case protects you the moment it is added.
 */
export type Audience =
  /** A person. Being wrong here means turning away a customer. */
  | "human"
  /** Automation almost every site wants: search crawlers, link unfurlers, uptime monitors. */
  | "benign-bot"
  /** Honest automation whose treatment is a business decision, not a security one. */
  | "declared-bot"
  /** Automation most sites would rather not serve: aggressive SEO, bulk extraction. */
  | "unwanted-bot"
  /** Scanners, forged identities, credential attacks. */
  | "hostile"
  /** Something in the middle of the path: a proxy, a CDN, a corporate gateway. */
  | "infrastructure";

/** One HTTP request, as a client would actually send it. */
export interface CaseRequest {
  method?: string;
  /** Path plus query, as it appears on the request line. */
  path?: string;
  /**
   * Headers **in the order the client sends them**.
   *
   * A tuple list rather than an object, because order is itself a fingerprint and an
   * object literal's key order is too easy to disturb by accident. `headers.ts` builds
   * these for the real browsers.
   */
  headers: ReadonlyArray<readonly [name: string, value: string]>;
  ip?: string;
  protocol?: "http" | "https";
  httpVersion?: string;
  tlsFingerprint?: string;
  /** Milliseconds after the case's start time. Drives the behavioural detectors. */
  atMs?: number;
  /**
   * What the application answered, if the case is about that.
   *
   * The engine decides before a response exists, so this is reported back afterwards the
   * way an adapter reports it. Only cases about response shape need it — a scan that is
   * almost all misses being the one that matters.
   */
  status?: number;
  /** The source could not supply the full header set. See `RequestFacts.partialHeaders`. */
  partialHeaders?: boolean;
}

export type OneOrMany<T> = T | readonly T[];

/** What the library should conclude. Every field is optional; absent means "don't care". */
export interface Expectation {
  verdict?: OneOrMany<Verdict>;
  botClass?: OneOrMany<BotClass>;
  /** Whether the conclusion must rest on proven evidence. */
  certain?: boolean;
  /** Established or claimed identity, e.g. `"googlebot"`. */
  identity?: string;
  minScore?: number;
  maxScore?: number;
  /** Detectors that must all have produced evidence. */
  detectors?: readonly string[];
  /** Detectors that must not have fired. The false-positive guard, stated per case. */
  notDetectors?: readonly string[];
  /** Actions that are acceptable. */
  action?: OneOrMany<ActionName>;
  /** Actions that must never be taken. Enforced in addition to the audience rule. */
  neverAction?: readonly ActionName[];
  /**
   * What the action layer actually did, which is not always what the policy decided.
   *
   * A decision to challenge an actor that already holds clearance is refused and the
   * request is served instead — the guard that stops a proven bot from looping on the
   * challenge forever. That distinction is invisible from `action` alone.
   */
  outcome?: "continue" | "respond" | "drop";
}

export interface TrafficCase {
  /** Stable, unique, kebab-case. Appears in every report; treat it as an identifier. */
  id: string;
  title: string;
  audience: Audience;
  /** Finer grouping within an audience, e.g. `"desktop-browser"`, `"ai-crawler"`. */
  category: string;
  /**
   * Where this shape came from: a published User-Agent list, a vendor's documentation,
   * an observed log line, a specification. Required — a fixture nobody can trace is a
   * fixture nobody can update when the world moves.
   */
  provenance: string;
  /** Anything a reader needs in order to judge whether the expectation is right. */
  notes?: string;
  /** A single request, or an ordered sequence from one actor. */
  requests: readonly CaseRequest[];
  expect: Expectation;
  tags?: readonly string[];
  /**
   * Configuration this case depends on, as free-text capability names.
   *
   * Some traffic can only be classified by a detector that has been *told* something
   * — the trap detector cannot recognise a honeypot form field whose name it was
   * never given. Rather than quietly failing against a default configuration, such a
   * case declares what it needs; the runner skips it and says so when the handler
   * under test does not provide it. A skipped case is reported, never counted as a
   * pass, because "we did not check" and "it worked" must not look the same.
   */
  requires?: readonly string[];
  /**
   * Mint a clearance token for this actor before the case runs, and attach it to
   * every request.
   *
   * The token has to be signed by the handler under test, so the corpus cannot carry
   * a literal cookie — it declares the level it wants and the runner asks the handler
   * for one. `operator` is the only level the library treats as conclusive proof of a
   * person, because it is an assertion by your application rather than an inference
   * from the request.
   */
  clearance?: "pow" | "interaction" | "operator";
  /**
   * A person whose *client software* declares itself automated, and why.
   *
   * The never-deny guarantee attached to `human` cases is a promise about guesses:
   * nobody is refused on the strength of an inference. It is not a promise that the
   * library can see through a client that announces itself as a bot. A podcast
   * application uses one User-Agent both to fetch feeds and to open the links a
   * listener taps; when the listener taps one, the library reads the declaration the
   * software made and is correct to.
   *
   * Setting this exempts the case from the audience rule and, crucially, lists it in
   * the scorecard under its own heading. These are the people the design knowingly
   * cannot protect, and the corpus makes them countable rather than invisible.
   */
  selfDeclared?: string;
  /**
   * DNS the runner should present while this case runs.
   *
   * Forward-confirmed reverse DNS is the only mechanism that can produce a
   * `verified-bot` or prove an `impersonator`, so a corpus that cannot control DNS
   * cannot test the two most consequential verdicts the library reaches. `reverse`
   * maps address to PTR names; `forward` maps name to addresses. A name absent from
   * either map resolves to NXDOMAIN, which is a *definitive* negative answer — the
   * runner never presents a timeout unless a case asks for one, because "no answer"
   * and "the wrong answer" must lead to different verdicts.
   */
  dns?: {
    reverse?: Readonly<Record<string, readonly string[]>>;
    forward?: Readonly<Record<string, readonly string[]>>;
    /** Make every lookup time out, to exercise the indeterminate path. */
    unavailable?: boolean;
  };
}

/** Terminal actions. A human case reaching any of these is a corpus failure. */
export const DENYING_ACTIONS: readonly ActionName[] = ["block", "drop", "redirect"];

/**
 * Declares a case involving a person.
 *
 * Adds the never-deny guarantee automatically, so it cannot be forgotten, and defaults
 * the verdict expectation to "not classified as a bot". Override `expect` for the
 * awkward cases — and there are several, because some real people do look automated.
 */
export function human(input: Omit<TrafficCase, "audience"> & { audience?: never }): TrafficCase {
  return {
    ...input,
    audience: "human",
    expect: {
      neverAction: DENYING_ACTIONS,
      ...input.expect,
    },
  };
}

/** Declares a case involving automation. No implicit guarantees; say what you mean. */
export function bot(input: TrafficCase): TrafficCase {
  return input;
}

/** Repeats a request `count` times at a fixed interval. For rate and cadence shapes. */
export function repeat(template: CaseRequest, count: number, everyMs: number, pathAt?: (index: number) => string): CaseRequest[] {
  return Array.from({ length: count }, (_, index) => ({
    ...template,
    ...(pathAt ? { path: pathAt(index) } : {}),
    atMs: index * everyMs,
  }));
}

/**
 * Repeats a request with *human* pacing — irregular gaps drawn from a fixed sequence.
 *
 * Deterministic on purpose. A corpus that uses a random number generator produces a
 * different verdict on Tuesday than it did on Monday, and then nobody trusts it.
 */
const HUMAN_GAPS_MS = [1_400, 8_200, 3_100, 21_000, 2_600, 47_000, 5_900, 1_100, 12_400, 3_800, 64_000, 2_200, 9_700, 1_800];

export function humanPaced(template: CaseRequest, paths: readonly string[]): CaseRequest[] {
  let at = 0;
  return paths.map((path, index) => {
    if (index > 0) at += HUMAN_GAPS_MS[(index - 1) % HUMAN_GAPS_MS.length]!;
    return { ...template, path, atMs: at };
  });
}
