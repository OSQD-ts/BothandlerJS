import { isEmbedded } from "./dom.js";
import { getJson, postJson } from "./api.js";

/**
 * Filters somebody saved.
 *
 * Kept by the dashboard's listener, with a copy in this browser.
 *
 * They used to be kept *only* in this browser, as a personal working note that needed no
 * write endpoint. That held in one situation — an ordinary tab, on a dashboard whose
 * address never changed — and failed silently in every other. Embedded, the page never
 * touches the host page's storage, so nothing was kept. And Save asked for a name with
 * `prompt()`, which a sandboxed frame such as VS Code's built-in browser blocks outright,
 * so the button did nothing at all. Both looked like "saving does not work".
 *
 * So the listener is the source of truth: a saved filter is there after a reload, in
 * another browser, and inside somebody else's page. This browser keeps a copy anyway, for
 * one reason — a listener with no `savedFilters.file` starts empty after a restart, and the
 * copy is handed back to it. Leaving the file unset therefore loses nothing that the old
 * browser-only version kept.
 *
 * Hidden traffic used to live here too, as a second list. It does not any more: `$not`
 * in the query says the same thing and, unlike a list in one person's browser, travels
 * in the URL — so a view with the noise taken out is something you can send somebody.
 */
export interface SavedFilter {
  name: string;
  /** The query text, exactly as typed. */
  query: string;
  /** The chip it was saved with, because a filter is usually both. */
  filter: string;
}

const MIRROR_KEY = "bothandler.filters";

/** The list as last seen, so drawing it never waits on the network. */
let known: SavedFilter[] = [];

function readMirror(): SavedFilter[] {
  // Embedded, the storage belongs to the page around us and is shared with whatever else
  // that page keeps there. Reading is harmless; writing somebody else's origin is not, so
  // neither happens.
  if (isEmbedded()) return [];
  try {
    const raw = localStorage.getItem(MIRROR_KEY);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SavedFilter[]).filter((entry) => typeof entry?.name === "string" && typeof entry?.query === "string") : [];
  } catch {
    return [];
  }
}

function writeMirror(list: readonly SavedFilter[]): void {
  if (isEmbedded()) return;
  try {
    localStorage.setItem(MIRROR_KEY, JSON.stringify(list));
  } catch {
    /* A full or refused store is not a reason to stop showing traffic. */
  }
}

/** The list as last seen. Synchronous; see `refreshSavedFilters` for fetching it. */
export function savedFilters(): readonly SavedFilter[] {
  return known;
}

/**
 * Fetches the listener's list, and hands it this browser's copy if it came up empty.
 *
 * Empty with a copy here means a listener that restarted without a file, which is the
 * exact case the copy exists for. A handler old enough to have no endpoint answers with an
 * error, and then this browser's copy is the list — the behaviour it always had.
 */
export async function refreshSavedFilters(): Promise<readonly SavedFilter[]> {
  const mirror = readMirror();
  try {
    let { filters } = await getJson<{ filters: SavedFilter[] }>("/api/filters");
    if (filters.length === 0 && mirror.length > 0) {
      // Oldest first, so the newest ends up at the top as it was.
      for (const entry of [...mirror].reverse()) {
        const result = await postJson<{ filters: SavedFilter[] }>("/api/filters", entry);
        if (result.ok) filters = result.data.filters;
      }
    }
    known = filters;
    writeMirror(known);
  } catch {
    known = mirror;
  }
  return known;
}

/** Saves under a name, replacing any filter already using it. */
export async function saveFilter(entry: SavedFilter): Promise<{ ok: boolean; error?: string }> {
  const result = await postJson<{ filters: SavedFilter[] }>("/api/filters", entry);
  if (result.ok) {
    known = result.data.filters;
    writeMirror(known);
    return { ok: true };
  }
  // Kept here anyway, so a listener that cannot take it does not cost somebody the filter
  // they just named. It goes to the listener the next time one comes up empty.
  known = [entry, ...known.filter((existing) => existing.name !== entry.name)].slice(0, 50);
  writeMirror(known);
  return result.error === undefined ? { ok: false } : { ok: false, error: result.error };
}

export async function deleteFilter(name: string): Promise<void> {
  const result = await postJson<{ filters: SavedFilter[] }>("/api/filters", { action: "delete", name });
  known = result.ok ? result.data.filters : known.filter((entry) => entry.name !== name);
  writeMirror(known);
}
