/**
 * Which parts of the dashboard exist, as plain booleans and nothing else.
 *
 * Its own module because it is the one dashboard type the browser half needs: the
 * embeddable element's `hide` option is this shape, so this file ends up in the published
 * `.d.ts` that a front-end application reads. `types.ts` imports `node:http` — it has to,
 * it describes a request handler — and a browser project that type-checks its dependencies
 * strictly would have been asked to install `@types/node` to configure which panels it
 * shows. Nothing here refers to anything outside itself, so nothing follows it in.
 */

/**
 * Which parts of the dashboard exist on this listener.
 *
 * Everything defaults to on, and turning something off removes it from the page *and*
 * from the server: the tab is gone, the panel is gone, the endpoint behind it answers
 * 403, and fields a switched-off section would have shown are dropped before the data
 * leaves the process. A viewer with devtools open sees exactly what the page sees.
 *
 * **There is no role model in here, deliberately.** `controls` says what a viewer may
 * *do*; this says what a viewer may *see*; and both are fixed when the listener
 * starts, which is what makes them cheap to reason about — no per-request evaluation,
 * no session store, no second copy of your user table quietly disagreeing with the
 * first. Roles are yours: run a listener per role, put your own `auth.authorize`
 * predicate in front of each, and give each the sections and controls that role should
 * have. `npm run demo:roles` is that arrangement, working.
 *
 * ```ts
 * // An analyst sees traffic, not the reasons behind it — the evidence panel names
 * // the exact signal that fired, which is a tuning guide for whoever is scraping you.
 * await botHandler.serveDashboard({
 *   port: 9684,
 *   auth: { authorize: (req) => roleOf(req) === "analyst" },
 *   sections: { evidence: false, policy: false },
 *   redact: { maskIp: true },
 * });
 * ```
 */
export interface DashboardSections {
  /** The Live feed tab, and the `/api/feed` and `/api/stream` endpoints behind it. Default true. */
  feed?: boolean;
  /**
   * The case for each verdict: the evidence list with its written basis, the request
   * headers, the query parameters, the detector failures, and the buttons that turn a
   * row into a replay line or a corpus case. Default true.
   *
   * The one worth thinking about before sharing a dashboard widely. This is the half
   * of the page that says *which detector fired and why*, which is precisely what
   * somebody building a scraper against you needs in order to know what to fix next.
   * Switching it off leaves the feed — what happened, to whom, and what was done —
   * and drops the evidence from the wire, not just from the screen.
   */
  evidence?: boolean;
  /** The actor drill-down, the busiest-actors panel, and per-request actor history. Default true. */
  actors?: boolean;
  /** The Statistics tab and the counter tiles above it. Default true. */
  statistics?: boolean;
  /** The traffic audit panel — the window against its baseline. Default true. */
  audit?: boolean;
  /** The notices panel: startup warnings, audit anomalies, detector errors. Default true. */
  notices?: boolean;
  /**
   * The changes panel: what was applied at runtime, when, and by whom. Default true.
   *
   * The same list the traffic timeline marks. It is an audit trail rather than a log —
   * bounded and in memory, gone with the process — so treat the panel as the convenient
   * copy and `policy-change`, `guard-change`, `range-change` and `actor-change` as the
   * durable one.
   */
  changes?: boolean;
  /**
   * The Actors screen: the busiest actors the *registry* is holding, which is a far
   * larger population than the feed's ring. Default true, and it follows `actors`.
   */
  registry?: boolean;
  /**
   * The request tester: paste a User-Agent, a curl command or a raw header block and
   * see what the engine would make of it. Default true.
   *
   * It runs a dry-run assessment — nothing is recorded, no counter moves — so it
   * answers "why is this client being challenged?" without waiting for that client to
   * come back. It shows evidence, so it follows the `evidence` section too.
   */
  tester?: boolean;
  /** The Policy tab: the rules, the preview, the editor, the settings export. Default true. */
  policy?: boolean;
  /** The range sets panel, and the allowlist controls on it. Default true. */
  ranges?: boolean;
  /** The guard panel inside the Policy tab. Default true; see {@link DashboardControls.editGuard}. */
  guard?: boolean;
  /** The `robots.txt` the policy implies. Default true. */
  robots?: boolean;
}
