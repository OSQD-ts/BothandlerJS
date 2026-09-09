import { ActorState } from "../src/state.js";
import type { MarkerObservation } from "../src/probe/index.js";
import type { SiteProfile } from "../src/site/index.js";
import { ManualClock } from "../src/internal/clock.js";
import { compileSignatures } from "../src/detectors/known-bots.js";
import { createFacts } from "../src/facts.js";
import { parseUserAgent } from "../src/internal/ua.js";
import type { DetectionContext } from "../src/detectors/types.js";
import type { DnsResolver } from "../src/internal/dns.js";
import type { Evidence, RequestFacts } from "../src/types.js";
import { IpRangeSet } from "../src/internal/ip.js";

/** A header set a current Chrome actually sends for a top-level navigation over HTTPS. */
export const CHROME_HEADERS: Record<string, string> = {
  host: "example.test",
  connection: "keep-alive",
  "sec-ch-ua": '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"macOS"',
  "upgrade-insecure-requests": "1",
  "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "sec-fetch-site": "none",
  "sec-fetch-mode": "navigate",
  "sec-fetch-user": "?1",
  "sec-fetch-dest": "document",
  "accept-encoding": "gzip, deflate, br",
  "accept-language": "en-GB,en;q=0.9",
};

export const CHROME_HEADER_ORDER = Object.keys(CHROME_HEADERS);

export interface ContextOptions {
  headers?: Record<string, string>;
  headerOrder?: readonly string[];
  path?: string;
  method?: string;
  ip?: string;
  protocol?: "http" | "https";
  httpVersion?: string;
  timestamp?: number;
  ranges?: Record<string, string[]>;
  resolver?: DnsResolver;
  state?: ActorState;
  marker?: MarkerObservation;
  /** A JA3/JA4 handshake fingerprint, as an edge would forward it. */
  tlsFingerprint?: string;
  site?: SiteProfile;
  extra?: Record<string, unknown>;
}

export function makeFacts(options: ContextOptions = {}): RequestFacts {
  const headers = options.headers ?? CHROME_HEADERS;
  return createFacts({
    method: options.method ?? "GET",
    url: options.path ?? "/",
    headers,
    rawHeaders: options.headerOrder ?? Object.keys(headers),
    ip: options.ip ?? "203.0.113.10",
    timestamp: options.timestamp ?? 1_700_000_000_000,
    protocol: options.protocol ?? "https",
    httpVersion: options.httpVersion ?? "1.1",
    ...(options.extra !== undefined ? { extra: options.extra } : {}),
    ...(options.tlsFingerprint !== undefined ? { tlsFingerprint: options.tlsFingerprint } : {}),
  });
}

export function makeContext(options: ContextOptions = {}): DetectionContext {
  const facts = makeFacts(options);
  const state = options.state ?? new ActorState(facts.ip, facts.timestamp);
  if (!options.state) state.record(facts);
  const signatures = compileSignatures();
  const ua = parseUserAgent(facts.headers["user-agent"]);

  const ranges = new Map<string, IpRangeSet>();
  for (const [name, entries] of Object.entries(options.ranges ?? {})) ranges.set(name, new IpRangeSet(entries));

  return {
    facts,
    ua,
    marker: options.marker,
    site: options.site,
    actor: state.snapshot(facts.timestamp),
    state,
    clock: new ManualClock(facts.timestamp),
    signatures,
    signatureMatches: ua.lower.length > 0 ? signatures.matchAll(ua.lower) : [],
    resolver: options.resolver ?? failingResolver(),
    ranges,
    shared: new Map<string, unknown>(),
  };
}

/** Resolves nothing. Stands in for "we could not get an answer", which must never accuse. */
export function failingResolver(): DnsResolver {
  return {
    reverse: () => Promise.reject(Object.assign(new Error("timeout"), { code: "ETIMEOUT" })),
    resolveAddresses: () => Promise.reject(Object.assign(new Error("timeout"), { code: "ETIMEOUT" })),
  };
}

/** A resolver with a fixed forward and reverse map, for exercising FCrDNS both ways. */
export function fakeResolver(reverse: Record<string, string[]>, forward: Record<string, string[]>): DnsResolver {
  const notFound = (): never => {
    throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
  };
  return {
    reverse: async (ip) => reverse[ip] ?? notFound(),
    resolveAddresses: async (hostname) => forward[hostname] ?? notFound(),
  };
}

/** Runs a detector and normalises its result to an array. */
export async function collect(detector: { inspect: (context: DetectionContext) => unknown }, context: DetectionContext): Promise<Evidence[]> {
  const result = await detector.inspect(context);
  if (result === undefined || result === null) return [];
  return Array.isArray(result) ? (result as Evidence[]) : [result as Evidence];
}
