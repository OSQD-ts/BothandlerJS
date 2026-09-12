import { $, byId, el, eventTarget, isEmbedded, rootNode, themeElement } from "./dom.js";
import { API, BOOT, SECTIONS } from "./boot.js";
import { app, toast } from "./app.js";
import { clearFeed, setSearch, state } from "./store.js";
import { drawActor, initActor } from "./actor.js";
import { connectStream, loadInitialSnapshot } from "./stream.js";
import { drawAudit, drawChanges, drawChips, drawLivePanels, drawNoticeBadge, drawNotices, drawPeers, drawStatsPanels, drawTiles, updateWindowLabels } from "./panels.js";
import { drawFeed, initFeed, reflectFilterButtons, resetFeedCache } from "./feed.js";
import { drawLatency, drawScores, drawTraffic } from "./charts.js";
import { applyActorScope, applyActorsQuery, drawActors, initActorScope, initActorsSearch, trackActors } from "./registry.js";
import { drawPolicyTab, initPolicy, loadPolicy } from "./policy.js";
import { loadRanges } from "./ranges.js";
import { initTester } from "./tester.js";
import type { FilterName } from "./query.js";
import type { TabName } from "./types.js";

/** The views this listener has, in tab-strip order. Sections decide which exist. */
const TABS: Array<[id: string, name: TabName, enabled: boolean]> = [
  ["tab-live", "live", SECTIONS.feed],
  ["tab-actors", "actors", SECTIONS.registry],
  ["tab-stats", "stats", SECTIONS.statistics],
  ["tab-policy", "policy", SECTIONS.policy],
];

const available = TABS.filter(([, , enabled]) => enabled);
const FIRST: TabName = available[0]?.[1] ?? "live";

function tabIndexOf(name: TabName): number {
  const at = available.findIndex(([, tab]) => tab === name);
  return at === -1 ? 0 : at;
}

function isTab(value: string): value is TabName {
  return available.some(([, name]) => name === value);
}

// ---- header ----------------------------------------------------------------

/**
 * The skip link, which is a plain fragment anchor and therefore inert inside a shadow
 * root: fragment navigation does not cross the boundary, so the one affordance that lets
 * a keyboard past the header did nothing at all when embedded. Given the same behaviour
 * by hand.
 */
function initSkipLink(): void {
  if (!isEmbedded()) return;
  const skip = rootNode().querySelector<HTMLAnchorElement>("a.skip");
  if (skip === null) return;
  skip.addEventListener("click", (event) => {
    event.preventDefault();
    const target = rootNode().querySelector<HTMLElement>(`#view-${state.tab}`) ?? rootNode().querySelector<HTMLElement>("#view-live");
    if (target === null) return;
    target.tabIndex = -1;
    target.focus();
    target.scrollIntoView({ block: "start" });
  });
}

function initHeader(): void {
  const box = $("links");
  for (const link of BOOT.links) {
    const anchor = el("a", "linkbtn", link.label);
    anchor.href = link.href;
    anchor.rel = "noreferrer noopener";
    box.appendChild(anchor);
  }

  let stored: string | null = null;
  try {
    stored = localStorage.getItem("bothandler-dashboard-theme");
  } catch {
    stored = null;
  }
  if (stored === "dark" || stored === "light") themeElement().setAttribute("data-theme", stored);
  $("theme").addEventListener("click", () => {
    let current = themeElement().getAttribute("data-theme");
    if (current === null) current = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    const next = current === "dark" ? "light" : "dark";
    themeElement().setAttribute("data-theme", next);
    try {
      localStorage.setItem("bothandler-dashboard-theme", next);
    } catch {
      /* private mode */
    }
    // The charts read their colours from the CSS custom properties, so they have to be
    // redrawn rather than restyled.
    drawNow();
  });

  const pause = byId<HTMLButtonElement>("pause");
  pause.hidden = !SECTIONS.feed;
  pause.addEventListener("click", () => {
    state.paused = !state.paused;
    pause.setAttribute("aria-pressed", String(state.paused));
    pause.textContent = state.paused ? `Resume${state.bufferedWhilePaused > 0 ? ` (${state.bufferedWhilePaused})` : ""}` : "Pause";
    if (!state.paused) {
      state.bufferedWhilePaused = 0;
      drawNow();
    }
  });

  if (BOOT.allowReset) {
    const reset = byId<HTMLButtonElement>("reset");
    reset.hidden = false;
    reset.addEventListener("click", () => {
      reset.disabled = true;
      void fetch(`${API}/api/reset`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
        .then(async (response) => {
          if (!response.ok) {
            const body = (await response.json().catch(() => ({}))) as { error?: string };
            toast("bad", "Reset refused", body.error ?? String(response.status));
            return;
          }
          clearFeed();
          resetFeedCache();
          drawNow();
        })
        .catch(() => {
          /* the stream will resync */
        })
        .finally(() => {
          reset.disabled = false;
        });
    });
  }

  /**
   * The sticky column headers used to sit at a hard-coded 54px — the height of the top
   * row alone — so the tab strip covered them the moment the feed scrolled. The header
   * is not a fixed height: the chip row wraps on a narrow window and grows. Measure it,
   * and let the CSS read the measurement.
   */
  const header = rootNode().querySelector("header");
  if (header !== null) {
    const apply = (): void => {
      themeElement().style.setProperty("--header-h", `${header.getBoundingClientRect().height}px`);
    };
    apply();
    if (typeof ResizeObserver === "function") new ResizeObserver(apply).observe(header);
    else addEventListener("resize", apply);
  }
}

// ---- navigation -------------------------------------------------------------

/**
 * The view, the filter, the search and the Actors scope live in the URL.
 *
 * The view already did. The rest are what make a screen shareable — "look at the
 * guard stops on /export" is a link now rather than a set of instructions — and what
 * survives the refresh that is everybody's reflex when a live feed looks stuck.
 * `replaceState` for the filter and the search, because a back button that walks
 * backwards through every keystroke is not a back button.
 *
 * The scope is the same argument one step on: "the actors in *this* feed" and "every
 * actor being tracked" are two different screens under one tab name, and a link that
 * cannot say which of them you meant is a link to the wrong one half the time.
 */
function syncUrl(replace = true): void {
  // Embedded, the URL belongs to the page around us. Writing a tab into it rewrites
  // somebody else's address bar and puts a history entry between them and wherever they
  // were going.
  if (isEmbedded()) return;
  const params = new URLSearchParams();
  if (state.filter !== "all") params.set("f", state.filter);
  if (state.search !== "") params.set("q", state.search);
  if (state.actorScope !== "tracked") params.set("a", state.actorScope);
  if (state.actorsQuery !== "") params.set("aq", state.actorsQuery);
  const query = params.toString();
  const hash = `#${state.tab}${query === "" ? "" : `?${query}`}`;
  if (location.hash === hash) return;
  history[replace ? "replaceState" : "pushState"]({ tab: state.tab }, "", hash);
}

function readUrl(): { tab: TabName; filter: FilterName; search: string; actorScope: "tracked" | "feed"; actorsQuery: string } {
  // And it is not ours to read either: a host page using hash routing would otherwise
  // decide which tab this opens on.
  const embedded = isEmbedded();
  const raw = embedded ? "" : location.hash.slice(1);
  const split = raw.indexOf("?");
  const name = split === -1 ? raw : raw.slice(0, split);
  const params = new URLSearchParams(split === -1 ? "" : raw.slice(split + 1));
  // Embedded, the element's `view` stands in for the URL this page does not have. It is
  // read here rather than applied afterwards so that the first frame is already the view
  // that was asked for — applied later, the page would draw everything and then narrow,
  // which on a busy feed is a visible flash of somebody else's traffic.
  const view = embedded ? (BOOT.view ?? {}) : {};
  const filter = params.get("f") ?? view.filter ?? "all";
  const tab = split === -1 && raw === "" ? (view.tab ?? "") : name;
  return {
    tab: isTab(tab) ? tab : FIRST,
    filter: filter as FilterName,
    search: params.get("q") ?? view.search ?? "",
    // Anything but the one alternative reads as the default rather than as an error:
    // a hand-edited URL should land somewhere, and this is the somewhere it lands.
    actorScope: (params.get("a") ?? view.actorScope) === "feed" ? "feed" : "tracked",
    actorsQuery: params.get("aq") ?? view.actorsQuery ?? "",
  };
}

function showTab(name: TabName, options: { focus?: boolean; replace?: boolean; push?: boolean } = {}): void {
  const target = isTab(name) ? name : FIRST;
  state.tab = target;
  for (const [id, tab, enabled] of TABS) {
    const selected = tab === target;
    const node = $(id);
    node.hidden = !enabled;
    node.setAttribute("aria-selected", String(selected));
    // Roving tabindex: the selected tab is the strip's single stop in the tab order.
    node.tabIndex = selected ? 0 : -1;
    $(`view-${tab}`).hidden = !selected || !enabled;
  }
  if (options.focus === true) $(available[tabIndexOf(target)]?.[0] ?? "tab-live").focus();
  if (target === "policy" && state.policy === undefined) {
    void loadPolicy();
    void loadRanges();
  }
  // The Actors screen is fetched rather than streamed, and polled only while it is the
  // screen somebody is looking at.
  trackActors();
  if (options.push !== false) syncUrl(options.replace !== false);
  drawNow();
}

function initTabs(): void {
  available.forEach(([id, name], index) => {
    const tab = $(id);
    tab.addEventListener("click", () => showTab(name, { replace: false }));
    tab.addEventListener("keydown", (event) => {
      let next = -1;
      if (event.key === "ArrowRight") next = (index + 1) % available.length;
      else if (event.key === "ArrowLeft") next = (index - 1 + available.length) % available.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = available.length - 1;
      if (next === -1) return;
      event.preventDefault();
      showTab(available[next]?.[1] ?? FIRST, { focus: true, replace: false });
    });
  });

  if (isEmbedded()) return;
  addEventListener("popstate", () => {
    const url = readUrl();
    state.filter = url.filter;
    setSearch(url.search);
    reflectFilterButtons();
    applyActorScope(url.actorScope);
    applyActorsQuery(url.actorsQuery);
    showTab(url.tab, { push: false });
  });
}

// ---- keyboard ---------------------------------------------------------------

function initKeyboard(): void {
  // Scoped to this dashboard when embedded: a digit pressed while the host page has
  // focus switched a tab in here, which is somebody else's keyboard being taken.
  eventTarget().addEventListener("keydown", ((event: KeyboardEvent) => {
    const target = event.target as HTMLElement | null;
    const typing = target !== null && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT");

    if (event.key === "Escape") {
      if (typing && target?.id === "search" && (target as HTMLInputElement).value !== "") {
        (target as HTMLInputElement).value = "";
        setSearch("");
        syncUrl();
        drawNow();
        return;
      }
      if (typing) {
        target?.blur();
        return;
      }
      // Otherwise close whatever is open, innermost first.
      if (state.actor !== undefined) {
        state.actor = undefined;
        drawNow();
        return;
      }
      if (state.open.size > 0) {
        state.open.clear();
        drawNow();
      }
      return;
    }

    if (typing || event.metaKey || event.ctrlKey || event.altKey) return;

    if (event.key === "/" && SECTIONS.feed) {
      event.preventDefault();
      showTab("live");
      const search = byId<HTMLInputElement>("search");
      search.focus();
      search.select();
      return;
    }
    // 1-2-3-4 for the views, the way every tabbed console does it. They index the tabs
    // this listener actually has, so a dashboard with two of them has two shortcuts.
    const digit = ["1", "2", "3", "4"].indexOf(event.key);
    if (digit !== -1 && digit < available.length) {
      event.preventDefault();
      showTab(available[digit]?.[1] ?? FIRST, { focus: true, replace: false });
    }
  }) as EventListener);
}

// ---- the two range controls --------------------------------------------------

function initRanges(): void {
  const ranges: Array<[string, number]> = [
    ["1m", 60_000],
    ["5m", 300_000],
    ["15m", 900_000],
    ["1h", 3_600_000],
  ];
  const host = $("traffic-range");
  for (const [label, value] of ranges) {
    const button = el("button", null, label);
    button.setAttribute("aria-pressed", String(value === state.rangeMs));
    button.addEventListener("click", () => {
      state.rangeMs = value;
      for (const other of Array.from(host.children)) other.setAttribute("aria-pressed", "false");
      button.setAttribute("aria-pressed", "true");
      drawTraffic();
    });
    host.appendChild(button);
  }

  const scopes: Array<[string, "run" | "window"]> = [
    ["since start", "run"],
    ["this window", "window"],
  ];
  const scopeHost = $("score-scope");
  for (const [label, value] of scopes) {
    const button = el("button", null, label);
    button.setAttribute("aria-pressed", String(value === state.scoreScope));
    button.addEventListener("click", () => {
      state.scoreScope = value;
      for (const other of Array.from(scopeHost.children)) other.setAttribute("aria-pressed", "false");
      button.setAttribute("aria-pressed", "true");
      drawScores();
    });
    scopeHost.appendChild(button);
  }
}

// ---- draw --------------------------------------------------------------------

let pending = false;

function schedule(): void {
  if (state.paused || pending) return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    draw();
  });
}

/**
 * Draws the view that is on screen, and nothing else.
 *
 * It used to draw all three. Every incoming request rebuilt eight statistics bar
 * panels into a hidden tab, on top of rebuilding three hundred feed rows — which is
 * work nobody could see, done at the frame rate, on the one screen where the work that
 * can be seen matters most.
 */
function draw(): void {
  drawChips();
  drawTiles();
  drawNoticeBadge();
  updateWindowLabels();

  if (state.tab === "live") {
    drawActor();
    drawFeed();
    drawLivePanels();
  } else if (state.tab === "actors") {
    drawActors();
  } else if (state.tab === "stats") {
    drawTraffic();
    drawLatency();
    drawScores();
    drawStatsPanels();
    if (SECTIONS.audit) drawAudit();
  } else {
    drawPolicyTab();
    if (SECTIONS.notices) drawNotices();
    if (SECTIONS.changes) drawChanges();
  }
}

function drawNow(): void {
  draw();
}

// ---- start -------------------------------------------------------------------

function applySections(): void {
  // A section that is off is removed from the document rather than hidden, so nothing
  // can tab into it and no panel is left waiting for data that will never arrive.
  const gated: Array<[string, boolean]> = [
    ["tiles", SECTIONS.statistics],
    ["tester-panel", SECTIONS.tester],
    ["ranges-panel", SECTIONS.ranges],
    ["changes-panel", SECTIONS.changes],
    ["actor-panel", SECTIONS.actors],
    ["live-actors-panel", SECTIONS.actors],
    ["audit-panel", SECTIONS.audit],
    ["audit-checks-panel", SECTIONS.audit],
    ["notices-panel", SECTIONS.notices],
    ["guard-panel", SECTIONS.guard],
    ["robots-panel", SECTIONS.robots],
    ["identities-panel", SECTIONS.actors],
    ["evidence-legend", SECTIONS.evidence],
  ];
  for (const [id, enabled] of gated) {
    const node = rootNode().querySelector<HTMLElement>(`#${id}`);
    if (node !== null && !enabled) node.remove();
  }
}

function start(): void {
  app.draw = schedule;
  app.drawNow = drawNow;
  app.showTab = showTab;
  app.syncUrl = (options) => syncUrl(options?.replace !== false);

  applySections();
  initHeader();
  drawPeers();
  initTabs();
  initSkipLink();
  initKeyboard();
  initRanges();
  if (SECTIONS.feed) initFeed();
  initActor();
  initActorScope();
  initActorsSearch();
  initTester();
  initPolicy();

  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  addEventListener("resize", () => {
    if (resizeTimer !== undefined) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (state.tab === "stats") {
        drawTraffic();
        drawLatency();
        drawScores();
      }
    }, 120);
  });

  // Open on whatever view the URL names, so a link to #policy lands there and a refresh
  // keeps your place — filter and search included. replace:true so the first entry does
  // not add a step the back button has to walk through on the way out.
  const url = readUrl();
  state.filter = url.filter;
  setSearch(url.search);
  if (SECTIONS.feed) reflectFilterButtons();
  applyActorScope(url.actorScope);
  applyActorsQuery(url.actorsQuery);
  showTab(url.tab, { replace: true });

  suspendScrollAnchoring();
  // Settled when the snapshot that draws the counters has actually been rendered, rather
  // than a couple of frames after start-up. The counters are the tallest thing script puts
  // above the feed and they wait on a round trip, so a frame count was measuring the wrong
  // thing and the page still opened scrolled.
  void loadInitialSnapshot().finally(settleScrollAnchoring);
  connectStream();
}

/**
 * Lets the page finish drawing itself before the browser starts defending the scroll
 * position.
 *
 * The counters, the filter chips and the pager are all built by script after the document
 * has laid out, which inserts a few hundred pixels above the feed. Scroll anchoring reads
 * that as "content appeared above what you were looking at" and scrolls down by the same
 * amount to compensate — so on a window narrow enough for the counter row to wrap, the
 * dashboard opened with its own counters already off the top of the screen.
 *
 * Off for the first render, then back on, rather than off for good: the feed puts new
 * requests at the *top*, and anchoring is what keeps somebody's place while they read a
 * list that is growing above them.
 */
function htmlElement(): HTMLElement | undefined {
  const root = rootNode();
  return root instanceof Document ? root.documentElement : undefined;
}

function suspendScrollAnchoring(): void {
  htmlElement()?.classList.add("settling");
}

function settleScrollAnchoring(): void {
  const html = htmlElement();
  if (html === undefined) return;
  // Two frames after the snapshot: its own render, and the layout that follows. A third
  // was measured and changed nothing. What remains is about fifteen pixels on a narrow
  // window — the counters are fully clear of the header, which is what mattered.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      html.classList.remove("settling");
    });
  });
}

start();
