import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { safeSummary } from "../internal/text.js";

/**
 * Filters somebody saved, kept by the dashboard rather than by one browser.
 *
 * They used to live in `localStorage`, on the reasoning that a saved filter is a personal
 * working note and so needs no write endpoint. That reasoning held in exactly one place: a
 * normal browser tab on a dashboard whose address never changes. Everywhere else it failed
 * without a word. Embedded as `<bot-dashboard>` the page deliberately never touches the host
 * page's storage, so nothing was ever kept; and the Save button asked for a name with
 * `prompt()`, which a sandboxed frame — VS Code's built-in browser among them — blocks
 * outright, so the button did nothing at all.
 *
 * So the listener keeps them, one list per listener: a dashboard that masks addresses has
 * a different audience from one that does not, and should not be handed that one's
 * filters. In memory by default, so they survive a reload and a change of browser; in a
 * file when `savedFilters.file` is set, so they survive the process restarting too. The page
 * also keeps a copy and hands it back to a listener that comes up empty, so leaving the file
 * unset loses nothing that the browser used to keep.
 */
export interface SavedFilter {
  name: string;
  /** The query text, exactly as typed. */
  query: string;
  /** The chip it was saved with, because a filter is usually both. */
  filter: string;
}

/** Enough for a working set; past this it is a list nobody reads. */
const MAX_SAVED = 50;
const MAX_NAME = 60;
/** The same ceiling the query parser reads to. */
const MAX_QUERY = 8192;
/** The chips a filter can be saved with. Anything else is not something the page can show. */
export const FILTER_CHIPS: ReadonlySet<string> = new Set(["all", "proven", "suspected", "human", "guard", "deny", "mitigate", "allow"]);

/** A saved filter as it is kept: bounded, quoted, and `undefined` when it is not one. */
export function cleanSavedFilter(value: unknown): SavedFilter | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw["name"] !== "string" || typeof raw["query"] !== "string") return undefined;
  // Quoted like a label: typed by one person, printed on everybody's screen.
  const name = safeSummary(raw["name"]).trim().slice(0, MAX_NAME);
  if (name === "") return undefined;
  const filter = typeof raw["filter"] === "string" && FILTER_CHIPS.has(raw["filter"]) ? raw["filter"] : "all";
  return { name, query: raw["query"].slice(0, MAX_QUERY), filter };
}

export class SavedFilterStore {
  private entries: SavedFilter[] = [];

  constructor(
    private readonly file: string | undefined,
    private readonly warn: (message: string) => void,
  ) {
    if (file !== undefined) this.load(file);
  }

  list(): readonly SavedFilter[] {
    return this.entries;
  }

  /** Saves under a name, replacing any filter already using it, newest first. */
  save(entry: SavedFilter): void {
    this.entries = [entry, ...this.entries.filter((existing) => existing.name !== entry.name)].slice(0, MAX_SAVED);
    this.persist();
  }

  delete(name: string): void {
    const before = this.entries.length;
    this.entries = this.entries.filter((entry) => entry.name !== name);
    if (this.entries.length !== before) this.persist();
  }

  private load(file: string): void {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (error) {
      // No file yet is the normal first run. Anything else is worth a word.
      if ((error as { code?: string }).code !== "ENOENT") this.warn(`Saved filters could not be read from ${file}: ${(error as Error).message}. Starting with none.`);
      return;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      const list = Array.isArray(parsed) ? parsed : [];
      const seen = new Set<string>();
      for (const item of list) {
        const entry = cleanSavedFilter(item);
        if (entry === undefined || seen.has(entry.name)) continue;
        seen.add(entry.name);
        this.entries.push(entry);
        if (this.entries.length >= MAX_SAVED) break;
      }
    } catch (error) {
      this.warn(`Saved filters in ${file} are not valid JSON (${(error as Error).message}). Starting with none; the file will be replaced on the next save.`);
    }
  }

  /**
   * Written whole, to a temporary file first and then renamed over the real one, so a
   * process killed halfway through leaves the previous list rather than half of a new one.
   * A failure keeps the list in memory and says so; a dashboard that cannot write a file
   * should still have the filters somebody just saved.
   */
  private persist(): void {
    if (this.file === undefined) return;
    const temporary = `${this.file}.${process.pid}.tmp`;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(temporary, `${JSON.stringify(this.entries, null, 2)}\n`, "utf8");
      renameSync(temporary, this.file);
    } catch (error) {
      this.warn(`Saved filters could not be written to ${this.file}: ${(error as Error).message}. They are kept in memory until the process ends.`);
    }
  }
}
