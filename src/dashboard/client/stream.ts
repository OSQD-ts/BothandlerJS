import { $ } from "./dom.js";
import { API, SECTIONS } from "./boot.js";
import { app } from "./app.js";
import { clearFeed, ingest, state, takeLabels } from "./store.js";
import { getJson } from "./api.js";
import { resetFeedCache } from "./feed.js";
import type { DashboardEntry, Snapshot } from "./types.js";

/**
 * The event stream.
 *
 * `EventSource` reconnects on its own and resends the last `id:` it saw as
 * `Last-Event-ID`, so the server can answer a reconnect with the handful of frames
 * that were missed instead of the whole ring — five hundred entries with their
 * headers, evidence and actor history attached, every time a laptop lid closes. The
 * page's side of that bargain is this: nothing here tracks the cursor, because the
 * browser already does, and a second copy would be the one that is wrong.
 */
/**
 * The open connection, so it can be closed again.
 *
 * It used to be a local, which meant nothing could stop it. Embedded in somebody's page
 * that mattered: removing the element left the stream open and the client drawing into a
 * detached tree for the life of the page — one held server connection and a steady trickle
 * of work for a dashboard nobody was looking at.
 */
let source: EventSource | undefined;

/**
 * Closes the stream, keeping everything the page has drawn.
 *
 * Reconnecting resumes from where this left off: the server is told the last id seen and
 * sends only what was missed, so suspending across a route change costs a reconnect rather
 * than a reload.
 */
export function suspendStream(): void {
  source?.close();
  source = undefined;
}

export function connectStream(): void {
  if (!SECTIONS.feed) {
    $("dot").className = "dot";
    $("conn").textContent = "feed off";
    return;
  }
  if (source !== undefined) return;

  source = new EventSource(`${API}/api/stream`);

  source.addEventListener("open", () => {
    $("dot").className = "dot on";
    $("conn").textContent = "live";
  });

  // A full backlog is on its way and it replaces what the page holds. Sent when the
  // server cannot honour the cursor — a restarted process, a cleared feed, or a gap
  // longer than the ring — so keeping the old rows would mean showing requests
  // nothing will ever correct.
  source.addEventListener("sync", (event) => {
    const detail = JSON.parse((event as MessageEvent<string>).data) as { replace: boolean };
    if (!detail.replace) return;
    clearFeed();
    resetFeedCache();
  });

  source.addEventListener("entry", (event) => {
    ingest(JSON.parse((event as MessageEvent<string>).data) as DashboardEntry);
    if (state.paused) {
      // Paused means the page stops redrawing, so the only thing that may move is the
      // button that says how much you are not being shown.
      state.bufferedWhilePaused++;
      $("pause").textContent = `Resume (${state.bufferedWhilePaused})`;
    }
    app.draw();
  });

  source.addEventListener("update", (event) => {
    ingest(JSON.parse((event as MessageEvent<string>).data) as DashboardEntry);
    app.draw();
  });

  // Somebody pressed Reset — possibly in another browser. Without this a second viewer
  // goes on showing a feed of requests the server has forgotten.
  source.addEventListener("reset", () => {
    clearFeed();
    resetFeedCache();
    app.draw();
  });

  // The server could not keep up with this connection and skipped part of the feed
  // rather than queueing it in its own memory. Said out loud: a gap the viewer knows
  // about is a different thing from one it does not.
  source.addEventListener("lagged", (event) => {
    const detail = JSON.parse((event as MessageEvent<string>).data) as { dropped: number };
    state.laggedDrops += detail.dropped;
    app.draw();
  });

  source.addEventListener("stats", (event) => {
    state.snapshot = JSON.parse((event as MessageEvent<string>).data) as Snapshot;
    takeLabels(state.snapshot.labels, state.snapshot.labelSwitches);
    app.draw();
  });

  source.addEventListener("error", () => {
    $("dot").className = "dot off";
    $("conn").textContent = "reconnecting…";
    // EventSource reconnects on its own; this only reports it. A stream closed by the
    // server on shutdown ends up here too, which is why the dot matters.
  });
}

/**
 * A first fetch, so the page has counters before the stream opens — and so a browser
 * with `EventSource` blocked still shows something useful.
 */
export async function loadInitialSnapshot(): Promise<void> {
  try {
    state.snapshot = await getJson<Snapshot>("/api/stats");
    takeLabels(state.snapshot.labels, state.snapshot.labelSwitches);
    app.drawNow();
  } catch {
    /* the stream is the primary path */
  }
}
