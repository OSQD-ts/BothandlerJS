/**
 * DNS access for crawler identity verification.
 *
 * The distinction this module exists to preserve is between *disproof* and *no
 * answer*, and it is the load-bearing detail of the whole no-false-positive design.
 *
 * A reverse lookup that succeeds and returns `crawl-66-249-66-1.googlebot.com` for a
 * client claiming to be Googlebot **confirms** the claim. One that succeeds and
 * returns `some-vps.example.net` **disproves** it. One that times out, hits SERVFAIL,
 * or finds no resolver at all proves nothing whatsoever — and must never be allowed
 * to look like disproof, because "our resolver was briefly unhappy" would otherwise
 * become "we blocked Googlebot".
 */

/** The subset of `node:dns/promises` this library uses. Inject your own for tests or a custom resolver. */
export interface DnsResolver {
  /** PTR names for an address. Rejects on NXDOMAIN. */
  reverse(ip: string): Promise<string[]>;
  /** A and AAAA records for a name. Rejects on NXDOMAIN. */
  resolveAddresses(hostname: string): Promise<string[]>;
}

export type VerificationOutcome =
  /** DNS confirmed the claimed identity. Deterministic. */
  | { status: "verified"; hostname: string }
  /**
   * DNS answered, and the answer contradicts the claim. Deterministic.
   *
   * `cause` is what callers should branch on. One of them offers an option to stop
   * treating a missing PTR as forgery, and it used to implement that by searching
   * `reason` for the words "no PTR record" — so rewording a human-readable sentence
   * silently turned an operator's explicit opt-out into a no-op.
   */
  | { status: "contradicted"; cause: "no-ptr" | "wrong-domain" | "no-forward-record" | "address-mismatch"; reason: string; hostname?: string | undefined }
  /** No usable answer. Proves nothing; produces no evidence in either direction. */
  | { status: "indeterminate"; reason: string };

/** Node-backed resolver. Imported lazily so the library stays loadable on edge runtimes. */
export function nodeDnsResolver(timeoutMs = 1500): DnsResolver {
  let promised: Promise<typeof import("node:dns/promises")> | undefined;
  const load = (): Promise<typeof import("node:dns/promises")> => (promised ??= import("node:dns/promises"));

  const guard = async <T>(work: Promise<T>): Promise<T> => {
    // A per-call deadline on top of the engine's own: the resolver library has its
    // own retry behaviour that can outlive a single lookup's usefulness.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new DnsTimeoutError()), timeoutMs);
          (timer as { unref?: () => void }).unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  return {
    async reverse(ip) {
      const dns = await load();
      return guard(dns.reverse(ip));
    },
    async resolveAddresses(hostname) {
      const dns = await load();
      const [v4, v6] = await Promise.allSettled([guard(dns.resolve4(hostname)), guard(dns.resolve6(hostname))]);
      const addresses = [
        ...(v4.status === "fulfilled" ? v4.value : []),
        ...(v6.status === "fulfilled" ? v6.value : []),
      ];
      if (addresses.length > 0) return addresses;

      // Nothing came back, and *why* decides a crawler's fate. Swallowing both
      // rejections into an empty array — as this did — makes a resolver timeout
      // indistinguishable from a name that genuinely has no address records, and the
      // caller reads an empty forward answer as a failed forward confirmation. A
      // thirty-second DNS blip therefore proved Googlebot to be an impersonator, which
      // is the precise failure this module's design exists to prevent. A rejection we
      // cannot interpret is re-raised so it degrades to `indeterminate`; only an
      // authoritative "no such record" is allowed to come back as an empty answer.
      const rejections = [v4, v6].filter((result) => result.status === "rejected").map((result) => result.reason as unknown);
      const inconclusive = rejections.find((reason) => !isDefinitiveAbsence(reason));
      if (inconclusive !== undefined) throw inconclusive;
      return addresses;
    },
  };
}

export class DnsTimeoutError extends Error {
  override readonly name = "DnsTimeoutError";
  /**
   * Carried so the timeout reads as a timeout everywhere a DNS error's code is
   * inspected — the cache's replay, and the reason string an operator sees when a
   * crawler could not be verified. Deliberately not one of {@link DEFINITIVE_ABSENCE}:
   * a lookup that ran out of time has said nothing about whether the name exists.
   */
  readonly code = "ETIMEDOUT";
  constructor() {
    super("DNS lookup timed out");
  }
}

/** DNS error codes that mean "this name definitively does not exist". */
const DEFINITIVE_ABSENCE = new Set(["ENOTFOUND", "ENODATA", "NXDOMAIN"]);

/**
 * Classifies a DNS rejection. `true` means the negative answer is authoritative and
 * may be treated as a contradiction; `false` means we simply did not get an answer.
 */
export function isDefinitiveAbsence(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && DEFINITIVE_ABSENCE.has(code);
}

/** True when `hostname` is `domain` itself or a subdomain of it. Never a substring match. */
export function isUnderDomain(hostname: string, domain: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  const suffix = domain.toLowerCase().replace(/^\.|\.$/g, "");
  return host === suffix || host.endsWith(`.${suffix}`);
}

/**
 * Forward-confirmed reverse DNS.
 *
 * 1. PTR the client IP.
 * 2. Require at least one name under one of `domains` — a *suffix* match on label
 *    boundaries, so `googlebot.com.evil.net` does not pass.
 * 3. Forward-resolve that name and require the original IP back, which is what stops
 *    anyone who controls a PTR record for their own address from claiming to be
 *    Googlebot.
 */
export async function forwardConfirmedReverseDns(
  resolver: DnsResolver,
  ip: string,
  domains: readonly string[],
): Promise<VerificationOutcome> {
  let names: string[];
  try {
    names = await resolver.reverse(ip);
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return { status: "contradicted", cause: "no-ptr", reason: "address has no PTR record, which every operator of a verifiable crawler publishes" };
    }
    return { status: "indeterminate", reason: `reverse lookup failed: ${errorCode(error)}` };
  }

  if (names.length === 0) {
    return { status: "contradicted", cause: "no-ptr", reason: "address has no PTR record, which every operator of a verifiable crawler publishes" };
  }

  const candidate = names.find((name) => domains.some((domain) => isUnderDomain(name, domain)));
  if (candidate === undefined) {
    return { status: "contradicted", cause: "wrong-domain", reason: `PTR record ${names[0]!} is not under ${domains.join(", ")}` };
  }

  let addresses: string[];
  try {
    addresses = await resolver.resolveAddresses(candidate);
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return { status: "contradicted", cause: "no-forward-record", reason: `PTR name ${candidate} does not resolve forward` };
    }
    return { status: "indeterminate", reason: `forward lookup failed: ${errorCode(error)}` };
  }

  // An authoritative empty answer: the PTR name exists but publishes no address, so
  // it cannot forward-confirm. Stated separately from a mismatch because "resolves to
  // nothing" and "resolves to somewhere else" are different accusations, and the
  // reason string ends up in an operator's logs.
  if (addresses.length === 0) {
    return { status: "contradicted", cause: "no-forward-record", reason: `PTR name ${candidate} does not resolve forward` };
  }

  // Compare normalised bytes, not strings: the forward answer may spell an IPv6
  // address differently from the way the socket reported it.
  const { normalizeIp } = await import("./ip.js");
  const target = normalizeIp(ip);
  const confirmed = addresses.some((address) => normalizeIp(address) === target);
  if (!confirmed) {
    return { status: "contradicted", cause: "address-mismatch", reason: `PTR name ${candidate} resolves to ${addresses.slice(0, 3).join(", ")}, not ${ip}` };
  }
  return { status: "verified", hostname: candidate };
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "unknown";
}

type CacheEntry = { expiresAt: number } & ({ ok: true; value: string[] } | { ok: false; code: string });

/**
 * A remembered failure, replayed with the code the original carried.
 *
 * The code is the whole point. Caching failures as an undifferentiated sentinel and
 * rethrowing a bare `Error` erased the one bit that matters — whether the resolver
 * said "no such name" or said nothing — so a forged crawler was proven an impersonator
 * on its first request and downgraded to `indeterminate` for every request after it,
 * for as long as the entry lived. The cache silently undid the detection it was there
 * to make affordable.
 */
class CachedDnsError extends Error {
  override readonly name = "CachedDnsError";
  constructor(readonly code: string) {
    super(`cached DNS failure (${code})`);
  }
}

export interface CachingResolverOptions {
  /** How long a successful answer is reused, ms. Default 3600000 (1h). */
  ttlMs?: number;
  /**
   * How long a failure is remembered, ms. Default 60000.
   *
   * Much shorter than the success TTL on purpose. Caching a failure for an hour would
   * turn a one-minute resolver blip into an hour of unverified Googlebot, and the
   * cost of retrying is one lookup.
   */
  errorTtlMs?: number;
  /** Maximum names and addresses cached. Default 10000. */
  max?: number;
}

/**
 * Memoises lookups.
 *
 * Verification would otherwise resolve DNS twice for *every* request from a crawler,
 * which for a site Googlebot likes is thousands of lookups an hour for an answer that
 * changes approximately never. Caching here rather than inside the detector keeps it
 * at the layer where the data is genuinely cacheable, and lets you swap the whole
 * resolver out in tests without losing it.
 */
export function cachingResolver(inner: DnsResolver, options: CachingResolverOptions = {}): DnsResolver {
  const ttlMs = options.ttlMs ?? 3_600_000;
  const errorTtlMs = options.errorTtlMs ?? 60_000;
  const max = options.max ?? 10_000;
  const cache = new Map<string, CacheEntry>();
  /**
   * Lookups already in flight, so that N concurrent requests from one crawler cost one
   * query rather than N. Without this the cache helps only *after* the first answer
   * lands, which is the wrong half of the problem: a crawler's requests arrive in
   * bursts, so the miss that matters is the one a hundred requests take simultaneously.
   */
  const inFlight = new Map<string, Promise<string[]>>();

  const lookup = (key: string, work: () => Promise<string[]>): Promise<string[]> => {
    const now = Date.now();
    const hit = cache.get(key);
    if (hit !== undefined && hit.expiresAt > now) {
      return hit.ok ? Promise.resolve(hit.value) : Promise.reject(new CachedDnsError(hit.code));
    }
    const pending = inFlight.get(key);
    if (pending !== undefined) return pending;

    const query = work().then(
      (value) => {
        store(key, { ok: true, value, expiresAt: now + ttlMs });
        inFlight.delete(key);
        return value;
      },
      (error: unknown) => {
        // Definitive absences are cached as absences, so a forged crawler claim does
        // not cost a lookup on every request it sends. The code is kept so the replay
        // is still an absence rather than a shrug.
        const definitive = isDefinitiveAbsence(error);
        store(key, { ok: false, code: errorCode(error), expiresAt: now + (definitive ? ttlMs : errorTtlMs) });
        inFlight.delete(key);
        throw error;
      },
    );
    inFlight.set(key, query);
    return query;
  };

  const store = (key: string, entry: CacheEntry): void => {
    cache.set(key, entry);
    if (cache.size <= max) return;
    // Map iterates in insertion order, so the first key is the oldest.
    const oldest = cache.keys().next();
    if (oldest.done !== true) cache.delete(oldest.value);
  };

  return {
    reverse: (ip) => lookup(`r:${ip}`, () => inner.reverse(ip)),
    resolveAddresses: (hostname) => lookup(`f:${hostname}`, () => inner.resolveAddresses(hostname)),
  };
}
