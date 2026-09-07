import { matchesFilter, matchesQuery, parseQuery, searchableText } from "./query.js";
import { outcome } from "./outcome.js";
import type { EditorRule } from "./draft.js";
import type { FilterName, Term } from "./query.js";
import type { ActorRow, DashboardEntry, Policy, Row, Snapshot, TabName } from "./types.js";

/** Requests the page keeps. The server's ring is smaller; this is the ceiling, not the target. */
const MAX_ROWS = 1000;

/** Rows built into the table at once. Beyond this a feed is scrolled past, not read. */
export const FEED_LIMIT = 300;

export interface State {
  rows: Row[];
  byId: Map<string, Row>;
  snapshot: Snapshot | undefined;
  policy: Policy | undefined;
  /** The Actors screen's list, fetched rather than streamed. See `registry.ts`. */
  actors: ActorRow[];
  actorsTracked: number;
  paused: boolean;
  filter: FilterName;
  search: string;
  terms: Term[];
  tab: TabName;
  open: Set<string>;
  actor: string | undefined;
  rangeMs: number;
  /** Which population the score distribution is drawn from. See `charts.drawScores`. */
  scoreScope: "run" | "window";
  editorRules: EditorRule[];
  editorDirty: boolean;
  editorMode: "gui" | "json";
  guardDirty: boolean;
  /** Rows that arrived while paused, so the button can say what resuming will show. */
  bufferedWhilePaused: number;
  /** Frames the server dropped because *this* connection was too slow to take them. */
  laggedDrops: number;
  /**
   * Which page of the feed is showing, newest first, zero-based.
   *
   * Zero follows the live feed. Any other page is a position in history, so arriving
   * requests must not shuffle it under the reader — see `feedFrozen`.
   */
  feedPage: number;
  /**
   * The matching rows as they stood when the reader left page zero.
   *
   * Without this, one request arriving while somebody reads page three moves every row
   * down by one and they are silently reading different rows than the ones they were
   * looking at. Frozen on leaving page zero, dropped on returning to it.
   */
  feedFrozen: Row[] | undefined;
  /** Which page of the Actors table is showing. Paged on the server, by offset. */
  actorsPage: number;
  /** How many rows a page of each table holds. Chosen in the page, not configured. */
  feedPageSize: number;
  actorsPageSize: number;
  /**
   * How many skipped entries have already been fetched back and merged.
   *
   * The server's `skipped` only ever grows, so the badge subtracts this to say how many
   * are *still* missing rather than how many ever were.
   */
  caughtUp: number;
}

export const state: State = {
  rows: [],
  byId: new Map(),
  snapshot: undefined,
  policy: undefined,
  actors: [],
  actorsTracked: 0,
  paused: false,
  filter: "all",
  search: "",
  terms: [],
  tab: "live",
  open: new Set(),
  actor: undefined,
  rangeMs: 300_000,
  scoreScope: "run",
  editorRules: [],
  editorDirty: false,
  editorMode: "gui",
  guardDirty: false,
  bufferedWhilePaused: 0,
  laggedDrops: 0,
  feedPage: 0,
  feedFrozen: undefined,
  actorsPage: 0,
  feedPageSize: 50,
  actorsPageSize: 25,
  caughtUp: 0,
};

/**
 * Files one entry into the ring.
 *
 * The same request arrives twice — once when it is assessed and again when the
 * decision lands, and again after a reconnect that replays what was missed — so this
 * is an upsert keyed by request id, and `rev` is what tells the renderer that a row on
 * screen is now stale. Rebuilding a row nothing changed about is what used to wipe a
 * text selection every time a request came in.
 */
export function ingest(entry: DashboardEntry): void {
  const existing = state.byId.get(entry.requestId);
  if (existing !== undefined) {
    existing.entry = entry;
    existing.rev++;
    existing.text = undefined;
    return;
  }
  const row: Row = { entry, rev: 0 };
  state.byId.set(entry.requestId, row);
  state.rows.push(row);
  if (state.rows.length > MAX_ROWS) {
    for (const dropped of state.rows.splice(0, state.rows.length - MAX_ROWS)) {
      state.byId.delete(dropped.entry.requestId);
      state.open.delete(dropped.entry.requestId);
    }
  }
}

export function clearFeed(): void {
  state.rows = [];
  state.byId = new Map();
  state.open.clear();
  state.actor = undefined;
  state.bufferedWhilePaused = 0;
  // The lag count goes with them. It is half of the "N not streamed" badge — the server's
  // own `skipped` is the other half, and `FeedRing.clear()` resets that — so leaving this
  // one behind made the badge disagree with itself: a number that survived the feed it
  // described, under a tooltip promising the entries were "still in the window, the
  // preview and the export" when the window had just been replaced. Both ways a feed is
  // cleared lead here, and the second is the one that matters: a viewer whose stream was
  // dropped for lagging reconnects with a stale cursor and is sent a fresh backlog, so the
  // gap this counted is exactly what has just been filled in.
  state.laggedDrops = 0;
  // And the frozen page goes with them, for the same reason: it holds rows this store no
  // longer has, so a reader left on page three would be paging through a list of things
  // that are gone.
  resetPaging();
}

export function setSearch(value: string): void {
  state.search = value;
  state.terms = parseQuery(value);
  // A narrower search over a frozen page-three is somebody reading rows their filter no
  // longer selects. Any change to what matches goes back to the live first page.
  resetPaging();
}

/** Back to the live first page, thawed. Called whenever what matches changes. */
export function resetPaging(): void {
  state.feedPage = 0;
  state.feedFrozen = undefined;
}

function textOf(row: Row): string {
  if (row.text === undefined) row.text = searchableText(row.entry);
  return row.text;
}

/**
 * Puts the ring back in time order after a bulk merge.
 *
 * `ingest` appends, because the stream delivers in order and appending is what that
 * costs. A backlog fetched over HTTP is not in order relative to what is already held —
 * it is *older* — so merging without this leaves yesterday's requests sitting at the
 * newest end, which is where the feed reads from.
 */
export function sortRows(): void {
  state.rows.sort((a, b) => a.entry.at - b.entry.at);
}

export function matches(row: Row): boolean {
  return matchesFilter(state.filter, row.entry) && matchesQuery(state.terms, row.entry, textOf(row));
}

/**
 * Every row matching the filter, newest first.
 *
 * The whole set rather than a screenful: the feed pages through it, and the export means
 * "what I am looking at" rather than "the first page of it".
 */
export function matchingRows(limit = Number.POSITIVE_INFINITY): Row[] {
  const shown: Row[] = [];
  for (let i = state.rows.length - 1; i >= 0 && shown.length < limit; i--) {
    const row = state.rows[i];
    if (row !== undefined && matches(row)) shown.push(row);
  }
  return shown;
}

/** The rows the feed would draw, newest first. Also what "export what I am looking at" means. */
export function visibleRows(limit = FEED_LIMIT): Row[] {
  return matchingRows(limit);
}

/**
 * One page of the feed, and what the pager needs to describe itself.
 *
 * Page zero reads live and is recomputed every draw. Any other page reads the list as it
 * was when the reader left page zero, because a feed that renumbers itself under somebody
 * paging through it is a feed they cannot read.
 */
export function feedPage(size: number): { rows: Row[]; page: number; pages: number; total: number } {
  const all = state.feedPage === 0 || state.feedFrozen === undefined ? matchingRows() : state.feedFrozen;
  const pages = Math.max(1, Math.ceil(all.length / size));
  // A filter that narrows while somebody is on the last page must not leave them past the
  // end looking at nothing.
  const page = Math.min(Math.max(0, state.feedPage), pages - 1);
  if (page !== state.feedPage) state.feedPage = page;
  return { rows: all.slice(page * size, page * size + size), page, pages, total: all.length };
}

/** Moves to a page, freezing the list on the way off page zero and thawing on the way back. */
export function goToFeedPage(page: number): void {
  const next = Math.max(0, page);
  if (next === 0) {
    state.feedFrozen = undefined;
  } else if (state.feedFrozen === undefined) {
    state.feedFrozen = matchingRows();
  }
  state.feedPage = next;
}

export function matchingCount(): number {
  let count = 0;
  for (const row of state.rows) if (matches(row)) count++;
  return count;
}

export function oldestAt(): number | undefined {
  return state.rows[0]?.entry.at;
}

export interface Aggregates {
  detectors: Map<string, number>;
  actors: Map<string, number>;
  identities: Map<string, number>;
  paths: Map<string, number>;
  deniedPaths: Map<string, number>;
  guardStops: Map<string, number>;
  ruleHits: Map<string, number>;
  bypassed: Map<string, number>;
}

function bump(counter: Map<string, number>, key: string): void {
  counter.set(key, (counter.get(key) ?? 0) + 1);
}

/**
 * Everything the window-scoped panels count, in one pass over the ring.
 *
 * One pass rather than eight, and — more to the point — it is now called only by the
 * screen that draws them. It used to run on every frame of the live feed to fill in
 * panels on a tab nobody was looking at.
 */
export function aggregate(rows: readonly Row[]): Aggregates {
  const totals: Aggregates = {
    detectors: new Map(),
    actors: new Map(),
    identities: new Map(),
    paths: new Map(),
    deniedPaths: new Map(),
    guardStops: new Map(),
    ruleHits: new Map(),
    bypassed: new Map(),
  };

  for (const { entry } of rows) {
    for (const item of entry.evidence) bump(totals.detectors, item.detector);
    bump(totals.actors, entry.actor);

    if (entry.bypass !== undefined) {
      bump(totals.bypassed, `${entry.path}  (${entry.bypass})`);
      continue;
    }
    bump(totals.paths, entry.path);
    if (entry.identity !== undefined && entry.identity !== "") {
      // Claimed and confirmed are different facts about the same name, and a panel
      // that merged them would report a forged Googlebot as Googlebot.
      bump(totals.identities, `${entry.identity} · ${entry.verdict === "verified-bot" ? "verified" : "claimed"}`);
    }
    if (outcome(entry) === "deny") bump(totals.deniedPaths, entry.path);
    if (entry.downgradedFrom !== undefined && entry.rule !== undefined) bump(totals.guardStops, `${entry.rule} → ${entry.downgradedFrom}`);
    if (entry.rule !== undefined) bump(totals.ruleHits, entry.rule);
  }

  return totals;
}
