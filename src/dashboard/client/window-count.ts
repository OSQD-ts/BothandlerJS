import { getJson } from "./api.js";
import { isEmbedded } from "./dom.js";
import { state } from "./store.js";
import type { DashboardEntry } from "./types.js";

export type { WindowCount } from "./types.js";


/** One page of entries, plus the counts that came with it. */
interface PageResponse {
  entries: DashboardEntry[];
  matching: number;
  retained: number;
  oldestRetained?: number;
  countsFrom?: number;
  retentionMs: number;
}

/**
 * The identity of a view, for caching.
 *
 * The time window only. Not the query, not the chip: those narrow what is *shown* and are
 * answered here rather than by the server, so they cannot change the number being cached.
 */
export function windowKey(from: number | undefined, to: number | undefined): string {
  return `${from ?? ""}:${to ?? ""}`;
}

const CACHE_KEY = "bothandler.window-counts";
/** Enough windows for somebody moving between a few incidents. Past this it is not a cache. */
const MAX_CACHED = 40;

interface Cached {
  key: string;
  matching: number;
  at: number;
  /** Absolute, and derived from the server's retention: the count is only as durable as the data. */
  expiresAt: number;
}

/**
 * Counts this browser has already been told, kept across reloads.
 *
 * Counts and window keys only — no entries, no addresses, no User-Agents, nothing a
 * request contained. The feed's rows are deliberately *not* cached here: they carry client
 * addresses, User-Agents and headers, and writing those to disk would put request data at
 * rest on the operator's machine, outliving the session that was authorised to see it.
 * Numbers cost nothing to keep and are the half that makes the page feel instant anyway —
 * the pager can say how many pages exist before a single one has been fetched.
 *
 * An entry expires when the server would no longer have the data behind it, which is what
 * ties the lifetime of this cache to the configured retention rather than to a number
 * invented here.
 */
function readCache(): Cached[] {
  // Embedded, the storage belongs to the page around us. Reading is harmless; writing
  // somebody else's origin is not, so neither happens.
  if (isEmbedded()) return [];
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const now = Date.now();
    return (parsed as Cached[]).filter((entry) => typeof entry?.key === "string" && typeof entry.matching === "number" && typeof entry.expiresAt === "number" && entry.expiresAt > now);
  } catch {
    return [];
  }
}

function writeCache(entries: readonly Cached[]): void {
  if (isEmbedded()) return;
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(entries.slice(0, MAX_CACHED)));
  } catch {
    /* A full or refused store is not a reason to stop showing traffic. */
  }
}

/** The last count this browser was told for a window, if it has not expired. */
export function cachedCount(key: string): number | undefined {
  return readCache().find((entry) => entry.key === key)?.matching;
}

function remember(key: string, matching: number, retentionMs: number): void {
  const now = Date.now();
  // A retention of zero means the ring is bounded only by capacity, so there is no honest
  // expiry to give a count — it is kept for an hour, which is short enough to be wrong
  // about briefly and long enough to be worth having.
  const expiresAt = now + (retentionMs > 0 ? retentionMs : 60 * 60_000);
  const rest = readCache().filter((entry) => entry.key !== key);
  writeCache([{ key, matching, at: now, expiresAt }, ...rest]);
}

function query(from: number | undefined, to: number | undefined, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams(extra);
  if (from !== undefined) params.set("from", String(from));
  if (to !== undefined) params.set("to", String(to));
  const text = params.toString();
  return text === "" ? "" : `?${text}`;
}

/**
 * Asks how many requests fell in the window on screen.
 *
 * Cheap on purpose: `limit=1` because the answer wanted is the count, and the one entry
 * that rides along is the price of not adding a second endpoint for it.
 */
let lastAsked = 0;
let inFlight: Promise<void> | undefined;
/** Often enough to feel live, rarely enough that a burst of frames is still one request. */
const MIN_GAP_MS = 1500;

export async function refreshWindowCount(options: { force?: boolean } = {}): Promise<void> {
  const now = Date.now();
  if (inFlight !== undefined) return inFlight;
  if (options.force !== true && now - lastAsked < MIN_GAP_MS) return;
  lastAsked = now;
  inFlight = askForCount().finally(() => {
    inFlight = undefined;
  });
  return inFlight;
}

async function askForCount(): Promise<void> {
  const key = windowKey(state.fromMs, state.toMs);
  try {
    const body = await getJson<PageResponse>(`/api/feed${query(state.fromMs, state.toMs, { offset: "0", limit: "1" })}`);
    state.window = {
      matching: body.matching,
      retained: body.retained,
      countsFrom: body.countsFrom,
      retentionMs: body.retentionMs,
      at: Date.now(),
    };
    remember(key, body.matching, body.retentionMs);
  } catch {
    // A dashboard that cannot reach its server has larger problems and says so elsewhere.
    // Here the right behaviour is to leave the last known count alone rather than to
    // replace a true number with a zero.
  }
}

/**
 * Fetches entries from the window, newest first, by absolute offset.
 *
 * An offset rather than a page number, because the caller is filling a *range* — it asks
 * for everything up to the end of the page somebody navigated to, which does not start on
 * a page boundary once part of that range is already held.
 */
export async function fetchFeedEntries(offset: number, limit: number): Promise<DashboardEntry[]> {
  const body = await getJson<PageResponse>(`/api/feed${query(state.fromMs, state.toMs, { offset: String(offset), limit: String(limit) })}`);
  state.window = {
    matching: body.matching,
    retained: body.retained,
    countsFrom: body.countsFrom,
    retentionMs: body.retentionMs,
    at: Date.now(),
  };
  remember(windowKey(state.fromMs, state.toMs), body.matching, body.retentionMs);
  return body.entries;
}
