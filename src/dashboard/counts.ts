/**
 * How many requests happened in a stretch of time, kept apart from the requests themselves.
 *
 * The feed's ring is bounded twice over — by a count and by an age — because every entry
 * in it holds an address, a User-Agent, a header set and an evidence list belonging to
 * somebody. That is the right bound for *entries*. It is the wrong bound for *counting*,
 * and the two were the same thing until now: the page said "last 693 requests · 141h",
 * which read as a statement about the last 141 hours and was in fact a statement about the
 * 693 entries that had survived eviction. On a busy origin those are wildly different
 * numbers, and the one on screen was the smaller and less interesting of the two.
 *
 * So the count is kept separately, in minute buckets. A bucket is an integer and a
 * timestamp — no addresses, no headers, nothing anybody could object to being retained —
 * which is what lets it cover a window far longer than the entries do at a cost that does
 * not depend on traffic. A day of history is 1,440 numbers.
 *
 * What this buys the page: the total for any window is exact, always, whether or not the
 * entries behind it are still held or have yet to be fetched. The pager can then say how
 * many pages there are before it has loaded any of them, and "1,284 requests" stops
 * meaning "1,284 requests that happen to still be in memory".
 */

const MINUTE = 60_000;

/** A minute that saw traffic. Absent minutes are zero and cost nothing. */
interface Bucket {
  /** Start of the minute, as epoch milliseconds. */
  at: number;
  total: number;
}

export class FeedCounts {
  /** Oldest first, one per minute that saw at least one request. */
  private buckets: Bucket[] = [];
  private retainMs: number;

  constructor(retainMs: number) {
    this.retainMs = Math.max(0, Math.floor(retainMs));
  }

  /**
   * How long counts are kept.
   *
   * Follows the feed's retention, so "we keep nothing older than an hour" stays one
   * promise rather than becoming two with different answers.
   */
  get retention(): number {
    return this.retainMs;
  }

  setRetention(ms: number, now: number): void {
    this.retainMs = Math.max(0, Math.floor(ms));
    this.prune(now);
  }

  /** Counts one request, at the time it happened. */
  record(at: number): void {
    const minute = Math.floor(at / MINUTE) * MINUTE;
    const last = this.buckets[this.buckets.length - 1];
    // Almost always the newest minute, because requests arrive in time order. The scan
    // below is for the exception — a replayed or back-dated timestamp — rather than the
    // rule, so this stays O(1) on the path it is actually on.
    if (last !== undefined && last.at === minute) {
      last.total++;
      return;
    }
    if (last === undefined || minute > last.at) {
      this.buckets.push({ at: minute, total: 1 });
      return;
    }
    for (let i = this.buckets.length - 1; i >= 0; i--) {
      const bucket = this.buckets[i] as Bucket;
      if (bucket.at === minute) {
        bucket.total++;
        return;
      }
      if (bucket.at < minute) {
        this.buckets.splice(i + 1, 0, { at: minute, total: 1 });
        return;
      }
    }
    this.buckets.unshift({ at: minute, total: 1 });
  }

  /** Drops buckets older than the retention. Returns how many went. */
  prune(now: number): number {
    if (this.retainMs === 0) return 0;
    const cutoff = now - this.retainMs;
    let expired = 0;
    while (expired < this.buckets.length && (this.buckets[expired] as Bucket).at + MINUTE <= cutoff) expired++;
    if (expired > 0) this.buckets.splice(0, expired);
    return expired;
  }

  /**
   * How many requests fell in a window, either end open.
   *
   * Counted at minute resolution, which is the honest precision: a bucket is included
   * when any part of it overlaps the window. For the windows this answers — an incident,
   * an afternoon, "everything so far" — a minute is far finer than the question.
   */
  count(from: number | undefined, to: number | undefined): number {
    let total = 0;
    for (const bucket of this.buckets) {
      if (from !== undefined && bucket.at + MINUTE <= from) continue;
      if (to !== undefined && bucket.at > to) continue;
      total += bucket.total;
    }
    return total;
  }

  /** The earliest instant these counts can speak for, or `undefined` when empty. */
  get oldest(): number | undefined {
    return this.buckets[0]?.at;
  }

  get total(): number {
    let sum = 0;
    for (const bucket of this.buckets) sum += bucket.total;
    return sum;
  }

  /** For the traffic chart and anything else that wants the shape rather than the sum. */
  series(): ReadonlyArray<{ at: number; total: number }> {
    return this.buckets.map((bucket) => ({ at: bucket.at, total: bucket.total }));
  }

  clear(): void {
    this.buckets = [];
  }
}
