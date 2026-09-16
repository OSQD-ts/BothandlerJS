import { $, byId, clear, cssEscape, el, rootNode } from "./dom.js";
import { referenceLink } from "./reference.js";
import { feedPage, goToFeedPage, groupCounts, groupKeyOf, hiddenCount, ingest, labelOf, matchingCount, matchingRows, refreshFrozenPage, resetPaging, setSearch, setTimeframe, sortRows, state } from "./store.js";
import type { FeedGroup, FeedOrder } from "./store.js";
import { deleteFilter, refreshSavedFilters, saveFilter, savedFilters } from "./saved.js";
import { suggestFor } from "./query.js";
import { getJson } from "./api.js";
import { fetchFeedEntries, refreshWindowCount } from "./window-count.js";
import { renderPager } from "./pager.js";
import { SECTIONS } from "./boot.js";
import { app, download, today, toast } from "./app.js";
import { clockDate, clockStamp, clockTime, feedCountLabel, n } from "./format.js";
import { corpusCase, replayFile, replayLine } from "./replay.js";
import { openActor } from "./actor.js";
import { outcome, verdictBadge } from "./outcome.js";
import { draftIntoEditor } from "./policy.js";
import type { FilterName } from "./query.js";
import type { DashboardEntry } from "./types.js";

const FILTERS: Array<[FilterName, string]> = [
  ["all", "All"],
  ["proven", "Proven"],
  ["suspected", "Suspected"],
  ["human", "Human"],
  ["guard", "Guard stops"],
  ["deny", "Denied"],
  ["mitigate", "Mitigated"],
  ["allow", "Served"],
];

/** A row currently in the table, and what it was built from. */
interface Rendered {
  row: HTMLTableRowElement;
  detail: HTMLTableRowElement | undefined;
  rev: number;
  open: boolean;
  /**
   * The actor's name when this row was drawn.
   *
   * Part of what decides whether a row is stale, because a name is given after the fact
   * and naming an actor has to reach the rows already on screen. Only the rows of the
   * actor that was renamed are rebuilt; every other row keeps its node, and with it any
   * text somebody is in the middle of selecting.
   */
  label: string | undefined;
}

const rendered = new Map<string, Rendered>();

export function initFeed(): void {
  byId<HTMLButtonElement>("feed-show-hidden").addEventListener("click", () => {
    state.showHidden = !state.showHidden;
    resetPaging();
    app.drawNow();
  });
  const loadThem = byId<HTMLButtonElement>("feed-load-skipped");
  loadThem.addEventListener("click", () => {
    // Disabled while it is in flight, because the fetch is the whole ring and a second
    // press would ask for it again.
    loadThem.disabled = true;
    void loadSkipped().finally(() => {
      loadThem.disabled = false;
    });
  });

  const filters = $("filters");
  for (const [name, label] of FILTERS) {
    const button = el("button", null, label);
    button.setAttribute("aria-pressed", String(name === state.filter));
    button.dataset["filter"] = name;
    button.addEventListener("click", () => {
      state.filter = name;
      resetPaging();
      for (const other of Array.from(filters.children)) other.setAttribute("aria-pressed", "false");
      button.setAttribute("aria-pressed", "true");
      app.syncUrl();
      app.drawNow();
    });
    filters.appendChild(button);
  }

  const search = byId<HTMLInputElement>("search");
  search.addEventListener("input", () => {
    setSearch(search.value.trim());
    app.syncUrl();
    app.drawNow();
    showSuggestions(search);
  });
  initSuggestions(search);
  initTimeframe();
  initSavedFilters(search);
  initArrangement();

  // Downloading the window is the bulk half of what the per-row buttons do one request
  // at a time. It exports what is on screen rather than everything held, because the
  // filter is how you said which requests you meant.
  const exportShown = byId<HTMLButtonElement>("feed-export");
  exportShown.hidden = !SECTIONS.evidence;
  exportShown.addEventListener("click", () => {
    const rows = matchingRows();
    if (rows.length === 0) {
      toast("warn", "Nothing to export", "No request in the window matches this filter.");
      return;
    }
    // Oldest first, so the file replays in the order the traffic happened.
    const entries = rows.map((row) => row.entry).reverse();
    download(`${replayFile(entries)}\n`, `bothandler-feed-${today()}.jsonl`, "application/x-ndjson");
    toast("ok", `Exported ${n(entries.length)} request(s)`, "Replay them with `bothandlerjs replay`.");
  });
}

/** Applies filter state that arrived in the URL rather than from a click. */
export function reflectFilterButtons(): void {
  for (const button of Array.from($("filters").children)) {
    button.setAttribute("aria-pressed", String(button instanceof HTMLElement && button.dataset["filter"] === state.filter));
  }
  const search = byId<HTMLInputElement>("search");
  if (search.value !== state.search) search.value = state.search;
}

/**
 * Fetches the entries this viewer never received, and merges them.
 *
 * They were never lost. The rate cap keeps a burst off the *stream* and the lag guard
 * drops frames a slow socket cannot take, but both leave the ring alone — and the opening
 * replay is droppable too, so a first load of a busy dashboard can arrive with most of the
 * backlog missing. `/api/feed` serves that ring whole, and `ingest` is keyed on the request
 * id, so merging it is idempotent: what is already held is refreshed, what is missing is
 * added.
 *
 * On demand rather than on a timer. Skips happen exactly when the origin is busiest, and a
 * dashboard that answered every skip by re-fetching the whole ring would be a load
 * amplifier pointed at the process it is meant to be watching — which is the thing
 * `maxEventsPerSecond` exists to prevent.
 */
export async function loadSkipped(): Promise<void> {
  const before = state.rows.length;
  let served: number | undefined;
  try {
    const body = await getJson<{ entries: DashboardEntry[]; skipped?: number }>("/api/feed");
    for (const entry of body.entries) ingest(entry);
    served = body.skipped;
    sortRows();
  } catch {
    toast("bad", "Could not load them", "The dashboard did not answer. The entries are still in the window; try again.");
    return;
  }
  // What the badge counted has now been asked for, whether or not the ring still had all
  // of it — anything it no longer holds is gone and saying so forever helps nobody.
  //
  // Counted from the response that closed the gap rather than from `state.snapshot`,
  // which is refreshed on a timer and was therefore usually a few seconds out of date. A
  // snapshot arriving afterwards with a larger count reopened a gap that had just been
  // closed, so the badge came back on a feed holding everything there was — you pressed
  // the button, it said how many it had loaded, and the thing the button exists to clear
  // stayed on screen. Older handlers do not send the field; theirs is the previous
  // behaviour rather than an error.
  state.caughtUp = (served ?? state.snapshot?.skipped ?? 0) + state.laggedDrops;
  const added = state.rows.length - before;
  resetPaging();
  app.drawNow();
  toast(
    added > 0 ? "ok" : "warn",
    added > 0 ? `Loaded ${n(added)}` : "Nothing left to load",
    added > 0 ? "They are in the feed now, in the order they happened." : "The window no longer holds them; the ring had already rotated past.",
  );
}


/**
 * The two controls that say how the feed is arranged.
 *
 * Both are plain selects rather than clickable column headings, for the same reason the
 * filter chips are buttons: a row is one control that opens and closes, and a heading that
 * sorts is a second thing to click on a table where clicking already means something.
 */
function initArrangement(): void {
  const order = byId<HTMLSelectElement>("feed-order");
  const group = byId<HTMLSelectElement>("feed-group");
  order.value = state.order;
  group.value = state.group;
  order.addEventListener("change", () => {
    state.order = order.value as FeedOrder;
    rearranged();
  });
  group.addEventListener("change", () => {
    state.group = group.value as FeedGroup;
    rearranged();
  });
}

/** Reflects order and grouping that arrived in the URL rather than from a click. */
export function reflectArrangement(): void {
  const order = byId<HTMLSelectElement>("feed-order");
  const group = byId<HTMLSelectElement>("feed-group");
  if (order.value !== state.order) order.value = state.order;
  if (group.value !== state.group) group.value = state.group;
}

/**
 * Back to the first page on a change of arrangement.
 *
 * Page four of one ordering is not page four of another, so staying put would leave
 * somebody on a page they never chose, reading rows they were not looking at.
 */
function rearranged(): void {
  resetPaging();
  app.syncUrl();
  app.drawNow();
}

/**
 * Completion for the filter box.
 *
 * The options come from the parser's own field map rather than a list kept beside it, so
 * a field added to the language is offered the day it exists and one removed stops being
 * offered. Values are completed only where the set is genuinely closed — `rule`,
 * `identity` and `path` take anything, and guessing there would be inventing options
 * rather than completing them.
 */
let highlighted = -1;

function suggestionList(): HTMLElement {
  return $("search-suggest");
}

function closeSuggestions(input: HTMLInputElement): void {
  const list = suggestionList();
  list.hidden = true;
  clear(list);
  highlighted = -1;
  input.setAttribute("aria-expanded", "false");
}

function showSuggestions(input: HTMLInputElement): void {
  const caret = input.selectionStart ?? input.value.length;
  const { options, from, to } = suggestFor(input.value, caret);
  const list = suggestionList();
  if (options.length === 0 || input.value.slice(from, to) === options[0]) {
    closeSuggestions(input);
    return;
  }
  clear(list);
  highlighted = -1;
  options.slice(0, 12).forEach((option, index) => {
    const item = el("li", null, option);
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", "false");
    // `mousedown` rather than `click`: the input loses focus first on a click, and the
    // blur handler closes the list out from under the pointer.
    item.addEventListener("mousedown", (event) => {
      event.preventDefault();
      apply(input, option, from, to);
    });
    item.dataset["index"] = String(index);
    list.appendChild(item);
  });
  list.hidden = false;
  input.setAttribute("aria-expanded", "true");
}

function apply(input: HTMLInputElement, option: string, from: number, to: number): void {
  const before = input.value.slice(0, from);
  const after = input.value.slice(to);
  input.value = `${before}${option}${after}`;
  const caret = before.length + option.length;
  input.setSelectionRange(caret, caret);
  setSearch(input.value.trim());
  app.syncUrl();
  app.drawNow();
  closeSuggestions(input);
  // Completing a field name leaves the caret after the colon, where the values are — so
  // offer them straight away rather than making somebody type a character to see them.
  showSuggestions(input);
  input.focus();
}

function initSuggestions(input: HTMLInputElement): void {
  input.addEventListener("keydown", (event) => {
    const list = suggestionList();
    const items = Array.from(list.querySelectorAll("li"));
    if (list.hidden || items.length === 0) return;
    if (event.key === "Escape") {
      closeSuggestions(input);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      highlighted = (highlighted + (event.key === "ArrowDown" ? 1 : items.length - 1) + (highlighted === -1 && event.key === "ArrowUp" ? 1 : 0)) % items.length;
      items.forEach((item, index) => item.setAttribute("aria-selected", String(index === highlighted)));
      return;
    }
    if ((event.key === "Enter" || event.key === "Tab") && highlighted >= 0) {
      const chosen = items[highlighted]?.textContent ?? "";
      const caret = input.selectionStart ?? input.value.length;
      const { from, to } = suggestFor(input.value, caret);
      event.preventDefault();
      apply(input, chosen, from, to);
    }
  });
  input.addEventListener("blur", () => {
    setTimeout(() => closeSuggestions(input), 120);
  });
  input.addEventListener("focus", () => showSuggestions(input));
}

/**
 * The saved-filter control: a list to load from, a name box to save under, and Delete.
 *
 * Save used to ask for a name with `prompt()`, which a sandboxed frame blocks outright — an
 * embedded dashboard, VS Code's built-in browser — so there it did nothing, silently. The
 * label editor stopped using `prompt()` for the same reason; this is the same fix. Delete
 * was never shown at all: it was offered only when the list had something selected, and
 * that was checked the instant the list was built, when nothing ever is.
 */
function initSavedFilters(input: HTMLInputElement): void {
  const host = $("saved-filters");
  // Which saved filter is selected, kept across redraws so Delete knows what it deletes.
  let selected = "";
  let naming = false;

  const redraw = (): void => {
    clear(host);
    const entries = savedFilters();
    if (!entries.some((entry) => entry.name === selected)) selected = "";

    const select = document.createElement("select");
    select.setAttribute("aria-label", "Saved filters");
    const first = document.createElement("option");
    first.value = "";
    first.textContent = entries.length === 0 ? "No saved filters" : "Saved filters…";
    select.appendChild(first);
    for (const entry of entries) {
      const option = document.createElement("option");
      option.value = entry.name;
      option.textContent = entry.name;
      select.appendChild(option);
    }
    select.value = selected;
    select.addEventListener("change", () => {
      selected = select.value;
      const chosen = entries.find((entry) => entry.name === selected);
      if (chosen !== undefined) {
        input.value = chosen.query;
        setSearch(chosen.query);
        state.filter = chosen.filter as typeof state.filter;
        reflectFilterButtons();
        resetPaging();
        app.syncUrl();
        app.drawNow();
      }
      redraw();
    });
    host.appendChild(select);

    if (naming) {
      const name = el("input", "saved-name") as HTMLInputElement;
      name.type = "text";
      name.maxLength = 60;
      name.placeholder = "Name this filter";
      name.setAttribute("aria-label", "Name for this filter");
      name.title = "Enter to save, Escape to cancel";
      // The name it was loaded as, so re-saving an edited filter overwrites it by default.
      name.value = selected;
      const confirm = el("button", "saved-confirm", "Save") as HTMLButtonElement;
      confirm.type = "button";
      const cancel = el("button", null, "Cancel") as HTMLButtonElement;
      cancel.type = "button";

      // Whether this naming has already been settled, so a blur that follows Enter or the
      // button does not save the same filter twice.
      let finished = false;
      // Which control the pointer went down on, because a button does not take focus on
      // click in every engine — so "where did focus go" cannot be the test for whether
      // somebody was reaching for Cancel.
      let leavingFor: "cancel" | "confirm" | undefined;
      const done = (): void => {
        finished = true;
        naming = false;
        redraw();
      };
      const commit = (options: { fromBlur?: boolean } = {}): void => {
        if (finished) return;
        const chosen = name.value.trim();
        if (chosen === "") {
          // Nothing typed. Pressing the button means "I meant to type something"; leaving
          // the box means "never mind".
          if (options.fromBlur === true) done();
          else name.focus();
          return;
        }
        finished = true;
        void saveFilter({ name: chosen, query: input.value.trim(), filter: state.filter }).then((result) => {
          selected = chosen;
          done();
          if (result.ok) toast("ok", "Filter saved", `"${chosen}" is kept by this dashboard, for anybody who opens it.`);
          else toast("warn", "Saved in this browser only", `The dashboard did not take it${result.error === undefined ? "" : ` (${result.error})`}. It will be offered again the next time the dashboard starts empty.`);
        });
      };
      name.addEventListener("keydown", (event) => {
        if ((event as KeyboardEvent).key === "Enter") {
          event.preventDefault();
          commit();
        } else if ((event as KeyboardEvent).key === "Escape") {
          event.preventDefault();
          done();
        }
      });
      /**
       * Leaving the box with a name in it saves under that name.
       *
       * It used to do nothing whatsoever: the box stayed on screen holding the name, no
       * request was made and nothing was said — which looks exactly like having saved it.
       * Somebody who types a name and clicks back into the feed, or tabs on, has said what
       * they want the filter called; the only readings of that are "save it" and "lose it
       * silently".
       *
       * Escape and Cancel still cancel, and the pointer-down flag is what tells them apart:
       * a button does not take focus on click in WebKit, so the blur cannot be judged by
       * where focus landed.
       */
      cancel.addEventListener("pointerdown", () => {
        leavingFor = "cancel";
      });
      confirm.addEventListener("pointerdown", () => {
        leavingFor = "confirm";
      });
      name.addEventListener("blur", () => {
        // After the click that caused the blur has been handled, the way the suggestion
        // list below this one already does it.
        setTimeout(() => {
          if (finished) return;
          if (leavingFor !== undefined) {
            leavingFor = undefined;
            return;
          }
          commit({ fromBlur: true });
        }, 140);
      });
      confirm.addEventListener("click", () => commit());
      cancel.addEventListener("click", done);
      host.append(name, confirm, cancel);
      name.focus();
      name.select();
      return;
    }

    const save = el("button", null, "Save") as HTMLButtonElement;
    save.type = "button";
    save.title = "Save this filter under a name. The dashboard keeps it, for anybody who opens it.";
    save.addEventListener("click", () => {
      naming = true;
      redraw();
    });
    host.appendChild(save);

    if (selected !== "") {
      const remove = el("button", null, "Delete") as HTMLButtonElement;
      remove.type = "button";
      remove.title = `Delete the saved filter "${selected}". The query in the box is left as it is.`;
      remove.addEventListener("click", () => {
        const gone = selected;
        void deleteFilter(gone).then(() => {
          selected = "";
          redraw();
          toast("ok", "Filter deleted", `"${gone}" is no longer saved.`);
        });
      });
      host.appendChild(remove);
    }
  };

  redraw();
  // Drawn at once from whatever is known, then again when the listener has answered —
  // the page should not wait on a round trip to show the filter bar.
  void refreshSavedFilters().then(redraw);
}




/**
 * The window somebody is looking at.
 *
 * `datetime-local` reads and writes local wall-clock time, which is what the feed's own
 * timestamps show — so the value in the box means the same thing as the value in the
 * rows. Either end may be left empty, and that is the whole design: one control answers
 * "from the incident until now", "everything up to when it stopped" and "between these
 * two moments" without three sets of buttons.
 */
function initTimeframe(): void {
  const from = byId<HTMLInputElement>("from-at");
  const to = byId<HTMLInputElement>("to-at");
  const clearButton = byId<HTMLButtonElement>("timeframe-clear");

  const read = (input: HTMLInputElement): number | undefined => {
    if (input.value === "") return undefined;
    const parsed = new Date(input.value).getTime();
    return Number.isFinite(parsed) ? parsed : undefined;
  };

  const apply = (settled: boolean): void => {
    const start = read(from);
    const end = read(to);
    // A backwards range selects nothing and looks like a broken dashboard, so say what
    // happened rather than showing an empty feed.
    //
    // Only once the value is settled. Half of typing a window passes through a state
    // where the end is before the start, and a toast per keystroke would be its own kind
    // of broken dashboard.
    if (settled && start !== undefined && end !== undefined && end < start) {
      toast("warn", "That window runs backwards", "The end is before the start, so nothing can fall inside it.");
    }
    setTimeframe(start, end);
    clearButton.hidden = start === undefined && end === undefined;
    // A new window is a new question, so the count is asked again immediately rather than
    // on the next counters frame — otherwise the header goes on stating the old window's
    // total for up to two seconds after the reader changed it, which is exactly long
    // enough to be read and believed.
    void refreshWindowCount({ force: true }).then(() => app.drawNow());
    app.drawNow();
  };

  // `input` as well as `change`, and `input` is the one that matters. A `datetime-local`
  // fires `input` as each segment is edited and holds `change` back until the value is
  // committed — which for somebody *typing* a date means on blur. Listening only for
  // `change` meant the feed sat unchanged while a window was being typed and moved when
  // they clicked away, which reads as a filter that does not work. A partly-typed value
  // reads as empty, so the intermediate states are simply "no bound", not a broken one.
  for (const input of [from, to]) {
    input.addEventListener("input", () => apply(false));
    input.addEventListener("change", () => apply(true));
  }
  clearButton.addEventListener("click", () => {
    from.value = "";
    to.value = "";
    apply(true);
  });
}

/** Page sizes the feed offers. */
const FEED_PAGE_SIZES = [25, 50, 100, 200] as const;

/**
 * The pager, above the table and below it.
 *
 * Hidden outright on a single page, because a control that can only say "1 of 1" is
 * furniture — and with it the size chooser goes too, which is the one thing lost by that
 * rule and not worth a permanent row of chrome to keep.
 */
/**
 * Makes sure the rows behind a page are held before it is drawn.
 *
 * The subtle part is *what* to fetch. The obvious thing — ask the server for page N — does
 * not work, and the reason is worth stating plainly: the rows this browser holds are not
 * the newest N of the window. The stream's rate cap thins a burst, so what arrived is
 * scattered through the window, while the server pages a dense list by offset. A slice of
 * a sparse list at a dense offset lands somewhere neither side meant, and what that looks
 * like is pages numbered correctly and half empty.
 *
 * So this fetches from offset zero up to the end of the page being asked for. That makes
 * the newest that many rows a *dense prefix*, and a slice of a dense prefix is exactly the
 * server's page. It is still loading only what has been asked for — page four costs four
 * pages, not the whole ring — and `densifiedTo` stops it being paid twice.
 */
let densifying = false;

async function ensureFeedPage(page: number, size: number): Promise<void> {
  const needed = (page + 1) * size;
  if (densifying || needed <= state.densifiedTo) return;
  // A filtered view pages over rows this browser already holds, and the server has never
  // seen the query — so there is nothing coherent to ask it for.
  if (matchingCount() !== state.rows.length) return;
  const retained = state.window?.retained;
  if (retained === undefined) return;
  const target = Math.min(needed, retained);
  if (target <= state.densifiedTo) return;

  // Already holding everything the server has, so it is already dense: the newest N rows
  // here *are* the server's newest N, given the two agree on the order — which is what the
  // sequence tiebreak in `sortRows` is for.
  //
  // Worth the check rather than fetching and finding out. The fetch would return entries
  // this page already has, and merging them recomputes the frozen page list *while
  // somebody is reading it* — the one thing freezing a page exists to prevent. It showed
  // up as an intermittent failure in the test that holds that guarantee, and on a
  // dashboard whose stream was never thinned it was a round trip that could only ever
  // return what was already on screen.
  if (state.rows.length >= retained) {
    state.densifiedTo = Math.max(state.densifiedTo, retained);
    return;
  }

  densifying = true;
  try {
    // In chunks, because the server caps a page and the range asked for may be larger.
    for (let offset = state.densifiedTo; offset < target; offset += FETCH_CHUNK) {
      const entries = await fetchFeedEntries(offset, Math.min(FETCH_CHUNK, target - offset));
      for (const entry of entries) ingest(entry);
      if (entries.length === 0) break;
    }
    sortRows();
    state.densifiedTo = Math.max(state.densifiedTo, target);
    refreshFrozenPage();
  } catch {
    // The count stays true and the table stays as it was. A failed fetch here is worth
    // less noise than a toast on every click of a pager somebody is holding down.
  } finally {
    densifying = false;
  }
}

/** How many entries one densifying request asks for. The server's own page cap. */
const FETCH_CHUNK = 500;

function drawPager(paged: { page: number; pages: number; total: number }): void {
  const size = state.feedPageSize;
  const hidden = paged.pages <= 1;
  const model = {
    page: paged.page,
    from: paged.page * size + 1,
    to: Math.min(paged.total, (paged.page + 1) * size),
    total: paged.total,
    atStart: paged.page === 0,
    atEnd: paged.page >= paged.pages - 1,
    ...(paged.page > 0 ? { held: "held while you read" } : {}),
    go: (page: number): void => {
      goToFeedPage(page);
      // Pages past what this browser holds are fetched rather than shown empty. The
      // server's ring can be several times the size of the page's, and the window total
      // already told the pager those pages exist — so a reader who clicks through to one
      // should get the requests, not a blank table under a truthful page number.
      void ensureFeedPage(page, size).then(() => app.drawNow());
      app.drawNow();
    },
    size: {
      current: size,
      choices: FEED_PAGE_SIZES,
      set: (next: number): void => {
        state.feedPageSize = next;
        // Back to the front: page four of fifty is not page four of two hundred, and
        // keeping the number while changing what it counts moves the reader somewhere
        // they did not ask to go.
        resetPaging();
        app.drawNow();
      },
    },
  };
  for (const [id, withSize] of [
    ["feed-pager-top", true],
    ["feed-pager", false],
  ] as const) {
    const host = $(id);
    host.hidden = hidden;
    if (hidden) clear(host);
    else renderPager(host, model, { withSize });
  }
}

export function drawFeed(): void {
  const body = byId<HTMLTableSectionElement>("rows");
  const paged = feedPage(state.feedPageSize);
  const shown = paged.rows;

  // Keyed reconciliation against what is already in the table.
  //
  // The old renderer emptied the tbody and rebuilt three hundred rows on every frame
  // that carried a new request. Two things were wrong with that, and the invisible one
  // is not the expensive one: rebuilding a node destroys any text selection inside it,
  // so a live feed could not be *read* — drag across a User-Agent to copy it and the
  // next request wiped the selection. Rows are now rebuilt only when the entry behind
  // them changed or they were opened, which on a busy feed is one row in three hundred.
  let index = 0;
  const place = (node: Node): void => {
    const current = body.childNodes[index] ?? null;
    // insertBefore moves a node that is already in the document, so this handles a
    // reorder as well as an insert.
    if (current !== node) body.insertBefore(node, current);
    index++;
  };

  // Group headings, when the feed is grouped. The count is of every matching row in the
  // group rather than of the ones on this page, because "this actor made 212 requests" is
  // the fact worth having; a group carried onto another page repeats its heading, so a
  // page never opens on rows belonging to something unnamed.
  const counts = state.group === "none" ? undefined : groupCounts();
  let lastGroup: string | undefined;

  for (const row of shown) {
    if (counts !== undefined) {
      const key = groupKeyOf(row);
      if (key !== lastGroup) {
        lastGroup = key;
        place(groupHeading(key, counts.get(key) ?? 0));
      }
    }
    const id = row.entry.requestId;
    const open = state.open.has(id);
    const label = labelOf(row.entry.actor);
    let cached = rendered.get(id);
    if (cached === undefined || cached.rev !== row.rev || cached.open !== open || cached.label !== label) {
      cached = {
        row: buildRow(row.entry, open),
        detail: open ? buildDetail(row.entry) : undefined,
        rev: row.rev,
        open,
        label,
      };
      rendered.set(id, cached);
    }
    place(cached.row);
    if (cached.detail !== undefined) place(cached.detail);
  }

  while (body.childNodes.length > index) body.removeChild(body.childNodes[index] as Node);

  // The cache outlives the table — a row scrolled past the filter is likely to come
  // back — but not indefinitely. Anything not on screen goes once it has grown past
  // twice the visible set.
  if (rendered.size > shown.length * 2 + 100) {
    const live = new Set(shown.map((row) => row.entry.requestId));
    for (const id of Array.from(rendered.keys())) if (!live.has(id)) rendered.delete(id);
  }

  const total = state.rows.length;
  const matching = matchingCount();
  $("empty").hidden = total > 0;
  // No "showing 300" any more: the pager reaches the rest, so the count says what is in
  // the window and the pager says where in it you are.
  //
  // The window total comes from the server, which counts requests in minute buckets apart
  // from the entries, so it is exact whether or not the entries behind it survive. What
  // this page can count for itself — how many of its loaded rows match the query box — is
  // reported as exactly that. See `feedCountLabel`.
  const label = feedCountLabel({
    total: state.window?.matching,
    loaded: total,
    matching,
    filtered: matching !== total,
  });
  const count = $("feed-count");
  count.textContent = label.text;
  count.title = label.title;
  drawPager(paged);
  // Redrawn with the feed rather than once at start-up: its whole message is a count of
  // what is being hidden *now*, and drawn once it said "hiding 0 of 0" for the rest of
  // the session because the rows had not arrived yet.
  // `#feed-window` carries the `win` class, so `updateWindowLabels` fills it — one
  // owner for a label that appears on eight panels.

  // A thinned feed must never look like a quiet one. The ring still has these — they
  // are in the preview, in the export and in whatever a reconnect replays — but they
  // were kept off the stream to stop a busy origin handing every open browser a
  // megabyte a second.
  // Minus what has already been fetched back: the server's own count only ever grows, so
  // without this the badge goes on reporting a gap that has been filled.
  const skipped = Math.max(0, (state.snapshot?.skipped ?? 0) + state.laggedDrops - state.caughtUp);
  const note = $("feed-skipped");
  note.hidden = skipped === 0;
  note.textContent = `${n(skipped)} not streamed`;
  // The badge used to state the gap and leave it there. It is now next to the button that
  // closes it.
  byId<HTMLButtonElement>("feed-load-skipped").hidden = skipped === 0;

  // What a label is keeping off the screen, said out loud for the same reason the gap
  // above is: hidden traffic is still being judged and acted on, and a feed that hides
  // part of what is happening must never look like a quieter one. The count is of
  // requests in the window, and the button puts them back without touching any label.
  const hidden = hiddenCount();
  const hiddenNote = $("feed-hidden");
  const showHidden = byId<HTMLButtonElement>("feed-show-hidden");
  hiddenNote.hidden = hidden === 0;
  showHidden.hidden = hidden === 0;
  hiddenNote.textContent = state.showHidden ? `showing ${n(hidden)} hidden by label` : `${n(hidden)} hidden by label`;
  hiddenNote.title = "Requests from actors whose label says to keep them out of the live feed. They are still analysed, decided and counted.";
  showHidden.textContent = state.showHidden ? "Hide" : "Show";
  showHidden.setAttribute("aria-pressed", String(state.showHidden));
  note.title =
    state.laggedDrops > 0
      ? `${n(state.laggedDrops)} were skipped because this connection could not keep up, and the rest by the rate cap. All of them are still in the window, the preview and the export.`
      : "Entries the rate cap kept off this stream. They are still in the window, the preview and the export — raise maxEventsPerSecond to see them live.";
}

/** Drops every cached node. Used when the feed is cleared under the page's feet. */
export function resetFeedCache(): void {
  rendered.clear();
  headings.clear();
}

/** The heading rows, cached like the rows are: a group that has not changed is not rebuilt. */
const headings = new Map<string, { node: HTMLTableRowElement; count: number; label: string | undefined }>();

function groupHeading(key: string, count: number): HTMLTableRowElement {
  // An actor with a name is named here too — the key is what a rule would have to match,
  // and the name is what the person reading it calls that client.
  const label = state.group === "actor" ? labelOf(key) : undefined;
  const cached = headings.get(key);
  if (cached !== undefined && cached.count === count && cached.label === label) return cached.node;

  const row = el("tr", "grp");
  const cell = el("th");
  cell.colSpan = 6;
  cell.scope = "colgroup";
  const name = el("span", "grp-key", label === undefined ? key : `${label} (${key})`);
  cell.appendChild(name);
  cell.appendChild(el("span", "grp-n", `${n(count)} request${count === 1 ? "" : "s"}`));
  row.appendChild(cell);
  headings.set(key, { node: row, count, label });
  return row;
}

function buildRow(entry: DashboardEntry, open: boolean): HTMLTableRowElement {
  const out = outcome(entry);
  const tr = el("tr", `row a-${entry.downgradedFrom !== undefined ? "guard" : out}${open ? " open" : ""}`);

  // When it happened, which the feed never used to say. Ordering implies it while the
  // stream is live and stops implying it the moment you type into the filter box.
  //
  // The full date as well as the time. A feed that retains an hour can be read as "today"
  // without thinking about it; one retaining a week cannot, and "09:14:02" on a row from
  // last Tuesday is the kind of wrong that nobody catches because it looks right. The
  // date is in its own element so the stylesheet can drop it on a narrow screen, where
  // the column has no room and the rows are all recent anyway.
  const when = el("td", "num mono tnum when");
  when.append(el("span", "when-date", clockDate(entry.at)), el("span", "when-time", clockTime(entry.at)));
  when.title = clockStamp(entry.at);
  tr.appendChild(when);

  const request = el("td", "edge req");
  // The row's one control. It carries the name, the state and the keys; the row itself
  // keeps a click handler for the mouse, which needs no role to be useful.
  const toggle = el("button", "row-toggle", `${entry.method} ${entry.path}`);
  toggle.type = "button";
  toggle.setAttribute("aria-expanded", String(open));
  toggle.setAttribute("aria-label", `${entry.method} ${entry.path}, ${entry.verdict}. Evidence.`);
  toggle.dataset["request"] = entry.requestId;
  request.appendChild(toggle);
  const ua = el("span", "ua");
  // The name instead of the address, when somebody has given it one. Recognising a client
  // is the whole reason for naming it, and an address in its place makes the reader do
  // the recognising again on every row. The address stays one hover away, and in the row
  // detail, because it is still the thing a rule or an allowlist is written against.
  const label = labelOf(entry.actor);
  const who = label ?? entry.actor;
  if (SECTIONS.actors) {
    const actorLink = el("a", label === undefined ? null : "labelled", who);
    actorLink.href = "#actor";
    actorLink.title = label === undefined ? "Show everything from this actor" : `${label} — ${entry.actor}. Show everything from this actor`;
    actorLink.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openActor(entry.actor);
    });
    ua.appendChild(actorLink);
    ua.appendChild(document.createTextNode(` · ${entry.userAgent}`));
  } else {
    ua.appendChild(document.createTextNode(`${who} · ${entry.userAgent}`));
  }
  ua.title = label === undefined ? `${entry.actor} · ${entry.userAgent}` : `${label} (${entry.actor}) · ${entry.userAgent}`;
  request.appendChild(ua);
  tr.appendChild(request);

  const verdictCell = el("td");
  const [badgeClass, badgeLabel] = verdictBadge(entry);
  verdictCell.appendChild(el("span", `badge ${badgeClass}`, badgeLabel));
  if (entry.identity !== undefined) verdictCell.appendChild(el("span", "sub", entry.identity));
  tr.appendChild(verdictCell);

  tr.appendChild(el("td", "num mono tnum", entry.certain ? "proven" : String(entry.score)));

  const actionCell = el("td");
  if (entry.action !== undefined) {
    const kind = out === "deny" ? "act-deny" : out === "mitigate" ? "act-mitigate" : out === "allow" ? "act-allow" : "act-tag";
    actionCell.appendChild(el("span", `act ${kind}`, entry.action));
    if (entry.rule !== undefined) {
      const ruleLabel = el("span", "sub", entry.rule);
      ruleLabel.title = entry.rule;
      actionCell.appendChild(ruleLabel);
    }
    if (entry.downgradedFrom !== undefined) actionCell.appendChild(el("span", "guard", `guard stopped ${entry.downgradedFrom}`));
  } else {
    actionCell.appendChild(el("span", "sub", "assessed only"));
  }
  tr.appendChild(actionCell);

  tr.appendChild(el("td", "num mono tnum", entry.durationMs.toFixed(2)));

  tr.dataset["request"] = entry.requestId;
  const flip = (): void => {
    if (state.open.has(entry.requestId)) state.open.delete(entry.requestId);
    else state.open.add(entry.requestId);
    app.drawNow();
    // The row was rebuilt, so focus has to be put back or a keyboard user is returned
    // to the top of the document every time they open one.
    rootNode().querySelector<HTMLElement>(`button.row-toggle[data-request="${cssEscape(entry.requestId)}"]`)?.focus();
  };
  toggle.addEventListener("click", (event) => {
    event.stopPropagation();
    flip();
  });
  // Clicking anywhere in the row is the mouse affordance people expect from a feed, and
  // it needs no role to work — a click is not an accessibility contract.
  tr.addEventListener("click", flip);
  return tr;
}

function buildDetail(entry: DashboardEntry): HTMLTableRowElement {
  const tr = el("tr", "detail");
  const cell = el("td");
  cell.colSpan = 6;

  // What was done, with the action as a way to read what it does. The row says the same in
  // its action column, but the row is one control that opens and closes, and a link
  // inside it would be a second one competing for the same click.
  if (entry.action !== undefined) {
    const decided = el("div", "ev-meta");
    decided.append("Action ", referenceLink("action", entry.action));
    if (entry.rule !== undefined) decided.append(`, chosen by rule ${entry.rule}`);
    if (entry.downgradedFrom !== undefined) decided.append(" · the guard stopped ", referenceLink("action", entry.downgradedFrom));
    cell.appendChild(decided);
  }

  if (!SECTIONS.evidence) {
    cell.appendChild(
      el(
        "div",
        "ev-meta",
        "The evidence section is switched off on this dashboard, so the reasons behind this verdict are not sent to it. What fired, and why, is on a dashboard that has `sections: { evidence: true }`.",
      ),
    );
  } else if (entry.evidence.length === 0) {
    cell.appendChild(
      el(
        "div",
        "ev-meta",
        entry.bypass !== undefined
          ? `Detection was skipped for this request: ${entry.bypass}.`
          : "No detector produced any evidence. This is what ordinary traffic looks like.",
      ),
    );
  } else {
    const list = el("div", "ev");
    for (const item of entry.evidence) {
      const row = el("div", `ev-item${item.direction === "human" ? " human" : ""}${item.shadow === true ? " shadow" : ""}`);
      row.appendChild(el("div", `tier t-${item.certainty}`, item.certainty));
      const body = el("div");
      body.appendChild(el("div", null, item.summary));
      let meta = ` · points to ${item.direction}`;
      if (item.family !== undefined) meta += ` · family “${item.family}”, counted once with its siblings`;
      // Said on every shadowed line rather than once at the top. A reader scanning the
      // list is looking at one row at a time, and a row that reads like evidence and was
      // not evidence is the single most misleading thing this page could show.
      if (item.shadow === true) meta += " · shadowed: counted, and part of no decision";
      const metaLine = el("div", "ev-meta");
      metaLine.append(referenceLink("detector", item.detector), meta);
      body.appendChild(metaLine);
      if (item.deterministicBasis !== undefined) body.appendChild(el("div", "basis", item.deterministicBasis));
      row.appendChild(body);
      list.appendChild(row);
    }
    cell.appendChild(list);
  }

  // The counterfactual, in the one place somebody is already asking "why this verdict".
  if (entry.shadowVerdict !== undefined) {
    const would = entry.shadowVerdict;
    const changed = would.verdict !== entry.verdict;
    cell.appendChild(
      el(
        "div",
        `ev-meta shadow-verdict${changed ? " changed" : ""}`,
        changed
          ? `With the shadowed detectors counted, this request would have been ${would.verdict} at ${would.score} instead of ${entry.verdict} at ${entry.score}.`
          : `With the shadowed detectors counted, this request would still have been ${would.verdict}${would.score === entry.score ? "" : `, at ${would.score} rather than ${entry.score}`}.`,
      ),
    );
  }

  for (const failure of entry.failures) {
    const line = el("div", "ev-meta");
    line.append("Detector ", referenceLink("detector", failure.detector), ` ${failure.reason}: ${failure.message}`);
    cell.appendChild(line);
  }
  if (entry.downgradeReason !== undefined) cell.appendChild(el("div", "basis", `Guard: ${entry.downgradeReason}`));

  const queryNames = Object.keys(entry.query);
  if (queryNames.length > 0) {
    const queryTable = el("table", "hdr");
    for (const name of queryNames) {
      const value = entry.query[name] ?? "";
      const row = el("tr");
      row.appendChild(el("td", "n", `?${name}`));
      row.appendChild(el("td", `v${value === "[redacted]" ? " red" : ""}`, value));
      queryTable.appendChild(row);
    }
    cell.appendChild(queryTable);
  }

  // The header set in wire order: what half the detectors are actually reading, and the
  // first thing worth looking at when a verdict seems wrong.
  if (entry.headers !== undefined && entry.headers.length > 0) {
    const table = el("table", "hdr");
    for (const [name, value] of entry.headers) {
      const row = el("tr");
      row.appendChild(el("td", "n", `${name}:`));
      row.appendChild(el("td", `v${value === "[redacted]" ? " red" : ""}`, value));
      table.appendChild(row);
    }
    cell.appendChild(table);
  }

  const tools = el("div", "tools");
  if (SECTIONS.evidence) {
    tools.appendChild(copyButton("Copy replay line", () => replayLine(entry)));
    tools.appendChild(downloadButton("Download replay line", () => replayLine(entry), `request-${entry.requestId}.jsonl`));
    tools.appendChild(copyButton("Copy corpus case", () => corpusCase(entry)));
  }
  if (SECTIONS.policy) {
    const draft = el("button", null, "Draft a rule");
    draft.title = "Start a rule from this request, in the policy editor";
    draft.addEventListener("click", (event) => {
      event.stopPropagation();
      void draftIntoEditor(entry);
    });
    tools.appendChild(draft);
  }
  if (SECTIONS.actors) {
    const actorButton = el("button", null, "Show this actor");
    actorButton.addEventListener("click", (event) => {
      event.stopPropagation();
      openActor(entry.actor);
    });
    tools.appendChild(actorButton);
  }
  cell.appendChild(tools);

  const foot = el("div", "detail-foot");
  foot.appendChild(el("span", null, clockStamp(entry.at)));
  // Both, here. The row above shows the name; this is where somebody comes to find out
  // what the name stands for, and which key a rule would have to name to reach it.
  const named = labelOf(entry.actor);
  if (named === undefined) foot.appendChild(el("span", null, `actor ${entry.actor}`));
  else {
    const tag = el("span", "label-note");
    tag.appendChild(document.createTextNode("actor "));
    tag.appendChild(el("b", null, named));
    tag.appendChild(document.createTextNode(` · ${entry.actor}`));
    tag.title = "A name an operator gave this actor. It is a note for people reading the dashboard; detection never reads it.";
    foot.appendChild(tag);
  }
  if (entry.rule !== undefined) foot.appendChild(el("span", null, `rule “${entry.rule}”`));
  foot.appendChild(el("span", null, `assessed in ${entry.durationMs.toFixed(3)}ms`));
  foot.appendChild(el("span", "mono", entry.requestId));
  cell.appendChild(foot);

  tr.appendChild(cell);
  return tr;
}

function copyButton(label: string, produce: () => string): HTMLButtonElement {
  const button = el("button", null, label);
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    const text = produce();
    const done = (): void => {
      button.textContent = "Copied";
      setTimeout(() => {
        button.textContent = label;
      }, 1200);
    };
    // navigator.clipboard needs a secure context, which a dashboard on a plain HTTP LAN
    // address is not. The fallback selects the text so a keyboard copy still works
    // rather than leaving a button that does nothing.
    if (navigator.clipboard?.writeText !== undefined) navigator.clipboard.writeText(text).then(done, () => showText(text));
    else showText(text);
  });
  return button;
}

function downloadButton(label: string, produce: () => string, filename: string): HTMLButtonElement {
  const button = el("button", null, label);
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    download(`${produce()}\n`, filename, "application/x-ndjson");
  });
  return button;
}

function showText(text: string): void {
  const box = el("pre", "code", text);
  const host = $("policy-result");
  host.hidden = false;
  host.className = "result";
  clear(host);
  host.appendChild(el("div", "ev-meta", "Copying needs a secure context; here is the text."));
  host.appendChild(box);
  const selection = getSelection();
  if (selection !== null) {
    const range = document.createRange();
    range.selectNodeContents(box);
    selection.removeAllRanges();
    selection.addRange(range);
  }
}
