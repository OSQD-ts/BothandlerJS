import { matches as matchesFilterExpression, matchesFilter, parseFilter, searchableText } from "./query.js";
import { outcome } from "./outcome.js";
import type { EditorRule } from "./draft.js";
import type { Filter, FilterName } from "./query.js";
import type { ActorRow, DashboardEntry, Policy, Row, Snapshot, TabName, WindowCount } from "./types.js";

/** Requests the page keeps. The server's ring is smaller; this is the ceiling, not the target. */
const MAX_ROWS = 1000;

/** Rows built into the table at once. Beyond this a feed is scrolled past, not read. */
export const FEED_LIMIT = 300;

/**
 * How the feed is ordered.
 *
 * "Newest first" is the feed's own order and the only one that costs nothing: the rows are
 * already held that way, so it is a walk rather than a sort. The rest are a sort of what
 * matches, which is bounded by what this page holds.
 */
export type FeedOrder = "newest" | "oldest" | "score-high" | "score-low" | "slowest" | "fastest";

/**
 * What the feed is grouped by, or `none`.
 *
 * Applied to the whole matching list rather than to a page of it, so a group is contiguous
 * wherever it falls — group a thousand requests by actor and page through them, and each
 * actor's requests stay together rather than being scattered by where the page boundaries
 * happen to land.
 */
export type FeedGroup = "none" | "actor" | "verdict" | "action" | "class" | "rule" | "path";

export interface State {
  rows: Row[];
  byId: Map<string, Row>;
  snapshot: Snapshot | undefined;
  policy: Policy | undefined;
  /** The Actors screen's list, fetched rather than streamed. See `registry.ts`. */
  actors: ActorRow[];
  /**
   * Every name an operator has given an actor, keyed as the feed keys actors.
   *
   * The source of truth for names on this page. It arrives complete on every stats
   * frame, which is what the registry list could not be: that list is paged, so a name
   * was known only for actors that happened to be on the page last fetched.
   */
  labels: Map<string, string>;
  /** Labelled actors whose label switches something. See `DashboardSnapshot.labelSwitches`. */
  labelSwitches: Map<string, { hide?: true; skip?: true }>;
  /**
   * Whether requests from actors labelled "hide from the live feed" are shown anyway.
   *
   * Off by default, which is what hiding means. On a click, because hidden traffic is still
   * traffic that is being judged and acted on, and "I cannot see it" must never quietly
   * become "nothing is happening".
   */
  showHidden: boolean;
  actorsTracked: number;
  /** Which population the Actors screen is listing. See `registry.feedActors`. */
  actorScope: "tracked" | "feed";
  /** The Actors screen's own query, in the feed's language over actors. */
  actorsQuery: string;
  /**
   * How many actors the query matches.
   *
   * Counted by whoever filtered: the server for the tracked list, which is paged there, and
   * the page itself for the feed-derived one. It is what lets the pager say how many pages
   * there are — something the unfiltered tracked list could never say cheaply, because it
   * only ever knew whether the page it asked for came back full.
   */
  actorsMatching: number;
  paused: boolean;
  filter: FilterName;
  search: string;
  /** The parsed search. A tree, so `$or` means something. */
  query: Filter;
  /** How the rows are ordered. See {@link FeedOrder}. */
  order: FeedOrder;
  /** What the rows are grouped by, if anything. See {@link FeedGroup}. */
  group: FeedGroup;
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
   * The window somebody asked to look at, as absolute instants.
   *
   * Either end may be left open, which is what makes one control answer all three of the
   * questions people actually ask: from an incident until now, from the beginning until
   * something stopped, or between two moments.
   */
  fromMs: number | undefined;
  toMs: number | undefined;
  /**
   * How many skipped entries have already been fetched back and merged.
   *
   * The server's `skipped` only ever grows, so the badge subtracts this to say how many
   * are *still* missing rather than how many ever were.
   */
  caughtUp: number;
  /**
   * What the *server* says about the window on screen: how many requests fell in it, and
   * how many of those it still holds entries for.
   *
   * Distinct from `rows.length`, which is what this browser happens to be holding, and the
   * distinction is the point — see `window-count.ts`. `undefined` until the first answer
   * arrives, which is why every reader falls back to the local count rather than to zero.
   */
  window: WindowCount | undefined;
  /**
   * How many of the newest entries in this window are held *densely*.
   *
   * The rows this page holds are not a prefix of the window. The stream's rate cap thins
   * a burst, so what arrives is scattered through the window rather than being its newest
   * N — and the server pages a dense list by offset. Slicing a sparse local list at a
   * dense remote offset lands somewhere neither side meant, which is what made the first
   * attempt at reaching past the loaded rows produce pages that were numbered correctly
   * and half empty.
   *
   * So paging past what is held fetches from offset zero up to the end of the page being
   * asked for, which makes the newest that many rows a dense prefix — and a slice of a
   * dense prefix is exactly the server's page. This is how far that prefix reaches.
   */
  densifiedTo: number;
}

export const state: State = {
  rows: [],
  byId: new Map(),
  snapshot: undefined,
  policy: undefined,
  actors: [],
  labels: new Map(),
  labelSwitches: new Map(),
  order: "newest",
  group: "none",
  showHidden: false,
  actorsTracked: 0,
  actorScope: "tracked",
  actorsQuery: "",
  window: undefined,
  densifiedTo: 0,
  actorsMatching: 0,
  paused: false,
  filter: "all",
  search: "",
  query: { kind: "all" },
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
  fromMs: undefined,
  toMs: undefined,
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
    // Only when it actually changed. `rev` is what tells the renderer a row is stale, and
    // a stale row is rebuilt — which takes any text selection inside it with it, so a
    // feed that bumped revisions for entries that had not moved could not be *read*.
    //
    // Re-ingesting an unchanged entry is ordinary rather than exceptional: a page fetched
    // to fill the pager overlaps what the stream already delivered, and every one of those
    // arrives here identical to the row already on screen.
    if (sameEntry(existing.entry, entry)) return;
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

/**
 * Whether a re-delivered entry says anything new.
 *
 * Compared field by field rather than by serialising both: this runs once per entry on
 * every merge, and the fields that can change after an entry is first published are few
 * and known — a request is written once when it is assessed and again when the decision
 * lands. Everything else about it is fixed by the time it reaches this page.
 */
function sameEntry(a: DashboardEntry, b: DashboardEntry): boolean {
  return (
    a.seq === b.seq &&
    a.action === b.action &&
    a.rule === b.rule &&
    a.verdict === b.verdict &&
    a.score === b.score &&
    a.downgradedFrom === b.downgradedFrom &&
    a.downgradeReason === b.downgradeReason
  );
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
  state.densifiedTo = 0;
  // And the frozen page goes with them, for the same reason: it holds rows this store no
  // longer has, so a reader left on page three would be paging through a list of things
  // that are gone.
  resetPaging();
}

export function setSearch(value: string): void {
  state.search = value;
  state.query = parseFilter(value);
  // A narrower search over a frozen page-three is somebody reading rows their filter no
  // longer selects. Any change to what matches goes back to the live first page.
  resetPaging();
}

/** Sets the window somebody is looking at. Either end may be left open. */
export function setTimeframe(from: number | undefined, to: number | undefined): void {
  state.fromMs = from;
  state.toMs = to;
  // A different window is a different list, so what was dense in the old one says nothing
  // about this one.
  state.densifiedTo = 0;
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
  // By time, then by the server's own sequence number.
  //
  // The tiebreak is not a nicety. A burst puts many requests in the same millisecond, and
  // a sort on `at` alone leaves those in whatever order they were merged — which for a
  // page fetched over HTTP is not the order the server holds them in. The feed then
  // disagrees with the server about which requests are "the newest fifty", and paging
  // through a window shows some of them twice and misses others entirely. `seq` numbers
  // the requests on the server, so sorting by it is agreeing with the list being paged.
  state.rows.sort((a, b) => a.entry.at - b.entry.at || a.entry.seq - b.entry.seq);
}

/** Whether this row belongs to an actor whose label hides it from the feed. */
export function hiddenByLabel(row: Row): boolean {
  return state.labelSwitches.size > 0 && state.labelSwitches.get(row.entry.actor)?.hide === true;
}

export function matches(row: Row): boolean {
  if (!state.showHidden && hiddenByLabel(row)) return false;
  // The timeframe first, because it is a number comparison and the cheapest thing here to
  // fail on.
  if (state.fromMs !== undefined && row.entry.at < state.fromMs) return false;
  if (state.toMs !== undefined && row.entry.at > state.toMs) return false;
  return matchesFilter(state.filter, row.entry) && matchesFilterExpression(state.query, row.entry, textOf(row), state.labels.get(row.entry.actor));
}

/**
 * Every row matching the filter, newest first.
 *
 * The whole set rather than a screenful: the feed pages through it, and the export means
 * "what I am looking at" rather than "the first page of it".
 */
export function matchingRows(limit = Number.POSITIVE_INFINITY): Row[] {
  // The feed's own order, and the common case: the rows are already held oldest first, so
  // newest first is a walk backwards and no sort at all. Kept as its own path because it
  // runs on every frame of a live feed.
  if (state.order === "newest" && state.group === "none") {
    const shown: Row[] = [];
    for (let i = state.rows.length - 1; i >= 0 && shown.length < limit; i--) {
      const row = state.rows[i];
      if (row !== undefined && matches(row)) shown.push(row);
    }
    return shown;
  }

  const shown: Row[] = [];
  for (const row of state.rows) if (matches(row)) shown.push(row);
  shown.sort(comparatorFor(state.order));
  const arranged = state.group === "none" ? shown : groupRows(shown, state.group);
  return limit === Number.POSITIVE_INFINITY ? arranged : arranged.slice(0, limit);
}

/** Two rows in the chosen order. Ties fall back to newest first, then to the server's sequence. */
function comparatorFor(order: FeedOrder): (a: Row, b: Row) => number {
  const newest = (a: Row, b: Row): number => b.entry.at - a.entry.at || b.entry.seq - a.entry.seq;
  switch (order) {
    case "oldest":
      return (a, b) => a.entry.at - b.entry.at || a.entry.seq - b.entry.seq;
    case "score-high":
      return (a, b) => b.entry.score - a.entry.score || newest(a, b);
    case "score-low":
      return (a, b) => a.entry.score - b.entry.score || newest(a, b);
    case "slowest":
      return (a, b) => b.entry.durationMs - a.entry.durationMs || newest(a, b);
    case "fastest":
      return (a, b) => a.entry.durationMs - b.entry.durationMs || newest(a, b);
    default:
      return newest;
  }
}

/**
 * The rows again, with each group's rows together.
 *
 * Groups appear in the order their first row does, and the rows inside one keep the order
 * they arrived in — so grouping rearranges the list without ever contradicting the sort
 * above it.
 */
function groupRows(rows: readonly Row[], group: FeedGroup): Row[] {
  const buckets = new Map<string, Row[]>();
  for (const row of rows) {
    const key = groupKeyOf(row, group);
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [row]);
    else bucket.push(row);
  }
  const out: Row[] = [];
  for (const bucket of buckets.values()) out.push(...bucket);
  return out;
}

/** Which group a row belongs to. Stable and printable: it is also what the header says. */
export function groupKeyOf(row: Row, group: FeedGroup = state.group): string {
  const entry = row.entry;
  switch (group) {
    case "actor":
      return entry.actor;
    case "verdict":
      return entry.verdict;
    case "action":
      return entry.action ?? "assessed only";
    case "class":
      return entry.botClass;
    case "rule":
      return entry.rule ?? "no rule matched";
    case "path":
      return entry.path;
    default:
      return "";
  }
}

/** How many matching rows each group holds, for the headers. */
export function groupCounts(group: FeedGroup = state.group): Map<string, number> {
  const counts = new Map<string, number>();
  if (group === "none") return counts;
  for (const row of state.rows) {
    if (!matches(row)) continue;
    const key = groupKeyOf(row, group);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
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
  // Sized by what the server can still produce, not by what this browser happens to hold.
  //
  // Two different numbers live above this screen and only one of them belongs here. How
  // many requests *happened* in the window is the larger and truer one, and it is what the
  // header leads with — but the entries behind the older part of it may have been evicted,
  // so pages sized by it would be pages that can never be filled. `retained` is how many
  // the server still has, and every one of those is reachable: `ensureFeedPage` fetches
  // what a page needs before it is drawn.
  //
  // Only when nothing is filtering. A query narrows the feed in *this browser* and the
  // server has never seen it, so neither of the server's numbers says anything about how
  // many rows match.
  const unfiltered = matchingCount() === state.rows.length;
  const reachable = unfiltered && state.window !== undefined ? Math.max(all.length, state.window.retained) : all.length;
  const pages = Math.max(1, Math.ceil(reachable / size));
  // A filter that narrows while somebody is on the last page must not leave them past the
  // end looking at nothing.
  const page = Math.min(Math.max(0, state.feedPage), pages - 1);
  if (page !== state.feedPage) state.feedPage = page;
  return { rows: all.slice(page * size, page * size + size), page, pages, total: reachable };
}

/**
 * Takes the frozen page list in again, after rows were fetched *for* it.
 *
 * The freeze exists so that a request arriving over the stream does not move every row
 * under somebody reading page three. It is not meant to exclude rows this reader asked
 * for: a page fetched from the server because they paged onto it has to become part of
 * the list they are paging through, or they land on a page that is provably there and
 * see nothing in it.
 */
export function refreshFrozenPage(): void {
  if (state.feedFrozen !== undefined) state.feedFrozen = matchingRows();
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

/**
 * Takes the names from a stats frame.
 *
 * Only when the frame carries them: a listener with the actors section switched off sends
 * none, and an older handler never did, and neither of those means every actor has just
 * lost its name.
 */
export function takeLabels(
  labels: Readonly<Record<string, string>> | undefined,
  switches?: Readonly<Record<string, { hide?: true; skip?: true }>> | undefined,
): void {
  if (labels === undefined) return;
  state.labels = new Map(Object.entries(labels));
  // Absent on a masked listener, where hiding by label would hide a whole network. That
  // means "nothing is hidden here", so it clears rather than keeping stale switches.
  state.labelSwitches = new Map(Object.entries(switches ?? {}));
}

/** How many rows in the ring are being kept out of the feed by a label. */
export function hiddenCount(): number {
  if (state.labelSwitches.size === 0) return 0;
  let count = 0;
  for (const row of state.rows) if (hiddenByLabel(row)) count++;
  return count;
}

/** The name an actor has been given, if any. */
export function labelOf(key: string): string | undefined {
  return state.labels.get(key);
}
