import { TtlLru } from "../internal/lru.js";
import type { Clock } from "../internal/clock.js";

/**
 * What this site normally looks like.
 *
 * Everything else in this library judges a client against a fixed idea of what clients
 * do. This judges one against *the rest of the traffic*, which answers questions the
 * fixed rules cannot. A path nobody else has ever asked for is a wordlist entry without
 * needing to be in anybody's wordlist. A client whose requests are almost all misses
 * matters only relative to a site's own miss rate, which on a site mid-migration is
 * enormous and innocent. And an enumeration split across five hundred addresses is
 * invisible to every per-actor threshold by construction, but perfectly visible in the
 * union of what those addresses asked for.
 *
 * **It is off by default and it stays quiet for a long time after being switched on.**
 * Both of those are load-bearing. A baseline is a claim about normal, and a claim about
 * normal drawn from four hundred requests is not one — a quiet site at three in the
 * morning would otherwise produce "this path is unique to this client" for every path,
 * because every path is. So nothing is reported until `warmupRequests` have been seen,
 * and the failure mode of the whole module is silence.
 *
 * **It is kept in process, like the rest of the behavioural state.** Across replicas
 * each one therefore sees its own share of the traffic. That understates every count
 * here, and understating is the direction that costs a missed detection rather than an
 * accusation — which is the correct way round for a module whose mistakes would
 * otherwise land on everybody at once.
 */
export interface SiteProfileOptions {
  /**
   * Requests to observe before anything may be reported. Default 5000.
   *
   * The single most important number here. Below it every question this module answers
   * has the same wrong answer — everything looks rare, because everything is.
   */
  warmupRequests?: number;
  /** Distinct paths remembered. Default 50000. */
  maxPaths?: number;
  /** Numeric path shapes tracked for distributed walks. Default 256. */
  maxTemplates?: number;
  /** Actors remembered per template before the count saturates. Default 64. */
  maxActorsPerTemplate?: number;

  /** How long an observation counts for. Default one hour. */
  windowMs?: number;
  /** Newly-appeared paths watched for a surge. Default 2048; 0 turns it off. */
  maxWatchedPaths?: number;
  /** Clients remembered per watched path before the count saturates. Default 64. */
  maxActorsPerPath?: number;
}

/**
 * What the site has seen of one numeric path shape, across every actor.
 *
 * The ids are held as a **bitmap over the range rather than as a set of numbers**, and
 * that is the difference between this module being usable and not. A client chooses its
 * own paths, so it chooses how many shapes exist — `/anything/1` creates the shape
 * `/anything/#` — and holding four thousand ids per shape as a `Set` measured at 45 MB
 * for a table an attacker can fill on purpose. A fixed 1024-bit map is 128 bytes however
 * wide the range grows, because the map coarsens instead of growing: when the range
 * outgrows it, adjacent buckets are merged and the scale doubles.
 *
 * The cost of coarsening is that a "covered" bucket means *some* id in that slice was
 * requested rather than every one. It makes coverage optimistic on very wide ranges,
 * which is why coverage alone never reports anything — see `distributedWalkDetector`,
 * where it has to agree with the revisit ratio.
 */
interface WalkRecord {
  /** Distinct actors that have walked this shape. Saturates. */
  actors: Set<string>;
  /** 1024 buckets. Bucket of an id is `id / scale`, so bucket 0 always starts at 0. */
  bits: Uint32Array;
  /** Ids per bucket. A power of two, doubling whenever the range outgrows the map. */
  scale: number;
  min: number;
  max: number;
  /** Requests under this shape, so revisiting can be told from enumerating. */
  visits: number;
}

/** Buckets in a walk bitmap. 1024 bits is 128 bytes, whatever the range. */
const WALK_BUCKETS = 1024;

function bucketSet(record: WalkRecord, bucket: number): void {
  record.bits[bucket >>> 5] = (record.bits[bucket >>> 5] as number) | (1 << (bucket & 31));
}

function bucketGet(record: WalkRecord, bucket: number): boolean {
  return ((record.bits[bucket >>> 5] as number) & (1 << (bucket & 31))) !== 0;
}

/** Halves the resolution, merging each pair of buckets. Loses detail, never coverage. */
function coarsen(record: WalkRecord): void {
  const merged = new Uint32Array(WALK_BUCKETS / 32);
  for (let bucket = 0; bucket < WALK_BUCKETS / 2; bucket++) {
    const low = bucket * 2;
    if (bucketGet(record, low) || bucketGet(record, low + 1)) {
      merged[bucket >>> 5] = (merged[bucket >>> 5] as number) | (1 << (bucket & 31));
    }
  }
  record.bits = merged;
  record.scale *= 2;
}

/**
 * A path that did not exist in this site's traffic until recently.
 *
 * Watched only from the moment it first appears, which is what keeps the table small and
 * also what makes it mean anything: a path the site has always served is not news however
 * busy it gets.
 */
interface Surge {
  actors: Set<string>;
  firstSeen: number;
  answered: number;
  misses: number;
}

/** What has happened to a newly-appeared path since it appeared. */
export interface PathSurge {
  clients: number;
  ageMs: number;
  answered: number;
  misses: number;
}

/** What the site knows about one numeric path shape right now. */
export interface WalkSpread {
  actors: number;
  /**
   * Distinct ids requested, estimated.
   *
   * Exact while the bitmap is at full resolution, and `buckets * scale` once it has
   * coarsened — which is the right estimate for the thing this exists to find, because a
   * walk that covers its range touches every id in every bucket it touches. It
   * *overestimates* for sparse traffic at a coarse scale, so it is never used alone: the
   * detector requires coverage and the revisit ratio to agree.
   */
  ids: number;
  /** Buckets of the range that were touched. Exact distinct count while `scale` is 1. */
  buckets: number;
  /** Ids per bucket. 1 until the range outgrows the bitmap. */
  scale: number;
  visits: number;
  /**
   * Fraction of the range between the lowest and highest id that was touched.
   *
   * Always a number, and never zero: the range is measured from the lowest id seen to the
   * highest, so it is at least one bucket wide and that bucket was touched by definition.
   * A single id is a range of one, fully covered.
   */
  coverage: number;
}

const DEFAULTS = {
  warmupRequests: 5000,
  maxPaths: 50_000,
  maxTemplates: 256,
  maxActorsPerTemplate: 64,
  windowMs: 60 * 60_000,
  maxWatchedPaths: 2048,
  maxActorsPerPath: 64,
};

export class SiteProfile {
  private readonly options: Required<SiteProfileOptions>;
  private readonly paths: TtlLru<number>;
  private readonly walks: TtlLru<WalkRecord>;
  private readonly watched: TtlLru<Surge> | undefined;
  private readonly clock: Clock;
  private observed = 0;
  private misses = 0;
  private answered = 0;

  constructor(options: SiteProfileOptions & { clock: Clock }) {
    this.options = { ...DEFAULTS, ...stripUndefined(options) };
    this.paths = new TtlLru<number>(this.options.maxPaths, this.options.windowMs, options.clock);
    this.walks = new TtlLru<WalkRecord>(this.options.maxTemplates, this.options.windowMs, options.clock);
    this.clock = options.clock;
    this.watched =
      this.options.maxWatchedPaths > 0 ? new TtlLru<Surge>(this.options.maxWatchedPaths, this.options.windowMs, options.clock) : undefined;
  }

  /**
   * Whether enough traffic has been seen for any of this to mean anything.
   *
   * Every reader checks this. A profile that answers during warmup is worse than one
   * that does not exist, because it answers confidently and wrongly.
   */
  get warm(): boolean {
    return this.observed >= this.options.warmupRequests;
  }

  get requestsObserved(): number {
    return this.observed;
  }

  /** The share of answered requests that were misses, or `undefined` before warmup. */
  get missRate(): number | undefined {
    return this.warm && this.answered > 0 ? this.misses / this.answered : undefined;
  }

  /** Files a request. Called once per assessed request, before the detectors run. */
  record(path: string, actorKey: string): void {
    if (this.observed < Number.MAX_SAFE_INTEGER) this.observed++;
    const seen = this.paths.get(path);
    this.paths.set(path, (seen ?? 0) + 1);

    if (this.watched === undefined || !this.warm) return;
    // Watched from the moment it first appears and not before: a path the site has
    // always served is not news however busy it gets, and starting the clock later
    // would make an old path look new.
    let surge = this.watched.get(path);
    if (surge === undefined) {
      if (seen !== undefined) return;
      surge = { actors: new Set(), firstSeen: this.clock.now(), answered: 0, misses: 0 };
      this.watched.set(path, surge);
    }
    if (surge.actors.size < this.options.maxActorsPerPath) surge.actors.add(actorKey);
  }

  /** Files what the application answered, for the site's miss rate and each watched path. */
  recordOutcome(path: string, status: number): void {
    if (this.answered < Number.MAX_SAFE_INTEGER) this.answered++;
    const missed = status === 404 || status === 410;
    if (missed) this.misses++;

    const surge = this.watched?.get(path);
    if (surge === undefined) return;
    surge.answered++;
    if (missed) surge.misses++;
  }

  /** What has happened to a path since it first appeared. `undefined` if not watched. */
  surgeOf(path: string): PathSurge | undefined {
    if (!this.warm) return undefined;
    const surge = this.watched?.get(path);
    if (surge === undefined) return undefined;
    return { clients: surge.actors.size, ageMs: this.clock.now() - surge.firstSeen, answered: surge.answered, misses: surge.misses };
  }

  /**
   * How many times the site has served this path, to anybody.
   *
   * `undefined` before warmup, and `0` for a path this process has not seen — which is
   * not the same as one the site does not have, and is why the detector reading this
   * needs a great many of them before it says anything.
   */
  timesSeen(path: string): number | undefined {
    return this.warm ? (this.paths.get(path) ?? 0) : undefined;
  }

  /** Files one step of a numeric walk against the shape it belongs to. */
  recordWalk(template: string, id: number, actorKey: string): void {
    let record = this.walks.get(template);
    if (record === undefined) {
      record = { actors: new Set(), bits: new Uint32Array(WALK_BUCKETS / 32), scale: 1, min: id, max: id, visits: 0 };
      this.walks.set(template, record);
    }
    record.visits++;
    if (record.actors.size < this.options.maxActorsPerTemplate) record.actors.add(actorKey);
    if (id < record.min) record.min = id;
    if (id > record.max) record.max = id;
    // Coarsen until the highest id seen still fits. Bucket 0 starts at 0, so only the
    // top of the range decides the scale and no rebasing is ever needed.
    while (Math.floor(record.max / record.scale) >= WALK_BUCKETS) coarsen(record);
    bucketSet(record, Math.floor(id / record.scale));
  }

  /** What the whole site has done with one numeric shape. `undefined` before warmup. */
  spreadOf(template: string): WalkSpread | undefined {
    if (!this.warm) return undefined;
    const record = this.walks.get(template);
    if (record === undefined) return undefined;

    // Only the window between the lowest and highest id seen is asked about: buckets
    // below the first request are not "uncovered", they were never in question.
    const lowest = Math.floor(record.min / record.scale);
    const highest = Math.floor(record.max / record.scale);
    let touched = 0;
    for (let bucket = lowest; bucket <= highest; bucket++) if (bucketGet(record, bucket)) touched++;
    const window = highest - lowest + 1;

    return {
      actors: record.actors.size,
      ids: touched * record.scale,
      buckets: touched,
      scale: record.scale,
      visits: record.visits,
      coverage: touched / window,
    };
  }
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) if (entry !== undefined) out[key] = entry;
  return out as Partial<T>;
}
