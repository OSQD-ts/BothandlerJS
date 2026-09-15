import type { DashboardEntry, DashboardSections, DashboardSnapshot, PolicyDocument, PolicyPreview } from "../types.js";

export type { DashboardChange, DashboardEntry, DashboardEvidence, DashboardNotice, DashboardSections, DashboardSnapshot, PolicyDocument, PolicyPreview } from "../types.js";

/** What the server stamps into the page for the client to read at start-up. */
export interface Boot {
  /** The mount prefix, or `""` at the root. Every request the page makes is relative to it. */
  base: string;
  title: string;
  allowReset: boolean;
  allowEdit: boolean;
  allowGuardEdit: boolean;
  allowActing: boolean;
  allowChallengeEdit: boolean;
  peers: ReadonlyArray<{ label: string; href: string }>;
  sections: Required<DashboardSections>;
  links: ReadonlyArray<{ label: string; href: string }>;
  /**
   * Which screen to open on, and with what already filtered.
   *
   * Only ever set by the embedded element. A served page takes this from its own URL, so
   * that a view somebody arrived at is a link they can send; an embedded one has no URL
   * of its own — the address bar belongs to the host page and the client deliberately
   * will not write to it — and so had no way to be opened anywhere but the first tab
   * showing everything. An embedder that mounts the dashboard next to one customer's
   * account had to tell people to type the filter in themselves.
   *
   * The starting point only. Everything here is what somebody would have typed, so
   * everything here can be typed over, and nothing re-applies it on a later frame.
   */
  view?: { tab?: string; filter?: string; search?: string; actorScope?: string; actorsQuery?: string };
}

/**
 * One feed entry, plus what the page knows about it that the server does not.
 *
 * A wrapper rather than extra fields on the entry, for two reasons. The entry is a
 * copy of what the server sent and anything added to it would end up in a replay line
 * or a corpus case; and `rev` has to survive being compared against a rendered row,
 * which is a question about this page rather than about the request.
 */
export interface Row {
  entry: DashboardEntry;
  /**
   * Bumped whenever the entry changes, which is how the feed knows a rendered row is
   * stale. A request is written twice — once when it is assessed, again when the
   * decision lands — and only the second write should cost a rebuild.
   */
  rev: number;
  /** The searchable text, built on demand and thrown away when the entry changes. */
  text?: string | undefined;
}

/** The views, in the order the tab strip and the digit shortcuts use. */
export type TabName = "live" | "actors" | "stats" | "policy" | "challenge" | "reference";

export interface Preview extends PolicyPreview {}
export interface Policy extends PolicyDocument {}
export interface Snapshot extends DashboardSnapshot {}

/**
 * One row of the Actors screen.
 *
 * Here rather than in `registry.ts`, which renders it: this is plain data, and the store
 * holds a list of it. A pure module importing a type from a module that speaks DOM pulls
 * that module into every program the pure one appears in — which is how a Node-side test
 * of the store came to fail on `HTMLInputElement`.
 */
export interface ActorRow {
  /** A name somebody gave this actor. Never read by detection. */
  label?: string | undefined;
  key: string;
  requests: number;
  recentRate: number;
  distinctPaths: number;
  distinctUserAgents: number;
  cadenceCv: number | undefined;
  priorConfirmations: number;
  unsolvedChallenges: number;
  cleared: boolean;
  firstSeen: number;
  lastSeen: number;
}

/**
 * How many requests happened in the window on screen, as opposed to how many are on it.
 *
 * The feed's header used to read "last 693 requests · 141h". Both halves were true and
 * together they said something false: 693 was the number of entries this browser was
 * holding, and 141h was how far back the oldest of them went, so the sentence invited the
 * reader to conclude that 693 requests had arrived in 141 hours. On a busy origin the ring
 * evicts constantly and the real number is orders of magnitude larger.
 *
 * The server counts requests in minute buckets, apart from the entries and outliving them,
 * so the total for a window is a fact it can state whether or not it still has the
 * requests behind it. This module is what asks.
 *
 * ## What is knowable, and what is not
 *
 * Two different numbers, and keeping them apart is the whole point:
 *
 * - **How many requests fell in the window.** Always knowable, always exact, straight from
 *   the counters. This is the number the header leads with.
 * - **How many of them match the query box.** Only knowable over entries this page is
 *   holding, because the feed's query language runs here and the server has never seen it.
 *
 * So a filtered count is reported as what it is — a count over what has been loaded — and
 * never quietly presented as a count over the window. The alternative is a page that
 * confidently reports "12 matching" when it means "12 of the 400 I happen to have".
 */
export interface WindowCount {
  /** Requests in the window, from the server's counters. Exact. */
  matching: number;
  /** How many of those the server still holds entries for. */
  retained: number;
  /** The earliest instant the counters can speak for. Before it, nothing is known. */
  countsFrom: number | undefined;
  /** How long the server is holding entries, so the page can say so and cache to match. */
  retentionMs: number;
  /** When this answer was taken. */
  at: number;
}
