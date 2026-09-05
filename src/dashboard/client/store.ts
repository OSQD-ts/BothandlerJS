import { matchesFilter, matchesQuery, parseQuery, searchableText } from "./query.js";
import { outcome } from "./outcome.js";
import type { ActorRow } from "./registry.js";
import type { EditorRule } from "./draft.js";
import type { FilterName, Term } from "./query.js";
import type { DashboardEntry, Policy, Row, Snapshot, TabName } from "./types.js";

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
}

export function setSearch(value: string): void {
  state.search = value;
  state.terms = parseQuery(value);
}

function textOf(row: Row): string {
  if (row.text === undefined) row.text = searchableText(row.entry);
  return row.text;
}

export function matches(row: Row): boolean {
  return matchesFilter(state.filter, row.entry) && matchesQuery(state.terms, row.entry, textOf(row));
}

/** The rows the feed would draw, newest first. Also what "export what I am looking at" means. */
export function visibleRows(limit = FEED_LIMIT): Row[] {
  const shown: Row[] = [];
  for (let i = state.rows.length - 1; i >= 0 && shown.length < limit; i--) {
    const row = state.rows[i];
    if (row !== undefined && matches(row)) shown.push(row);
  }
  return shown;
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
