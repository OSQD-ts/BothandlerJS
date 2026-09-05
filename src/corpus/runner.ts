import { BotHandler } from "../core.js";
import { DENYING_ACTIONS } from "./schema.js";
import { CORPUS, assertCorpusIntegrity } from "./index.js";
import { CORPUS_CRAWLER_RANGES } from "./ranges.js";
import { ManualClock } from "../internal/clock.js";
import { createFacts } from "../facts.js";
import type { Assessment, RequestFacts } from "../types.js";
import type { ActionName, Decision } from "../policy/types.js";
import type { ActionOutcome } from "../actions/types.js";
import type { DnsResolver } from "../internal/dns.js";
import type { Audience, CaseRequest, Expectation, TrafficCase } from "./schema.js";

/**
 * The harness.
 *
 * It takes a factory rather than a handler because the corpus tests **your**
 * configuration, not the defaults. Hand it whatever you run in production and it will
 * tell you what that policy does to every shape of traffic in the corpus — including,
 * and this is the part worth reading, which of them are people.
 *
 * Two things it controls that a real deployment does not:
 *
 * - **DNS.** No lookup leaves the process. Each case declares the answers it wants,
 *   so the difference between "the operator's DNS disproves this claim" and "our
 *   resolver was briefly unhappy" can actually be tested. Those must reach different
 *   verdicts, and only a controlled resolver can prove they do.
 * - **Time.** A `ManualClock` advances by each request's `atMs`, so rate and cadence
 *   are exercised deterministically. A corpus that slept would take hours and still
 *   be flaky.
 */

export interface RunnerOptions {
  /** Builds the handler under test. The runner supplies the resolver and the clock. */
  create: (dependencies: { resolver: DnsResolver; clock: ManualClock }) => BotHandler;
  cases?: readonly TrafficCase[];
  /**
   * Load the corpus's fictional crawler ranges into the handler. Default true.
   *
   * Without them the `ip-ranges` verification cases cannot pass, because the library
   * ships no address data and correctly refuses to guess.
   */
  applyCorpusRanges?: boolean;
  /** Epoch ms the first request of every case is stamped with. */
  startedAt?: number;
  /**
   * Capability names the handler under test provides, matched against a case's
   * `requires`. A case naming something absent here is skipped and reported.
   */
  provides?: readonly string[];
  /**
   * Assert each case's `expect.action`. Default true.
   *
   * Turn it off when running the corpus across several policies. Which *action* a
   * case receives is a property of the policy — a case that is allowed under one
   * preset is logged under another and both are correct — whereas the verdict, the
   * certainty and `neverAction` are properties of the traffic and hold everywhere.
   * `neverAction` is always asserted, because it is the invariant, not a preference.
   */
  assertActions?: boolean;
}

export interface RequestResult {
  assessment: Assessment;
  decision: Decision;
  outcome: ActionOutcome;
}

export interface CaseResult {
  case: TrafficCase;
  /** Every request in the case, in order. */
  requests: RequestResult[];
  /** The request expectations are asserted against — the last one. */
  final: RequestResult;
  /** Human-readable expectation violations. Empty means the case passed. */
  failures: string[];
  /** Set when a case marked `human` was denied service. The failure that matters most. */
  falsePositive: boolean;
  /** Why the case did not run, when it did not. Never counted as a pass. */
  skipped?: string;
  durationMs: number;
}

export interface AudienceTally {
  total: number;
  passed: number;
  failed: number;
  actions: Record<string, number>;
}

export interface Scorecard {
  results: CaseResult[];
  total: number;
  passed: number;
  failed: number;
  /** Human cases that were denied service. Must be empty. */
  falsePositives: CaseResult[];
  /** Cases the handler under test was not configured to exercise. */
  skipped: CaseResult[];
  /**
   * People whose client software declares itself automated.
   *
   * Exempt from the never-deny rule by construction, and listed here so that the
   * exemption is visible in every report rather than buried in a flag.
   */
  selfDeclaredHumans: CaseResult[];
  byAudience: Record<Audience, AudienceTally>;
  byCategory: Record<string, { total: number; failed: number }>;
  /** How many cases each detector produced evidence on. */
  detectorCoverage: Record<string, number>;
  /**
   * Detectors installed in the handler that no case exercised.
   *
   * A gap in the corpus, not in the library: an untested detector is one whose next
   * regression nobody will notice.
   */
  unexercisedDetectors: string[];
  /** Proven-verdict rate among cases that are genuinely automated. */
  provenAutomation: { total: number; proven: number };
  durationMs: number;
}

const DEFAULT_START = Date.UTC(2026, 7, 30, 9, 0, 0);

/**
 * Derives a stable address for a case from its id.
 *
 * Distinct per case, so no case inherits another's behavioural history, and stable
 * across runs, so a failure is reproducible. Drawn from 198.18.0.0/15, which RFC 2544
 * reserves for benchmarking — it cannot collide with anything real, and its meaning is
 * exactly what this is.
 */
export function addressFor(id: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  const value = hash >>> 0;
  return `198.18.${(value >> 8) & 0xff}.${(value & 0xff) || 1}`;
}

/** Answers from the case's own map. Absent names are NXDOMAIN — a definitive negative. */
function caseResolver(current: () => TrafficCase | undefined): DnsResolver {
  const notFound = (): never => {
    throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
  };
  const unavailable = (): never => {
    throw Object.assign(new Error("timed out"), { code: "ETIMEOUT" });
  };
  return {
    async reverse(ip) {
      const dns = current()?.dns;
      if (dns === undefined) return notFound();
      if (dns.unavailable === true) return unavailable();
      const names = dns.reverse?.[ip];
      return names === undefined ? notFound() : [...names];
    },
    async resolveAddresses(hostname) {
      const dns = current()?.dns;
      if (dns === undefined) return notFound();
      if (dns.unavailable === true) return unavailable();
      const addresses = dns.forward?.[hostname];
      return addresses === undefined ? notFound() : [...addresses];
    },
  };
}

function toFacts(request: CaseRequest, fallbackIp: string, timestamp: number): RequestFacts {
  const headers: Record<string, string | string[]> = {};
  const order: string[] = [];
  for (const [name, value] of request.headers) {
    const key = name.toLowerCase();
    const existing = headers[key];
    headers[key] = existing === undefined ? value : Array.isArray(existing) ? [...existing, value] : [existing, value];
    order.push(name);
  }

  return createFacts({
    method: request.method ?? "GET",
    url: request.path ?? "/",
    headers,
    rawHeaders: order,
    ip: request.ip ?? fallbackIp,
    timestamp,
    protocol: request.protocol ?? "https",
    httpVersion: request.httpVersion ?? "1.1",
    ...(request.tlsFingerprint !== undefined ? { tlsFingerprint: request.tlsFingerprint } : {}),
    ...(request.partialHeaders === true ? { partialHeaders: true } : {}),
  });
}

function asArray<T>(value: T | readonly T[] | undefined): readonly T[] | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? (value as readonly T[]) : [value as T];
}

function checkExpectations(item: TrafficCase, result: RequestResult, assertActions: boolean): string[] {
  const { assessment, decision, outcome } = result;
  const expect: Expectation = item.expect;
  const failures: string[] = [];

  const verdicts = asArray(expect.verdict);
  if (verdicts && !verdicts.includes(assessment.verdict)) {
    failures.push(`verdict was "${assessment.verdict}", expected ${verdicts.map((v) => `"${v}"`).join(" or ")}`);
  }

  const classes = asArray(expect.botClass);
  if (classes && !classes.includes(assessment.botClass)) {
    failures.push(`botClass was "${assessment.botClass}", expected ${classes.map((c) => `"${c}"`).join(" or ")}`);
  }

  if (expect.certain !== undefined && assessment.certain !== expect.certain) {
    failures.push(`certain was ${assessment.certain}, expected ${expect.certain}`);
  }

  if (expect.identity !== undefined) {
    const identities = new Set([assessment.identity, ...assessment.evidence.map((e) => e.identity)].filter(Boolean));
    if (!identities.has(expect.identity)) {
      failures.push(`identity "${expect.identity}" not established (saw ${[...identities].join(", ") || "none"})`);
    }
  }

  if (expect.minScore !== undefined && assessment.score < expect.minScore) {
    failures.push(`score was ${assessment.score}, expected at least ${expect.minScore}`);
  }
  if (expect.maxScore !== undefined && assessment.score > expect.maxScore) {
    failures.push(`score was ${assessment.score}, expected at most ${expect.maxScore}`);
  }

  const fired = new Set([...assessment.evidence, ...assessment.humanEvidence].map((e) => e.detector));
  for (const detector of expect.detectors ?? []) {
    if (!fired.has(detector)) failures.push(`expected detector "${detector}" to fire; it did not (fired: ${[...fired].join(", ") || "none"})`);
  }
  for (const detector of expect.notDetectors ?? []) {
    if (fired.has(detector)) {
      const summary = [...assessment.evidence, ...assessment.humanEvidence].find((e) => e.detector === detector)?.summary ?? "";
      failures.push(`detector "${detector}" fired but should not have: ${summary}`);
    }
  }

  const actions = assertActions ? asArray(expect.action) : undefined;
  if (actions && !actions.includes(decision.action)) {
    failures.push(`action was "${decision.action}" (rule "${decision.rule}"), expected ${actions.map((a) => `"${a}"`).join(" or ")}`);
  }
  for (const action of expect.neverAction ?? []) {
    if (decision.action === action) failures.push(`action "${action}" is forbidden for this case (rule "${decision.rule}")`);
  }

  if (expect.outcome !== undefined && outcome.kind !== expect.outcome) {
    failures.push(`outcome was "${outcome.kind}", expected "${expect.outcome}" (decision was "${decision.action}")`);
  }

  return failures;
}

export async function runCase(handler: BotHandler, clock: ManualClock, item: TrafficCase, startedAt: number, provides: ReadonlySet<string>, assertActions = true): Promise<CaseResult> {
  const missing = (item.requires ?? []).filter((capability) => !provides.has(capability));
  if (missing.length > 0) {
    return {
      case: item,
      requests: [],
      final: undefined as unknown as RequestResult,
      failures: [],
      falsePositive: false,
      skipped: `needs configuration this handler does not provide: ${missing.join(", ")}`,
      durationMs: 0,
    };
  }

  const fallbackIp = addressFor(item.id);
  const requests: RequestResult[] = [];
  const began = performance.now();

  // Clearance is minted by the handler under test, because only it holds the signing
  // secret. The cookie is bound to the actor, so it is derived from the same facts the
  // case will actually present.
  let clearanceCookie: string | undefined;
  if (item.clearance !== undefined) {
    clock.set(startedAt);
    const seed = toFacts(item.requests[0]!, fallbackIp, clock.now());
    clearanceCookie = handler.grantClearance(seed, item.clearance)?.split(";")[0];
  }

  for (const request of item.requests) {
    clock.set(startedAt + (request.atMs ?? 0));
    const withClearance: CaseRequest =
      clearanceCookie === undefined ? request : { ...request, headers: [...request.headers, ["Cookie", clearanceCookie]] };
    const facts = toFacts(withClearance, fallbackIp, clock.now());
    const { assessment, decision, outcome } = await handler.handle(facts);
    requests.push({ assessment, decision, outcome });
  }

  const final = requests[requests.length - 1]!;
  const failures = checkExpectations(item, final, assertActions);

  // The audience rule, applied to every request in the case rather than only the
  // last: a person denied on request seven is still a person denied.
  let falsePositive = false;
  // A person whose client declares itself a bot is exempt from the audience rule and
  // counted separately. See `TrafficCase.selfDeclared`.
  if (item.audience === "human" && item.selfDeclared === undefined) {
    for (const [index, result] of requests.entries()) {
      if (DENYING_ACTIONS.includes(result.decision.action)) {
        falsePositive = true;
        failures.push(
          `FALSE POSITIVE: request ${index + 1}/${requests.length} from a person was ${result.decision.action}ed by rule "${result.decision.rule}" ` +
            `(${result.assessment.verdict}, ${result.assessment.certain ? "proven" : `score ${result.assessment.score}`})`,
        );
      }
    }
  }

  return { case: item, requests, final, failures, falsePositive, durationMs: performance.now() - began };
}

const AUDIENCES: readonly Audience[] = ["human", "benign-bot", "declared-bot", "unwanted-bot", "hostile", "infrastructure"];

export async function runCorpus(options: RunnerOptions): Promise<Scorecard> {
  const cases = options.cases ?? CORPUS;
  assertCorpusIntegrity(cases);

  const startedAt = options.startedAt ?? DEFAULT_START;
  const clock = new ManualClock(startedAt);
  let current: TrafficCase | undefined;
  const handler = options.create({ resolver: caseResolver(() => current), clock });

  if (options.applyCorpusRanges !== false) {
    for (const [id, entries] of Object.entries(CORPUS_CRAWLER_RANGES)) handler.updateCrawlerRanges(id, entries);
  }

  const provides = new Set(options.provides ?? []);
  // Loading the ranges *is* providing the capability, so cases that depend on them do
  // not have to be listed by every caller. A harness that switches the ranges off
  // correctly skips those cases instead of failing them.
  if (options.applyCorpusRanges !== false) provides.add("crawler-ranges");
  const began = performance.now();
  const results: CaseResult[] = [];
  for (const item of cases) {
    current = item;
    results.push(await runCase(handler, clock, item, startedAt, provides, options.assertActions !== false));
  }
  current = undefined;

  const byAudience = Object.fromEntries(AUDIENCES.map((audience) => [audience, { total: 0, passed: 0, failed: 0, actions: {} as Record<string, number> }])) as Record<Audience, AudienceTally>;
  const byCategory: Record<string, { total: number; failed: number }> = {};
  const detectorCoverage: Record<string, number> = {};
  let passed = 0;
  let provenTotal = 0;
  let proven = 0;

  for (const result of results) {
    if (result.skipped !== undefined) continue;
    const tally = byAudience[result.case.audience];
    tally.total++;
    const action: ActionName = result.final.decision.action;
    tally.actions[action] = (tally.actions[action] ?? 0) + 1;

    const category = (byCategory[result.case.category] ??= { total: 0, failed: 0 });
    category.total++;

    if (result.failures.length === 0) {
      passed++;
      tally.passed++;
    } else {
      tally.failed++;
      category.failed++;
    }

    const fired = new Set<string>();
    for (const request of result.requests) {
      for (const item of [...request.assessment.evidence, ...request.assessment.humanEvidence]) fired.add(item.detector);
    }
    for (const detector of fired) detectorCoverage[detector] = (detectorCoverage[detector] ?? 0) + 1;

    if (result.case.audience !== "human" && result.case.audience !== "infrastructure") {
      provenTotal++;
      if (result.final.assessment.certain) proven++;
    }
  }

  const installed = handler.describeDetectors().map((entry) => entry.id);
  const unexercisedDetectors = installed.filter((id) => detectorCoverage[id] === undefined);

  const skipped = results.filter((result) => result.skipped !== undefined);

  return {
    results,
    total: results.length - skipped.length,
    passed,
    failed: results.length - skipped.length - passed,
    falsePositives: results.filter((result) => result.falsePositive),
    selfDeclaredHumans: results.filter((result) => result.case.audience === "human" && result.case.selfDeclared !== undefined),
    skipped,
    byAudience,
    byCategory,
    detectorCoverage,
    unexercisedDetectors,
    provenAutomation: { total: provenTotal, proven },
    durationMs: performance.now() - began,
  };
}
