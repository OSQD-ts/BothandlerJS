import { $, byId, clear, el } from "./dom.js";
import { SECTIONS } from "./boot.js";
import { actorActions, isConfirming } from "./actions.js";
import { app } from "./app.js";
import { clockStamp, n } from "./format.js";
import { getJson } from "./api.js";
import { setSearch, state } from "./store.js";
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
  actionable: boolean;
}

let timer: ReturnType<typeof setInterval> | undefined;

export async function loadActors(): Promise<void> {
  if (!SECTIONS.registry) return;
  try {
    const body = await getJson<ActorsBody>(`/api/actors?limit=${state.actorsPageSize}&offset=${state.actorsPage * state.actorsPageSize}`);
    state.actors = body.actors;
    state.actorsTracked = body.tracked;
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
function drawActorsPager(full: boolean): void {
  const page = state.actorsPage;
  const hidden = page === 0 && !full;
  const from = page * state.actorsPageSize + 1;
  const model = {
    page,
    from,
    to: from + state.actors.length - 1,
    total: state.actorsTracked,
    atStart: page === 0,
    atEnd: !full,
    go: (next: number): void => {
      state.actorsPage = Math.max(0, next);
      void loadActors();
    },
    size: {
      current: state.actorsPageSize,
      choices: ACTORS_PAGE_SIZES,
      set: (next: number): void => {
        state.actorsPageSize = next;
        state.actorsPage = 0;
        void loadActors();
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

export function drawActors(): void {
  if (!SECTIONS.registry) return;
  // A repaint replaces every button in the table, including a confirmation somebody is
  // halfway through. The list holds still while they decide.
  if (isConfirming()) return;
  const body = byId<HTMLTableSectionElement>("actor-rows");
  clear(body);

  const actors = state.actors;
  $("actors-count").textContent = `${n(actors.length)} shown · ${n(state.actorsTracked)} tracked`;
  drawActorsPager(actors.length === state.actorsPageSize);
  byId<HTMLElement>("actors-empty").hidden = actors.length > 0;

  for (const actor of actors) {
    const row = el("tr");
    row.appendChild(el("td", "who", actor.key));
    row.appendChild(el("td", "num tnum", n(actor.requests)));
    row.appendChild(el("td", "num tnum", n(actor.recentRate)));
    row.appendChild(el("td", "num tnum", n(actor.distinctPaths)));

    // The coefficient of variation of the gaps between requests. Near zero is a
    // metronome, which no person is; a dash is "too few gaps to say", which is not the
    // same as regular and must not look like it.
    const cadence = el("td", "num tnum", actor.cadenceCv === undefined ? "—" : actor.cadenceCv.toFixed(2));
    if (actor.cadenceCv !== undefined && actor.cadenceCv < 0.15) cadence.className += " warn-text";
    row.appendChild(cadence);

    row.appendChild(el("td", "num tnum", n(actor.priorConfirmations)));

    // Outstanding challenges. Amber past two, because one abandoned challenge is a
    // person having a moment and three is a client that does not answer.
    const unsolved = el("td", "num tnum", n(actor.unsolvedChallenges));
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
    for (const button of actorActions(actor.key, () => void loadActors())) actions.appendChild(button);
    row.appendChild(actions);

    body.appendChild(row);
  }
}
