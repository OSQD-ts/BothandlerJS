import { $, byId, clear, cssEscape, el, rootNode } from "./dom.js";
import { feedPage, goToFeedPage, ingest, matchingCount, matchingRows, resetPaging, setSearch, sortRows, state } from "./store.js";
import { getJson } from "./api.js";
import { renderPager } from "./pager.js";
import { SECTIONS } from "./boot.js";
import { app, download, today, toast } from "./app.js";
import { clockTime, n } from "./format.js";
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
}

const rendered = new Map<string, Rendered>();

export function initFeed(): void {
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
  });

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
  try {
    const body = await getJson<{ entries: DashboardEntry[] }>("/api/feed");
    for (const entry of body.entries) ingest(entry);
    sortRows();
  } catch {
    toast("bad", "Could not load them", "The dashboard did not answer. The entries are still in the window; try again.");
    return;
  }
  // What the badge counted has now been asked for, whether or not the ring still had all
  // of it — anything it no longer holds is gone and saying so forever helps nobody.
  state.caughtUp = (state.snapshot?.skipped ?? 0) + state.laggedDrops;
  const added = state.rows.length - before;
  resetPaging();
  app.drawNow();
  toast(
    added > 0 ? "ok" : "warn",
    added > 0 ? `Loaded ${n(added)}` : "Nothing left to load",
    added > 0 ? "They are in the feed now, in the order they happened." : "The window no longer holds them; the ring had already rotated past.",
  );
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

  for (const row of shown) {
    const id = row.entry.requestId;
    const open = state.open.has(id);
    let cached = rendered.get(id);
    if (cached === undefined || cached.rev !== row.rev || cached.open !== open) {
      cached = {
        row: buildRow(row.entry, open),
        detail: open ? buildDetail(row.entry) : undefined,
        rev: row.rev,
        open,
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
  $("feed-count").textContent = matching === total ? `${n(total)} in this window` : `${n(matching)} of ${n(total)}`;
  drawPager(paged);
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
  note.title =
    state.laggedDrops > 0
      ? `${n(state.laggedDrops)} were skipped because this connection could not keep up, and the rest by the rate cap. All of them are still in the window, the preview and the export.`
      : "Entries the rate cap kept off this stream. They are still in the window, the preview and the export — raise maxEventsPerSecond to see them live.";
}

/** Drops every cached node. Used when the feed is cleared under the page's feet. */
export function resetFeedCache(): void {
  rendered.clear();
}

function buildRow(entry: DashboardEntry, open: boolean): HTMLTableRowElement {
  const out = outcome(entry);
  const tr = el("tr", `row a-${entry.downgradedFrom !== undefined ? "guard" : out}${open ? " open" : ""}`);

  // When it happened, which the feed never used to say. Ordering implies it while the
  // stream is live and stops implying it the moment you type into the filter box.
  tr.appendChild(el("td", "num mono tnum when", clockTime(entry.at)));

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
  if (SECTIONS.actors) {
    const actorLink = el("a", null, entry.actor);
    actorLink.href = "#actor";
    actorLink.title = "Show everything from this actor";
    actorLink.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openActor(entry.actor);
    });
    ua.appendChild(actorLink);
    ua.appendChild(document.createTextNode(` · ${entry.userAgent}`));
  } else {
    ua.appendChild(document.createTextNode(`${entry.actor} · ${entry.userAgent}`));
  }
  ua.title = `${entry.actor} · ${entry.userAgent}`;
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
      const row = el("div", `ev-item${item.direction === "human" ? " human" : ""}`);
      row.appendChild(el("div", `tier t-${item.certainty}`, item.certainty));
      const body = el("div");
      body.appendChild(el("div", null, item.summary));
      let meta = `${item.detector} · points to ${item.direction}`;
      if (item.family !== undefined) meta += ` · family “${item.family}”, counted once with its siblings`;
      body.appendChild(el("div", "ev-meta", meta));
      if (item.deterministicBasis !== undefined) body.appendChild(el("div", "basis", item.deterministicBasis));
      row.appendChild(body);
      list.appendChild(row);
    }
    cell.appendChild(list);
  }

  for (const failure of entry.failures) {
    cell.appendChild(el("div", "ev-meta", `Detector ${failure.detector} ${failure.reason}: ${failure.message}`));
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
  foot.appendChild(el("span", null, clockTime(entry.at)));
  foot.appendChild(el("span", null, `actor ${entry.actor}`));
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
