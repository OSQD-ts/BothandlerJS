import { $, byId, clear, el } from "./dom.js";
import { SECTIONS } from "./boot.js";
import { actorActions, isConfirming } from "./actions.js";
import { matchesActor, parseActorFilter } from "../actor-filter.js";
import { app } from "./app.js";
import { clockStamp, n } from "./format.js";
import { getJson } from "./api.js";
import { labelOf, matchingRows, setSearch, state } from "./store.js";
import { renderPager } from "./pager.js";
import type { ActorRow } from "./types.js";

/**
 * The Actors screen.
 *
 * The feed is a ring of *requests* — five hundred of them, which on a busy origin is a
 * few seconds. The registry is a bounded map of *clients*, up to twenty thousand of
 * them, each carrying the rate series, path breadth and confirmation count that
 * `cadence`, `crawl-breadth` and `rate-anomaly` are reading. Until this screen existed
 * the page could only show you the actors that happened to appear in the last few
 * hundred requests, which is a different and much smaller question than "who is hitting
 * me hardest right now".
 *
 * It is fetched rather than streamed, and refreshed while it is the visible tab.
 * Streaming twenty thousand actors to every viewer to keep a sorted list of fifty
 * fresh would be a great deal of traffic to answer a question nobody asks continuously.
 */

interface ActorsBody {
  actors: ActorRow[];
  tracked: number;
  /** How many matched the query, for the pager. Absent from a handler older than it. */
  matching?: number;
  actionable: boolean;
}

let timer: ReturnType<typeof setInterval> | undefined;

export async function loadActors(): Promise<void> {
  if (!SECTIONS.registry) return;
  try {
    // The query goes with it. The list is paged on the server, so filtering it here would
    // filter the page rather than the registry.
    const query = state.actorsQuery.trim() === "" ? "" : `&q=${encodeURIComponent(state.actorsQuery)}`;
    const body = await getJson<ActorsBody>(`/api/actors?limit=${state.actorsPageSize}&offset=${state.actorsPage * state.actorsPageSize}${query}`);
    state.actors = body.actors;
    state.actorsTracked = body.tracked;
    state.actorsMatching = body.matching ?? body.tracked;
    drawActors();
  } catch {
    /* the rest of the page is unaffected */
  }
}

/** Polls while the screen is showing, and stops the moment it is not. */
export function trackActors(): void {
  if (timer !== undefined) clearInterval(timer);
  timer = undefined;
  if (state.tab !== "actors") return;
  void loadActors();
  timer = setInterval(() => {
    if (state.tab !== "actors" || state.paused || isConfirming()) return;
    // The feed's actors are derived from rows the page already has, and the draw loop
    // redraws them. Fetching the registry to render a list that does not come from it
    // would be a request every four seconds for nothing.
    if (state.actorScope === "feed") return;
    void loadActors();
  }, 4000);
}

/** Page sizes the Actors table offers. The endpoint will not serve more than 200 at once. */
const ACTORS_PAGE_SIZES = [25, 50, 100, 200] as const;

/**
 * The pager, above the table and below it.
 *
 * Paged on the server by offset, because the registry holds far more clients than the
 * feed's ring holds requests — `maxActors` of them — and the point of this screen is the
 * population the feed cannot show. Without paging the dashboard could only ever see the
 * busiest handful.
 *
 * The end of the list is "a short page came back". There is no count of how many rank
 * below the current page that is cheaper than asking for it, and asking in order to grey
 * out a button is not worth a request.
 */
function drawActorsPager(shown: number, fromFeed: boolean): void {
  const page = state.actorsPage;
  const size = state.actorsPageSize;
  const matching = state.actorsMatching;
  const hidden = page === 0 && shown >= matching;
  const from = page * size + 1;
  // Both lists page the same way now. The feed-derived one is sliced here — it is a list
  // this page built — and the registry is sliced on the server; the difference is a
  // reload or a redraw, which is what `go` and `set` decide between.
  const turn = (): void => {
    if (fromFeed) app.drawNow();
    else void loadActors();
  };
  const model = {
    page,
    from,
    to: from + shown - 1,
    total: matching,
    atStart: page === 0,
    atEnd: (page + 1) * size >= matching,
    go: (next: number): void => {
      state.actorsPage = Math.max(0, next);
      turn();
    },
    size: {
      current: size,
      choices: ACTORS_PAGE_SIZES,
      set: (next: number): void => {
        state.actorsPageSize = next;
        state.actorsPage = 0;
        turn();
      },
    },
  };
  for (const [id, withSize] of [
    ["actors-pager-top", true],
    ["actors-pager", false],
  ] as const) {
    const host = $(id);
    host.hidden = hidden;
    if (hidden) clear(host);
    else renderPager(host, model, { withSize });
  }
}

/**
 * The actors visible in the feed you are looking at.
 *
 * The registry answers "who is hitting me hardest", which is a different question from
 * "who is in *this*" — and once a filter is on, the second one is usually what somebody
 * has in mind. Derived from the rows the feed is already showing, so it narrows with the
 * filter, the timeframe and the search without another request.
 *
 * Three columns are left blank on purpose. `Per min`, `Cadence` and `Unsolved` are
 * properties of the whole actor as the engine sees it, and the feed's ring holds a few
 * hundred requests rather than a client's history — computing them from that slice would
 * put a confident number under a heading that means something else. A dash says "ask the
 * registry", which is the button next to it.
 */
export function feedActors(): ActorRow[] {
  const byKey = new Map<string, { rows: number; paths: Set<string>; agents: Set<string>; first: number; last: number; stats?: { requests: number; distinctPaths: number; priorConfirmations: number; cleared: boolean; firstSeen: number } | undefined }>();
  for (const row of matchingRows()) {
    const entry = row.entry;
    let seen = byKey.get(entry.actor);
    if (seen === undefined) {
      seen = { rows: 0, paths: new Set(), agents: new Set(), first: entry.at, last: entry.at };
      byKey.set(entry.actor, seen);
    }
    seen.rows++;
    seen.paths.add(entry.path);
    seen.agents.add(entry.userAgent);
    if (entry.at < seen.first) seen.first = entry.at;
    if (entry.at > seen.last) seen.last = entry.at;
    // The newest row's snapshot is the closest thing the feed has to the engine's view.
    seen.stats = entry.actorStats ?? seen.stats;
  }

  // A feed entry does not carry the actor's label, so it comes from the names every stats
  // frame delivers — complete, unlike the registry list, which is paged and so knew a name
  // only for actors that happened to be on the page last fetched.
  const labels = state.labels;
  const out: ActorRow[] = [];
  for (const [key, seen] of byKey) {
    const label = labels.get(key);
    out.push({
      key,
      ...(label === undefined ? {} : { label }),
      requests: seen.rows,
      recentRate: Number.NaN,
      distinctPaths: seen.paths.size,
      distinctUserAgents: seen.agents.size,
      cadenceCv: undefined,
      // A dash where the feed cannot know, like the three columns below it. A confident
      // zero under a heading that means "how many times has this client been proven a bot"
      // is worse than an admission, and it was the only column here still guessing.
      priorConfirmations: seen.stats?.priorConfirmations ?? Number.NaN,
      unsolvedChallenges: Number.NaN,
      cleared: seen.stats?.cleared ?? false,
      firstSeen: seen.stats?.firstSeen ?? seen.first,
      lastSeen: seen.last,
    });
  }
  // Busiest first, like the registry, so the two lists read the same way.
  return out.sort((a, b) => b.requests - a.requests);
}

/**
 * Moves the toggle to `scope` and redraws, without touching the URL.
 *
 * Separate from the click handler because the URL is also an input: opening a link and
 * pressing Back both arrive here, and neither should write the address they just read.
 */
export function applyActorScope(scope: "tracked" | "feed"): void {
  if (!SECTIONS.registry) return;
  state.actorScope = scope;
  for (const [id, on] of [
    ["actors-scope-tracked", scope === "tracked"],
    ["actors-scope-feed", scope === "feed"],
  ] as const) {
    byId<HTMLButtonElement>(id).className = on ? "on" : "";
    byId<HTMLButtonElement>(id).setAttribute("aria-pressed", String(on));
  }
  drawActors();
}

/** Wires the tracked/shown toggle. Called once. */
export function initActorScope(): void {
  if (!SECTIONS.registry) return;
  const choose = (scope: "tracked" | "feed"): void => {
    applyActorScope(scope);
    // Pushed rather than replaced: this is a deliberate switch between two screens, the
    // same shape of act as clicking a tab, and the back button should undo it.
    app.syncUrl({ replace: false });
  };
  $("actors-scope-tracked").addEventListener("click", () => choose("tracked"));
  $("actors-scope-feed").addEventListener("click", () => choose("feed"));
}

/**
 * The Actors screen's own filter box. Called once.
 *
 * The same language as the feed's, over actors — see `actor-filter.ts`. Typing redraws the
 * feed-derived list at once, because that list is already here; for the tracked list it
 * waits a moment first, because that one is a request, and a request per keystroke against
 * a registry of twenty thousand is a denial of service somebody typed by accident.
 */
export function initActorsSearch(): void {
  if (!SECTIONS.registry) return;
  const input = byId<HTMLInputElement>("actors-search");
  input.value = state.actorsQuery;
  let pending: ReturnType<typeof setTimeout> | undefined;
  input.addEventListener("input", () => {
    state.actorsQuery = input.value;
    // Any change to what matches goes back to the first page: page four of a narrower
    // list is somebody reading rows their filter no longer selects, or nothing at all.
    state.actorsPage = 0;
    app.syncUrl();
    if (state.actorScope === "feed") {
      app.drawNow();
      return;
    }
    if (pending !== undefined) clearTimeout(pending);
    pending = setTimeout(() => void loadActors(), 250);
  });
}

/** Puts a query into the box and applies it, for the URL and the back button. */
export function applyActorsQuery(query: string): void {
  if (!SECTIONS.registry) return;
  state.actorsQuery = query;
  state.actorsPage = 0;
  byId<HTMLInputElement>("actors-search").value = query;
}

export function drawActors(): void {
  if (!SECTIONS.registry) return;
  // A repaint replaces every button in the table, including a confirmation somebody is
  // halfway through. The list holds still while they decide.
  if (isConfirming()) return;
  const body = byId<HTMLTableSectionElement>("actor-rows");
  clear(body);

  const fromFeed = state.actorScope === "feed";
  const query = state.actorsQuery.trim();
  let actors: ActorRow[];
  if (fromFeed) {
    // Filtered and paged here, because this list is built from rows the page already has.
    const all = query === "" ? feedActors() : feedActors().filter((actor) => matchesActor(parseActorFilter(query), actor));
    state.actorsMatching = all.length;
    const size = state.actorsPageSize;
    // A page that no longer exists — the feed moved on under a deep page — lands on the
    // last one that does rather than on nothing at all.
    if (state.actorsPage * size >= all.length) state.actorsPage = Math.max(0, Math.ceil(all.length / size) - 1);
    actors = all.slice(state.actorsPage * size, state.actorsPage * size + size);
  } else {
    actors = state.actors;
  }

  const population = fromFeed ? "in the feed you are looking at" : "tracked";
  $("actors-count").textContent =
    query === ""
      ? `${n(state.actorsMatching)} ${population}`
      : `${n(state.actorsMatching)} matching · ${n(fromFeed ? state.actorsMatching : state.actorsTracked)} ${fromFeed ? population : "tracked"}`;
  drawActorsPager(actors.length, fromFeed);
  byId<HTMLElement>("actors-empty").hidden = actors.length > 0;

  for (const actor of actors) {
    const row = el("tr");
    // The label first when there is one, with the key beneath it: somebody who named this
    // actor did so because the key was not the useful part.
    const who = el("td", "who");
    // The page's own names first: they arrive complete on every stats frame, and they
    // reflect a name given a moment ago rather than the one this list was fetched with.
    const name = labelOf(actor.key) ?? actor.label;
    if (name === undefined) who.textContent = actor.key;
    else {
      who.appendChild(el("div", "label", name));
      who.appendChild(el("div", "sub", actor.key));
      // What the label switches, said where the name is. An actor that is hidden from the
      // feed or not analysed at all looks exactly like any other row here otherwise, and
      // this is the screen somebody comes to when they are wondering where it went.
      const switches = state.labelSwitches.get(actor.key);
      const tags = [switches?.hide === true ? "hidden from feed" : "", switches?.skip === true ? "not analysed" : ""].filter((tag) => tag !== "");
      if (tags.length > 0) who.appendChild(el("div", "tagline", tags.join(" · ")));
    }
    row.appendChild(who);
    row.appendChild(el("td", "num tnum", n(actor.requests)));
    row.appendChild(el("td", "num tnum", Number.isNaN(actor.recentRate) ? "—" : n(actor.recentRate)));
    row.appendChild(el("td", "num tnum", n(actor.distinctPaths)));

    // The coefficient of variation of the gaps between requests. Near zero is a
    // metronome, which no person is; a dash is "too few gaps to say", which is not the
    // same as regular and must not look like it.
    const cadence = el("td", "num tnum", actor.cadenceCv === undefined ? "—" : actor.cadenceCv.toFixed(2));
    if (actor.cadenceCv !== undefined && actor.cadenceCv < 0.15) cadence.className += " warn-text";
    row.appendChild(cadence);

    row.appendChild(el("td", "num tnum", Number.isNaN(actor.priorConfirmations) ? "—" : n(actor.priorConfirmations)));

    // Outstanding challenges. Amber past two, because one abandoned challenge is a
    // person having a moment and three is a client that does not answer.
    const unsolved = el("td", "num tnum", Number.isNaN(actor.unsolvedChallenges) ? "—" : n(actor.unsolvedChallenges));
    if (actor.unsolvedChallenges >= 3) unsolved.className += " warn-text";
    row.appendChild(unsolved);

    const stateCell = el("td");
    const tags: string[] = [];
    if (actor.cleared) tags.push("cleared as human");
    if (actor.distinctUserAgents > 1) tags.push(`${actor.distinctUserAgents} User-Agents`);
    tags.push(`first seen ${clockStamp(actor.firstSeen)}`);
    stateCell.appendChild(el("div", "tagline", tags.join(" · ")));
    row.appendChild(stateCell);

    const actions = el("td", "acts");
    const inFeed = el("button", null, "In feed");
    inFeed.title = "Show this actor's requests in the live feed";
    inFeed.addEventListener("click", () => {
      // Reuses the feed's own search rather than a second mechanism, which means the
      // result is a shareable URL like every other view of the feed.
      setSearch(`actor:${actor.key}`);
      const search = byId<HTMLInputElement>("search");
      search.value = state.search;
      app.showTab("live");
      app.syncUrl();
    });
    actions.appendChild(inFeed);
    for (const button of actorActions(actor.key, () => void loadActors(), labelOf(actor.key) ?? actor.label)) actions.appendChild(button);
    row.appendChild(actions);

    body.appendChild(row);
  }
}
