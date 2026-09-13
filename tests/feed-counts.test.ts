import { describe, expect, it } from "vitest";
import { FeedCounts } from "../src/dashboard/counts.js";

/**
 * Counting requests apart from keeping them.
 *
 * The feed's ring is bounded by a count *and* an age, because every entry in it holds an
 * address, a User-Agent and a header set. That is right for entries and wrong for
 * counting, and until now they were the same thing: "last 693 requests · 141h" read as a
 * statement about 141 hours and was a statement about the 693 entries that had survived
 * eviction. These buckets hold an integer and a timestamp, so they can speak for a window
 * far longer than the entries do.
 */

const MINUTE = 60_000;
const T0 = 1_700_000_000_000 - (1_700_000_000_000 % MINUTE);

describe("counting a window", () => {
  it("totals the minutes a window covers", () => {
    const counts = new FeedCounts(0);
    for (let i = 0; i < 3; i++) counts.record(T0 + i * MINUTE);
    counts.record(T0 + 2 * MINUTE);
    expect(counts.total).toBe(4);
    expect(counts.count(undefined, undefined)).toBe(4);
    expect(counts.count(T0 + 2 * MINUTE, undefined)).toBe(2);
    expect(counts.count(undefined, T0)).toBe(1);
  });

  it("reads an open end as open rather than as now", () => {
    const counts = new FeedCounts(0);
    counts.record(T0);
    counts.record(T0 + 10 * MINUTE);
    expect(counts.count(undefined, undefined), "both ends open is everything").toBe(2);
    expect(counts.count(T0 + MINUTE, undefined)).toBe(1);
  });

  it("keeps one bucket per minute rather than one per request", () => {
    const counts = new FeedCounts(0);
    for (let i = 0; i < 5000; i++) counts.record(T0 + 30_000);
    expect(counts.total).toBe(5000);
    expect(counts.series()).toHaveLength(1);
  });

  it("files a back-dated request in the minute it happened", () => {
    // A replay, or a clock that stepped. The common path is append-to-newest; this is
    // the exception, and putting it in the wrong bucket would make a window wrong.
    const counts = new FeedCounts(0);
    counts.record(T0 + 5 * MINUTE);
    counts.record(T0);
    counts.record(T0 + 2 * MINUTE);
    counts.record(T0 + 2 * MINUTE);
    expect(counts.count(T0, T0)).toBe(1);
    expect(counts.count(T0 + 2 * MINUTE, T0 + 2 * MINUTE)).toBe(2);
    expect(counts.series().map((b) => b.at)).toEqual([T0, T0 + 2 * MINUTE, T0 + 5 * MINUTE]);
  });

  it("drops what it is no longer allowed to remember", () => {
    const counts = new FeedCounts(10 * MINUTE);
    counts.record(T0);
    counts.record(T0 + 20 * MINUTE);
    counts.prune(T0 + 20 * MINUTE);
    expect(counts.total, "the old minute is past the retention").toBe(1);
    expect(counts.oldest).toBe(T0 + 20 * MINUTE);
  });

  it("keeps a minute that is only partly past the retention", () => {
    // A bucket covers a whole minute, so it stops being allowed only once its *end* is
    // past the cutoff. Dropping it as soon as its start is past would lose up to a
    // minute of counts at the boundary on every prune — a small error that repeats,
    // which is the kind that is never noticed and never right.
    const counts = new FeedCounts(10 * MINUTE);
    counts.record(T0);
    // Now is ten minutes and thirty seconds after the bucket began, so the cutoff falls
    // *inside* it: thirty seconds of that minute are still within the retention.
    counts.prune(T0 + 10 * MINUTE + 30_000);
    expect(counts.total, "the minute is not wholly past the retention yet").toBe(1);

    // A little later the whole minute is behind the cutoff, and then it goes.
    counts.prune(T0 + 11 * MINUTE + 1);
    expect(counts.total).toBe(0);
  });

  it("keeps everything when retention is off", () => {
    const counts = new FeedCounts(0);
    counts.record(T0);
    counts.prune(T0 + 1000 * MINUTE);
    expect(counts.total).toBe(1);
  });

  /**
   * Bounded even when nothing is expiring them.
   *
   * Retention may be switched off — in the handler's configuration and from the dashboard,
   * where zero is documented as "keep them until the capacity bound evicts them". That
   * bound counts *entries* and says nothing about these, so with retention off the only
   * thing stopping the counts growing by one object per minute, for the life of the
   * process, is this ceiling.
   */
  it("stops growing even with retention switched off", () => {
    const counts = new FeedCounts(0);
    const minutes = 7 * 24 * 60;
    // A fortnight of traffic, a minute at a time, against a seven-day ceiling.
    for (let i = 0; i < minutes * 2; i++) counts.record(T0 + i * MINUTE);

    expect(counts.series().length, "one week of minutes, not two").toBe(minutes);
    // And it drops the *oldest*, so what it still holds is the recent end.
    expect(counts.oldest).toBe(T0 + minutes * MINUTE);
    expect(counts.count(undefined, undefined), "every minute it still has").toBe(minutes);
    // The forgotten stretch answers zero rather than a stale number, and `oldest` is how
    // a reader can tell those apart.
    expect(counts.count(T0, T0)).toBe(0);
  });

  it("prunes to a retention it is given later", () => {
    const counts = new FeedCounts(0);
    counts.record(T0);
    counts.record(T0 + 20 * MINUTE);
    counts.setRetention(10 * MINUTE, T0 + 20 * MINUTE);
    expect(counts.total).toBe(1);
    expect(counts.retention).toBe(10 * MINUTE);
  });
});
