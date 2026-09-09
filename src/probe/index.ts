import { identityShape, driftBetween, markerCookie, newMarker, readMarker } from "./marker.js";
import type { IdentityShape, MarkerClaims, MarkerCookieOptions, MarkerReading, ShapeDrift } from "./marker.js";
import type { RequestFacts } from "../types.js";
import type { ParsedUserAgent } from "../internal/ua.js";
import type { Clock } from "../internal/clock.js";
import { TtlLru } from "../internal/lru.js";
import { networkKey } from "../internal/ip.js";

export type { IdentityShape, MarkerClaims, MarkerReading, ShapeDrift } from "./marker.js";
export { identityShape, driftBetween, readMarker } from "./marker.js";

/**
 * Asking the client to hold something, and reading what comes back.
 *
 * This is the one part of the library that *acts* in order to detect, rather than
 * reading what a request happened to carry. That difference is worth being explicit
 * about, because it changes what the evidence is worth: everything else here is an
 * inference about a client, while a marker is a controlled experiment on one. We choose
 * the stimulus, we sign it, and the response is either the cookie we issued or it is
 * not. There is very little room left for a coincidence to explain.
 *
 * It is **off by default**, for two reasons that have nothing to do with detection.
 * A `Set-Cookie` on a response makes it uncacheable by most shared caches and CDNs, so
 * switching this on without knowing that can quietly move a site's cache-hit ratio; the
 * probe therefore issues a marker only when the client does not already hold a valid
 * one, which for an ordinary visitor is the first request of a session and no other.
 * And a cookie is a cookie: it is first-party, carries no identifier of a person and
 * expires on its own, but the decision to set one belongs to the operator rather than
 * to a library they installed to read headers.
 */
export interface MarkerProbeOptions {
  /**
   * HMAC secrets. The first signs; all of them verify.
   *
   * Required, and deliberately not defaulted to something generated at startup. A
   * per-process secret would mean every marker minted by one replica reads as *forged*
   * on every other one, and as forged again after a restart — turning the strongest
   * signal here into a machine for accusing ordinary visitors.
   */
  secrets: readonly string[];
  /** Cookie name. Default `__bh_m`. */
  cookieName?: string;
  /** How long a marker stands. Default 12 hours. */
  ttlMs?: number;
  sameSite?: "Strict" | "Lax" | "None";
  /** Set the `Secure` attribute. Default true; turn it off only for local HTTP. */
  secure?: boolean;
  domain?: string;
  /**
   * How many markers to track network fan-out for. Default 20000; 0 turns it off.
   *
   * Bounded rather than shared, on purpose. The rest of this library keeps its
   * behavioural series in process — see `state.ts` — because a store round trip on the
   * request path buys precision nobody asked for at a cost everybody pays. Across
   * replicas each one therefore sees its own share of a client's addresses, which
   * *understates* fan-out and so errs towards saying nothing.
   */
  maxTrackedMarkers?: number;
  /**
   * Estimated networks at which the count saturates. Default 96.
   *
   * The networks are not remembered individually — see `noteNetwork`. Raising this does
   * not cost memory; it only extends the range over which the estimate stays useful.
   */
  maxNetworksPerMarker?: number;
  /**
   * How many verified markers to remember, so a session is not re-verified per request.
   * Default 5000; 0 turns the cache off.
   */
  maxVerifiedMarkers?: number;
}

/** What this request's marker turned out to be. */
export interface MarkerObservation {
  reading: MarkerReading;
  /**
   * How the identity claimed now differs from the identity claimed when the marker was
   * issued. Present only for a marker that verified, because a drift measured against
   * an unsigned claim measures nothing.
   */
  drift: ShapeDrift | undefined;
  /** This request's shape, so the issuing path does not compute it twice. */
  shape: IdentityShape;
  /**
   * Distinct networks this marker has now been presented from, counted in this process.
   *
   * `0` when the marker did not verify or tracking is off. Saturates at
   * `maxNetworksPerMarker`, because the question it answers — "is one client moving
   * across a pool of addresses" — is already answered long before the number is large.
   */
  networks: number;
}

const DEFAULT_TTL_MS = 12 * 60 * 60_000;

/** 128 bits, as four 32-bit words. Sixteen bytes per tracked marker. */
const FANOUT_WORDS = 4;
const FANOUT_BITS = FANOUT_WORDS * 32;

/** FNV-1a, folded to a bit index. Not a secret: it only has to spread evenly. */
function hashToBit(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % FANOUT_BITS;
}

/**
 * How many distinct networks a sketch implies, by linear counting.
 *
 * With `k` of `b` bits set, the expected number of distinct values is `-b·ln(1 - k/b)`.
 * Exact while nothing has collided — measured exact to 8 networks, within one to 32, and
 * reading low by the time it reaches 64, where the sketch is running out of room. A full
 * sketch cannot be read at all, so it reports the cap.
 */
function estimateDistinct(sketch: Uint32Array, cap: number): number {
  let set = 0;
  for (let word = 0; word < FANOUT_WORDS; word++) {
    let bits = sketch[word] as number;
    while (bits !== 0) {
      bits &= bits - 1;
      set++;
    }
  }
  if (set >= FANOUT_BITS) return cap;
  const estimate = Math.round(-FANOUT_BITS * Math.log(1 - set / FANOUT_BITS));
  return Math.min(estimate, cap);
}

export class MarkerProbe {
  readonly cookieName: string;
  private readonly secrets: readonly string[];
  private readonly ttlMs: number;
  private readonly cookieOptions: MarkerCookieOptions;
  private readonly clock: Clock;
  /**
   * Marker id to a 128-bit sketch of the networks it has been presented from.
   *
   * A `Set` of network strings is the obvious structure and measured at **55.6 MB** with
   * both caps full — twenty thousand markers each seen from a few dozen networks — which
   * is far too much to hand somebody for switching on a detector. The question being
   * asked is only ever "has this marker come from more than about sixteen networks", and
   * a bitmap answers that in sixteen bytes by linear counting: hash each network to a
   * bit, then estimate the distinct count from how many bits are set.
   *
   * The estimate carries a few percent of error in **either** direction — measured, 16
   * real networks read as 17 and 32 read as 33 — so the threshold it feeds is a soft
   * boundary rather than a hard one. That is honest for this signal in particular, which
   * cannot separate a proxy pool from a heavily mobile person at any resolution, and is
   * why it is capped at `moderate` and never denies anybody by itself.
   */
  private readonly fanout: TtlLru<Uint32Array> | undefined;
  private readonly maxNetworks: number;
  /**
   * Markers already verified, by the exact cookie value that verified.
   *
   * A browsing session sends one identical cookie on every request, and verifying it is
   * an HMAC — which measured at roughly twenty microseconds, nearly doubling the cost of
   * an assessment to re-establish a fact that had not changed. The cache is only ever
   * populated with *successes*: caching failures would let anyone flood it with unique
   * junk, and a failure is cheap to reach anyway.
   *
   * Expiry is still checked on every hit, so a cached marker stops being accepted at the
   * moment it should. The key is the whole signed value, so a cache hit is only possible
   * for a string that already carried a valid signature.
   */
  private readonly verified: TtlLru<MarkerClaims> | undefined;

  constructor(options: MarkerProbeOptions & { clock: Clock }) {
    if (options.secrets.length === 0) throw new Error("A marker probe requires at least one secret");
    for (const secret of options.secrets) {
      if (secret.length < 32) {
        throw new Error("Each marker secret must be at least 32 characters; generate one with `crypto.randomBytes(32).toString('base64url')`");
      }
    }
    this.secrets = options.secrets;
    this.cookieName = options.cookieName ?? "__bh_m";
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.clock = options.clock;
    const tracked = options.maxTrackedMarkers ?? 20_000;
    this.maxNetworks = options.maxNetworksPerMarker ?? 96;
    this.fanout = tracked > 0 ? new TtlLru<Uint32Array>(tracked, this.ttlMs, options.clock) : undefined;
    const cached = options.maxVerifiedMarkers ?? 5000;
    this.verified = cached > 0 ? new TtlLru<MarkerClaims>(cached, this.ttlMs, options.clock) : undefined;
    this.cookieOptions = {
      ...(options.sameSite === undefined ? {} : { sameSite: options.sameSite }),
      ...(options.secure === undefined ? {} : { secure: options.secure }),
      ...(options.domain === undefined ? {} : { domain: options.domain }),
    };

    // Minting one now, and throwing it away.
    //
    // `serializeCookie` rejects an invalid name, an invalid domain and `SameSite=None`
    // without `Secure` — correctly, but it does so at the moment a cookie is *issued*,
    // which is once per request forever. Every one of those throws lands in the adapter's
    // fail-open path, so the site keeps serving while detection is entirely off and the
    // operator collects one reported error per request. A misconfiguration this total
    // should stop the process starting, which is what every other bad setting here does.
    try {
      markerCookie(this.cookieName, newMarker({ b: "x", o: "x", l: "x" }, this.ttlMs, 0), this.secrets, this.cookieOptions);
    } catch (error) {
      throw new Error(`The marker probe cannot issue a cookie with this configuration: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Reads the marker this request carried, and measures it against the request. */
  observe(facts: RequestFacts, ua: ParsedUserAgent): MarkerObservation {
    const shape = identityShape(facts, ua);
    const reading = this.read(facts.cookies?.[this.cookieName]);
    const drift = reading.kind === "valid" ? driftBetween({ b: reading.claims.b, o: reading.claims.o, l: reading.claims.l }, shape) : undefined;
    const networks = reading.kind === "valid" ? this.noteNetwork(reading.claims.sub, facts.ip) : 0;
    return { reading, drift, shape, networks };
  }

  /**
   * Whether this response should carry a marker.
   *
   * Only when the client is not already holding a good one. An ordinary visitor is
   * therefore issued a cookie once and then browses with uncached-by-`Set-Cookie`
   * responses never again; a client that discards cookies is issued one every time,
   * which is itself the observation `marker-persistence` is built on.
   */
  shouldIssue(observation: MarkerObservation): boolean {
    return observation.reading.kind !== "valid";
  }

  /** Verifies a presented marker, reusing an earlier verification of the same value. */
  private read(value: string | undefined): MarkerReading {
    if (value === undefined || value.length === 0) return { kind: "absent" };
    const now = this.clock.now();
    const remembered = this.verified?.get(value);
    // Re-checked rather than trusted: a cached marker must stop being valid on time.
    if (remembered !== undefined) return remembered.exp > now ? { kind: "valid", claims: remembered } : { kind: "expired" };
    const reading = readMarker(value, this.secrets, now);
    if (reading.kind === "valid") this.verified?.set(value, reading.claims);
    return reading;
  }

  /**
   * Files this presentation under the marker's own id and returns how many distinct
   * networks it has now come from.
   *
   * A `/24` rather than an address, because a single visitor's address changes for
   * ordinary reasons all day — a phone moving between cells, a router relearning a
   * lease — while the network it sits behind usually does not. Counting addresses would
   * report every commuter.
   */
  private noteNetwork(markerId: string, ip: string): number {
    if (this.fanout === undefined) return 0;
    let sketch = this.fanout.get(markerId);
    if (sketch === undefined) {
      sketch = new Uint32Array(FANOUT_WORDS);
      this.fanout.set(markerId, sketch);
    }
    const bit = hashToBit(networkKey(ip));
    sketch[bit >>> 5] = (sketch[bit >>> 5] as number) | (1 << (bit & 31));
    return estimateDistinct(sketch, this.maxNetworks);
  }

  /** The `Set-Cookie` handing this client a marker bound to the identity it just claimed. */
  issue(observation: MarkerObservation): string {
    return markerCookie(this.cookieName, newMarker(observation.shape, this.ttlMs, this.clock.now()), this.secrets, this.cookieOptions);
  }
}
