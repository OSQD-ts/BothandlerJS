import { isEmbedded } from "./dom.js";

/**
 * Filters somebody saved.
 *
 * They live in this browser rather than on the handler, and that is a decision worth
 * stating. A saved filter is a personal working note — the view one operator returns to
 * during an incident — not configuration the whole team shares. Keeping it here means it
 * needs no write endpoint, no auth decision about who may change whose, and no migration
 * when the handler restarts. The cost is that it does not follow you to another machine,
 * which is the right trade for a bookmark.
 *
 * Hidden traffic used to live here too, as a second list. It does not any more: `$not`
 * in the query says the same thing and, unlike a list in one person's browser, travels
 * in the URL — so a view with the noise taken out is something you can send somebody.
 *
 * Every read and write is wrapped: a private window, cleared site data or a browser set to
 * refuse storage all throw on access rather than returning nothing, and a dashboard that
 * cannot save a bookmark must still show the traffic.
 */
export interface SavedFilter {
  name: string;
  /** The query text, exactly as typed. */
  query: string;
  /** The chip it was saved with, because a filter is usually both. */
  filter: string;
}

const FILTERS_KEY = "bothandler.filters";
/** Enough for a working set; past this it is a list nobody reads. */
const MAX_SAVED = 50;

function read<T>(key: string, fallback: T): T {
  // Embedded, the storage belongs to the page around us and is shared with whatever else
  // that page keeps there. Reading is harmless; writing somebody else's origin is not, so
  // neither happens.
  if (isEmbedded()) return fallback;
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  if (isEmbedded()) return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* A full or refused store is not a reason to stop showing traffic. */
  }
}

export function savedFilters(): SavedFilter[] {
  return read<SavedFilter[]>(FILTERS_KEY, []).filter((entry) => typeof entry?.name === "string");
}

/** Saves under a name, replacing any filter already using it. */
export function saveFilter(entry: SavedFilter): SavedFilter[] {
  const kept = savedFilters().filter((existing) => existing.name !== entry.name);
  const next = [entry, ...kept].slice(0, MAX_SAVED);
  write(FILTERS_KEY, next);
  return next;
}

export function deleteFilter(name: string): SavedFilter[] {
  const next = savedFilters().filter((entry) => entry.name !== name);
  write(FILTERS_KEY, next);
  return next;
}


