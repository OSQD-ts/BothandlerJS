import type { IncomingMessage, ServerResponse } from "node:http";
import type { ActionName } from "../policy/types.js";
import type { DashboardSections } from "./sections.js";
import type { Assessment, BotClass, Certainty, EvidenceDirection, Verdict } from "../types.js";

// Re-exported so this stays the one place to import dashboard types from; it lives in
// `sections.js` because the browser half needs it and this file speaks `node:http`.
export type { DashboardSections };

/**
 * How a viewer proves they are allowed to read the dashboard.
 *
 * There is no default, and that is deliberate. This page shows client addresses,
 * User-Agents, the paths people asked for, and — the part that matters most — exactly
 * which detector fired and why. That last item is a tuning guide for anyone building a
 * scraper against you: it tells them precisely which signal to fix next. So the server
 * refuses to start on a non-loopback address unless you have said something explicit
 * about who may read it.
 */
export type DashboardAuth =
  /** HTTP Basic. Both halves are compared in constant time. */
  | { username: string; password: string }
  /**
   * A shared secret, accepted as `Authorization: Bearer <token>` or as
   * `?token=<token>` so a link can be opened directly. The query form puts the secret
   * in browser history and in any proxy log on the way — fine for a laptop, a poor
   * idea for a shared deployment.
   */
  | { token: string }
  /**
   * Your own check — a session cookie, an SSO header your gateway sets, an mTLS
   * subject. Returning `false` produces a 401 with no hint about why.
   *
   * **Return a string to name the viewer.** Anything truthy admits them; a non-empty
   * string additionally says who they are, and that name travels with every change
   * they make — into the `warning` the handler raises, into `policy-change`,
   * `guard-change`, `range-change` and `actor-change`, and into the dashboard's own
   * notices. Without it the audit trail can say a rule set was replaced and cannot say
   * by whom, which is half an audit trail.
   *
   * ```ts
   * auth: { authorize: (req) => sessionFrom(req)?.email ?? false }
   * ```
   *
   * An empty string is a refusal rather than an anonymous admission, so a lookup that
   * returns `""` for "no such user" fails closed.
   */
  | { authorize: (request: IncomingMessage) => boolean | string | Promise<boolean | string> }
  /**
   * No authentication at all. An explicit, greppable opt-out: write this when the
   * dashboard is already behind something that authenticates, and never merely to
   * make the startup error go away.
   */
  | false;

/**
 * What a caller the dashboard will not serve is told.
 *
 * The default is honest, and honest is usually right: `401` says "there is something
 * here and you are not it", which is exactly what an operator who mistyped a password
 * needs to read. But it also confirms, to anybody sweeping a port range, that this
 * address runs an administrative page worth coming back to.
 *
 * Be clear about what changing it buys. **This is concealment, not access control.**
 * A dashboard that answers `404` to the wrong credentials is exactly as reachable by
 * someone holding the right ones as it was before, and exactly as exposed if the
 * credentials leak. It raises the cost of *finding*, which is worth something against
 * indiscriminate scanning and worth nearly nothing against somebody who already knows
 * where to look. It is a layer on top of `auth`, never a substitute for it — and if
 * reading this sentence makes you want to reach for it instead of authentication,
 * that is the opposite of what it is for.
 */
export type DashboardRefusal =
  /**
   * `401`, with `WWW-Authenticate` when the scheme is Basic. The default: a person
   * who got their password wrong is told so, and a browser can prompt.
   */
  | "unauthorized"
  /**
   * `404`, byte-identical to the answer for a path that does not exist here — so a
   * probe cannot tell a guarded dashboard from a server that has never heard of it.
   *
   * The cost is that a browser will never prompt for credentials, because nothing
   * asks it to. Pair it with `{ token }` or `{ authorize }` and a link people already
   * hold; Basic auth is refused with this setting, because a login you cannot reach
   * is not a login.
   */
  | "not-found"
  /**
   * No response at all — the connection is destroyed. What a port behind a dropping
   * firewall looks like.
   *
   * The quietest option and the most disruptive: some clients retry a dropped
   * connection rather than give up, and you lose the ability to tell a refusal from a
   * network fault in your own logs. Same Basic-auth caveat as `not-found`.
   */
  | "close"
  /**
   * Send them somewhere else. Your SSO's sign-in page is the useful case — an
   * operator who is simply not logged in yet ends up where they can fix that.
   *
   * `status` defaults to `302`. Note that a redirect is *not* concealment: it
   * announces both that something is here and where its login lives.
   */
  | { redirect: string; status?: 302 | 303 | 307 | 308 };

/** What a viewer may do beyond looking. */
export interface DashboardControls {
  /**
   * Allow the policy editor: viewing the rules as JSON, previewing a change against
   * recent traffic, and **applying it to the running handler**. Default false.
   *
   * What it can and cannot reach is the whole design. It replaces the rule list —
   * which rules exist, what each matches, what action each asks for. It cannot touch
   * `falsePositivePolicy`, `fallbackAction` or `terminalScoreThreshold`, so no edit
   * made here can relax the guard that stops an unproven verdict from denying
   * anybody. Loosening that stays a deploy.
   *
   * Every apply is validated first, swapped atomically, and announced through the
   * handler's `warning` event so it lands wherever your startup warnings land. The
   * server refuses to enable this at all on a non-loopback bind with `auth: false`:
   * an unauthenticated editor on a public address is a stranger's bot policy.
   */
  editPolicy?: boolean;
  /**
   * Allow the guard editor: changing `falsePositivePolicy`, `fallbackAction`,
   * `defaultAction`, `terminalScoreThreshold` and `suspectThreshold` on the running
   * handler. Default false, and the default is the one to keep unless somebody has
   * decided otherwise on purpose.
   *
   * **This is the setting that decides whether an unproven verdict can deny anybody.**
   * `editPolicy` changes which rules exist; a rule that overreaches is still stopped
   * by the guard, so the worst an editor can do is write a rule that gets downgraded.
   * This flag changes the guard itself. Moving `falsePositivePolicy` to `aggressive`
   * makes every probabilistic verdict terminal, and the people it turns away first are
   * the ones with the most unusual and most legitimate setups.
   *
   * So it is a separate flag from `editPolicy` rather than part of it: the two are
   * different powers, and a dashboard that hands out the first should not have to hand
   * out the second. Grant it the way you grant any other privileged operation — to a
   * listener that a role check stands in front of, and to nobody else. Two things
   * remain impossible whatever this is set to: a terminal `fallbackAction`, which
   * would make a downgrade deny the request it was protecting, and a
   * `terminalScoreThreshold` outside 1–100.
   *
   * Every change is validated first, applied whole or not at all, announced through
   * the handler's `warning` event and emitted as `guard-change` with both the before
   * and the after — which is the audit trail this deserves. The server refuses to
   * enable it at all on a non-loopback bind with `auth: false`.
   */
  editGuard?: boolean;
  /**
   * Allow the range editor and the per-actor operations: adding an address to the
   * allowlist or any other range set, forgetting one actor's history, and granting an
   * actor human clearance. Default false.
   *
   * The three of them are one flag because they are one job — acting on a specific
   * client rather than on a class of request — and because the first is consequential
   * enough to carry the other two. **An allowlisted address is not judged leniently; it
   * is not judged at all.** Detection does not run, no evidence is produced, no rule
   * sees it. That is the right answer for your own monitoring and the wrong answer for
   * anything that might one day be somebody else's.
   *
   * Forgetting an actor is the mild one, and the reason this exists at all: a person
   * whose actor key collected a `confirmed-bot` carries `priorConfirmations` for the
   * rest of the window, and until now the only cure was Reset — throwing away every
   * actor's history to fix one.
   *
   * Refused unauthenticated on a public bind, like the other editors. Unavailable when
   * `redact.maskIp` is on, because a masked key names a network rather than the actor
   * the registry is keyed by, and acting on the wrong key silently is worse than not
   * offering the button.
   */
  editRanges?: boolean;
  /**
   * Allow the "Reset" button to clear the feed, the counters and the **actor
   * registry**. Default false.
   *
   * Clearing the registry discards every actor's history, which is real state on a
   * live system: rate observations, cadence series, prior confirmations and challenge
   * clearances all go with it. That is exactly what you want while running the
   * simulator and exactly what you do not want a bored browser tab doing to
   * production.
   */
  reset?: boolean;
}


/** How much of each request the dashboard is allowed to show. */
export interface DashboardRedaction {
  /**
   * Replace client addresses with their network (`/24`, `/64`). Default false.
   *
   * Off by default because this is an operator's own tool and acting on a specific
   * address is the point. Turn it on when the dashboard is shared more widely than
   * the logs are — an address is personal data in most of the world, and the network
   * is enough to recognise a pattern.
   */
  maskIp?: boolean;
  /** Keep only the first 48 characters of each User-Agent. Default false. */
  truncateUserAgent?: boolean;
  /**
   * Replace query-string *values* with a placeholder, keeping the names. Default true.
   *
   * A query string is where password-reset tokens, invitation links and email
   * addresses actually live. The names are what make a pattern legible — a burst of
   * `?export=` is the thing worth seeing — and the values are what nobody needs on a
   * screen that gets screenshotted into tickets.
   */
  maskQuery?: boolean;
  /**
   * Show the request's headers in the row detail, credentials stripped. Default true.
   *
   * The header set in wire order is the single most useful thing when arguing with a
   * false positive — it is what half the detectors are reading. `Cookie`,
   * `Authorization` and their neighbours never appear whatever this is set to; see
   * `CREDENTIAL_HEADERS`.
   */
  headers?: boolean;
}

export interface DashboardOptions {
  /** Port to listen on. Default 9674. Pass 0 for an ephemeral port and read it back from `url`. */
  port?: number;
  /**
   * Address to bind. Default `"127.0.0.1"` — the loopback interface only.
   *
   * Binding anywhere else publishes the page to the network, so it requires an
   * explicit `auth` (or an explicit `auth: false`); the server refuses to start
   * otherwise rather than quietly exposing your evidence trail.
   */
  host?: string;
  auth?: DashboardAuth;
  /**
   * How a caller this dashboard will not serve is answered. Default `"unauthorized"`.
   *
   * Applies to every refusal made before routing — a failed `auth`, a `Host` outside
   * `allowedHosts`, a cross-site write — so that all three look alike and none of them
   * becomes an oracle. Under the default they keep their distinct, informative
   * statuses (`401`, `421`, `403`), because an operator debugging their own setup is
   * the likelier reader.
   */
  refusal?: DashboardRefusal;
  /** Path the dashboard is mounted under, e.g. `"/_bots"`. Default `"/"`. */
  basePath?: string;
  /** Name shown in the header and the document title. Default `"bothandlerjs"`. */
  title?: string;
  /**
   * Which process this is. Default the machine's hostname.
   *
   * Shown in the header, and it is there to answer a question the page otherwise
   * invites you to get wrong. **A dashboard reports on one process.** Behind a load
   * balancer with eight pods there are eight rings, eight sets of counters and eight
   * actor registries, and the one you happen to have opened is showing you an eighth of
   * your traffic. Naming the instance does not aggregate anything; it stops a partial
   * picture from looking like a whole one.
   */
  instance?: string;
  /** Links shown in the header — your site, your runbook, whatever is useful. */
  links?: ReadonlyArray<{ label: string; href: string }>;
  /** Requests kept in the live feed. Default 500, hard-capped at 5000. */
  feedLimit?: number;
  /**
   * How long a request may stay in the feed, in milliseconds. Default one hour; `0`
   * keeps them until the ring evicts them.
   *
   * `feedLimit` is a capacity bound and this is a retention one, which is a different
   * question with a different answer. On a quiet service five hundred requests can be a
   * fortnight of traffic, and every entry holds a client address, a User-Agent and a
   * header set belonging to a person. "We keep the last five hundred requests" is a
   * statement about memory; "we keep nothing older than an hour" is a promise you can
   * make to somebody who asks.
   *
   * Eviction runs when a request is recorded *and* on the dashboard's own timer, so it
   * holds on an idle process too — which is the only kind of process where it matters,
   * since a busy one drops entries by count long before they reach this age.
   */
  feedTtlMs?: number;
  /** Concurrent event-stream viewers. Default 16. Beyond this the server answers 503. */
  maxClients?: number;
  /**
   * Entries per second pushed to each viewer. Default 100; `0` removes the cap.
   *
   * A dashboard on a busy origin is a firehose: every assessment goes to every open
   * browser, so a thousand requests a second is a couple of megabytes a second *per
   * viewer*, and the only lever the page has is Pause. Above this rate the surplus is
   * dropped from the stream — not from the ring, which still holds the last
   * `feedLimit` requests for the preview and for anyone who reconnects — and the page
   * shows how many were skipped, so a thinned feed never looks like a quiet one.
   *
   * The cap is per second and not smoothed: a burst inside one second is delivered
   * whole up to the limit, because seeing the front of a burst is the point.
   */
  maxEventsPerSecond?: number;
  controls?: DashboardControls;
  /**
   * Where this listener keeps filters people save from the feed.
   *
   * Kept by the listener rather than by one browser, so a saved filter is there after a
   * reload, in another browser, and on a dashboard embedded in a page that owns its own
   * storage. In memory unless `file` is set; with a file they survive the process
   * restarting as well. Each listener has its own list — give two listeners the same file
   * only if they share an audience.
   *
   * ```ts
   * serveDashboard({ savedFilters: { file: "./.bothandler/saved-filters.json" } })
   * ```
   */
  savedFilters?: { file?: string | undefined } | undefined;
  /** Which parts of the page exist on this listener. See {@link DashboardSections}. */
  sections?: DashboardSections;
  redact?: DashboardRedaction;
  /**
   * Client addresses this dashboard will answer at all, as addresses or CIDRs.
   *
   * The layer `allowedHosts` is not. That one checks the name in the `Host` header —
   * what the client *asked for* — and closes DNS rebinding. This checks who is
   * connecting, which is the question an operator means when they say "bind `0.0.0.0`,
   * but only the VPN can reach it".
   *
   * ```ts
   * host: "0.0.0.0",
   * allowedClients: ["10.0.0.0/8", "192.168.0.0/16"],
   * auth: { username: "ops", password: process.env.DASHBOARD_PASSWORD! },
   * ```
   *
   * It is checked before authentication, so an address outside the list cannot even
   * attempt a credential, and it is answered through `refusal` like every other
   * pre-routing check. It is a *layer*, not a replacement for `auth`: addresses are
   * spoofable at the network level in ways passwords are not, and a shared office range
   * is not a person.
   *
   * The address compared is the one the handler's own proxy configuration resolves —
   * so behind a load balancer you list your users' addresses rather than the balancer's
   * — and a peer that is not one of your `trustedProxies` cannot claim to be somebody
   * else, because the chain is only walked for peers that are.
   */
  allowedClients?: readonly string[];
  /**
   * How a repeatedly-wrong credential is slowed down. Default: on.
   *
   * Both halves of a basic credential are compared in constant time, which stops one
   * attack and does nothing about the obvious one — trying again. An administrative
   * page reachable from anywhere with an unthrottled password prompt can be worked
   * through at line rate.
   *
   * After `maxAttempts` failures from one address the next attempt is refused outright
   * for a delay that doubles each time, up to `maxLockoutMs`. A success clears the
   * count. Set `false` to switch it off, which is only sensible when something in front
   * of the dashboard is already doing this.
   *
   * The refusal reuses whatever `refusal` says, so a dashboard configured to look like
   * an empty server still looks like one: a `429` would tell a prober that there is a
   * credential here worth guessing.
   */
  authThrottle?: { maxAttempts?: number; lockoutMs?: number; maxLockoutMs?: number } | false;
  /**
   * Sibling dashboards, for the header's instance switcher.
   *
   * A dashboard reports on one process — see {@link DashboardOptions.instance} — and
   * this is the honest amount of help the page can give with that: a way to reach the
   * other ones. It aggregates nothing, and deliberately: a feed and an actor registry
   * summed across pods would be a different tool, and the counters are already
   * aggregatable through Prometheus, which is a thing your monitoring already does.
   */
  peers?: ReadonlyArray<{ label: string; href: string }>;
  /**
   * Extra `Host` header values this dashboard will answer to.
   *
   * Only consulted on a loopback bind, where it defends against DNS rebinding: a name
   * the attacker controls, pointed at 127.0.0.1, makes their page *same-origin* with
   * this server and hands them the feed. Checking the `Host` header closes that,
   * because the name they need you to send is not one you wrote down.
   *
   * The defaults — `localhost`, `127.0.0.1`, `[::1]` and the bound address — cover how
   * a dashboard on loopback is actually opened. Add to them when you reach it through
   * a name of your own, e.g. an SSH tunnel aliased in `/etc/hosts`. A non-loopback
   * bind ignores this: rebinding buys an attacker nothing against an address they can
   * already reach, and enforcing it there would break every reverse proxy.
   *
   * Entries are compared without the port. `"*"` disables the check.
   */
  allowedHosts?: readonly string[];
  /**
   * Serve the Prometheus exposition at `<basePath>/metrics`, behind the same auth.
   * Default false — a scraper usually wants its own unauthenticated endpoint on a
   * different port, and `handler.prometheus()` gives you the text to serve there.
   */
  exposePrometheus?: boolean;
}

/**
 * Options for {@link createDashboardHandler}.
 *
 * The listening form's options minus the two that describe a socket it does not own,
 * plus one requirement: `auth` is mandatory, including the explicit `auth: false`.
 * `startDashboard` may skip it on `127.0.0.1` because the operating system is then the
 * access control; mounted, there is no bind address to inspect, so nothing can be
 * assumed and the assumption made is "public".
 */
export type DashboardHandlerOptions = Omit<DashboardOptions, "port" | "host"> & { auth: DashboardAuth };

/**
 * The dashboard as a request handler, for a server you already have.
 *
 * Callable as `(request, response)`. `close()` unsubscribes from the engine and ends
 * every event stream; it does not close a server it does not own.
 */
export interface DashboardRequestHandler {
  (request: IncomingMessage, response: ServerResponse): void;
  /** Event-stream viewers currently connected. */
  readonly clients: number;
  close(): Promise<void>;
}

/** A running dashboard. */
export interface DashboardServer {
  /** The address to open. Reflects the port actually bound, which matters when you passed 0. */
  readonly url: string;
  readonly port: number;
  readonly host: string;
  /** Event-stream viewers currently connected. */
  readonly clients: number;
  /** Stops listening, drops every stream, and unsubscribes from the engine. Idempotent. */
  close(): Promise<void>;
}

/** One assessed request, as the dashboard shows it. */
export interface DashboardEntry {
  seq: number;
  requestId: string;
  /** Epoch milliseconds, so the page can bucket by time without parsing anything. */
  at: number;
  method: string;
  path: string;
  actor: string;
  userAgent: string;
  verdict: Verdict;
  botClass: BotClass;
  identity?: string | undefined;
  score: number;
  certain: boolean;
  durationMs: number;
  bypass?: string | undefined;
  /** Absent until the policy has decided — `assess()` on its own never produces one. */
  action?: ActionName | undefined;
  rule?: string | undefined;
  downgradedFrom?: ActionName | undefined;
  downgradeReason?: string | undefined;
  evidence: DashboardEvidence[];
  /**
   * What this request would have been had the shadowed detectors counted.
   *
   * Absent unless a shadowed detector found something, which is also when the `shadow`
   * flag appears on one of the evidence entries above.
   */
  shadowVerdict?: { verdict: Verdict; botClass: BotClass; score: number; certain: boolean } | undefined;
  failures: Array<{ detector: string; reason: string; message: string }>;
  /** Actor history at the time of the request. Drives the actor drill-down. */
  actorStats: DashboardActor;
  /** Query parameters, values masked unless `redact.maskQuery` is false. */
  query: Record<string, string>;
  /** Headers in wire order, credentials removed. Absent when `redact.headers` is false. */
  headers?: Array<[name: string, value: string]> | undefined;
  protocol?: string | undefined;
  httpVersion?: string | undefined;
}

export interface DashboardEvidence {
  detector: string;
  summary: string;
  certainty: Certainty;
  direction: EvidenceDirection;
  /** From a shadowed detector: shown, counted, and part of no decision. */
  shadow?: true | undefined;
  family?: string | undefined;
  deterministicBasis?: string | undefined;
  /**
   * Identity, category and weight travel with the evidence for one reason beyond
   * display: they are what the policy matcher reads, so the entry alone is enough to
   * re-decide a request under a different rule set. See the policy preview.
   */
  identity?: string | undefined;
  category?: string | undefined;
  weight?: number | undefined;
}

/** Per-actor history as it stood when the request was assessed. */
export interface DashboardActor {
  requests: number;
  distinctPaths: number;
  priorConfirmations: number;
  cleared: boolean;
  firstSeen: number;
  sinceLastMs?: number | undefined;
}

/** One runtime change, for the timeline markers and the change list. */
export interface DashboardChange {
  at: number;
  kind: "policy" | "guard" | "range" | "actor";
  summary: string;
  /** Who asked for it, when the dashboard's `authorize` was able to say. */
  by?: string | undefined;
}

/** A warning or error the engine raised, for the notices panel. */
export interface DashboardNotice {
  at: number;
  kind: "warning" | "error";
  source?: string | undefined;
  message: string;
}

/** What a candidate rule set would have done to the traffic still in the window. */
export interface PolicyPreview {
  /** Requests the preview was run over — the retained window, not all time. */
  evaluated: number;
  changed: number;
  /** Action counts under the live policy and under the candidate. */
  before: Record<string, number>;
  after: Record<string, number>;
  /** Rule ids in the candidate, with how many of those requests each would have taken. */
  ruleHits: Array<{ rule: string; hits: number }>;
  /** A bounded sample of requests whose action would change. */
  samples: Array<{ path: string; verdict: string; userAgent: string; from: string; to: string; fromRule: string; toRule: string }>;
  /** Problems found in the candidate that do not stop it loading. */
  warnings: string[];
  /**
   * True when the candidate would deny a request the live policy served.
   *
   * Called out on its own because it is the one direction of change that costs
   * somebody their access, and it is easy to miss in a table of counts.
   */
  newDenials: number;
}

/** Everything the page is given at load time, and again on every stats refresh. */
export interface DashboardSnapshot {
  startedAt: number;
  now: number;
  /** Absent when the handler has `metrics: false`, or when the `statistics` section is off. */
  metrics: import("../metrics.js").MetricsSnapshot | undefined;
  detectors: Array<{ id: string; description: string; cost: string; stage: string; shadow?: true | undefined }>;
  rules: readonly string[];
  ranges: Array<{ name: string; size: number }>;
  /** Configuration a reader needs in order to interpret what they are looking at. */
  policy: {
    falsePositivePolicy: string;
    fallbackAction: string;
    suspectThreshold: number;
    defaultAction: string;
    terminalScoreThreshold: number;
    challengeEnabled: boolean;
    /** Whether this dashboard may change the rules. See {@link DashboardControls.editPolicy}. */
    editable: boolean;
    /** Whether this dashboard may change the guard. See {@link DashboardControls.editGuard}. */
    guardEditable: boolean;
  };
  /** Which process this is, and how long it has been up. See {@link DashboardOptions.instance}. */
  instance: string;
  /**
   * Runtime changes, newest last: policy replacements, guard edits, range updates and
   * per-actor operations.
   *
   * Drawn as markers on the traffic timeline, which is what turns a preview from a
   * prediction into something you can check. "44 of 151 requests would be treated
   * differently" is a claim; a line on the chart at the moment it was applied, with the
   * traffic either side of it, is the answer.
   */
  changes: readonly DashboardChange[];
  /** Feed entries dropped from the stream by the rate cap, since start. See {@link DashboardOptions.maxEventsPerSecond}. */
  skipped: number;
  /**
   * The names operators have given actors, keyed the way the feed keys actors.
   *
   * Carried on every stats frame rather than on the feed entries, because a name is given
   * after the fact — usually to an actor somebody noticed *in* the feed — and an entry
   * already delivered cannot be changed. With the names beside the entries instead, the
   * page draws every row from the current names, so naming an actor relabels its history
   * as well as its future, on every open dashboard within a refresh.
   *
   * On a listener that masks addresses the keys are masked too, since a map from raw
   * address to name is a list of raw addresses. Two actors sharing a network then share a
   * key, and both names are kept rather than one silently winning. Absent when the
   * `actors` section is off.
   */
  labels?: Record<string, string> | undefined;
  /**
   * The labelled actors whose label switches something: `hide` keeps them out of the live
   * feed, `skip` means they are not analysed. Only actors with a switch appear.
   *
   * Absent on a listener that masks addresses, where the feed keys actors by network and
   * hiding one would hide everybody sharing it. See `labelSwitchesForViewer` in the server.
   */
  labelSwitches?: Record<string, { hide?: true; skip?: true }> | undefined;
  /** Startup warnings, audit anomalies, and anything else the engine has raised. */
  notices: readonly DashboardNotice[];
  /**
   * The audit's two windows as they stand, and the checks installed.
   *
   * `undefined` when the audit was switched off with `audit: false`.
   */
  audit?:
    | {
        window: import("../audit.js").AuditWindow;
        baseline: import("../audit.js").AuditWindow;
        checks: Array<{ id: string; description: string }>;
      }
    | undefined;
}

/** The rule set as the dashboard shows it, plus what its editor needs to build itself. */
export interface PolicyDocument {
  rules: Array<{ id: string; index: number; editable: boolean; rule?: import("../policy/types.js").Rule }>;
  robots: string;
  robotsNotes: Array<{ rule: string; reason: string }>;
  editable: boolean;
  /** Whether the guard form is live on this dashboard. See {@link DashboardControls.editGuard}. */
  guardEditable: boolean;
  /** The guard as it stands, in the shape the guard form submits back. */
  guard: {
    falsePositivePolicy: string;
    fallbackAction: string;
    defaultAction: string;
    terminalScoreThreshold: number;
    suspectThreshold: number;
  };
  vocabulary: {
    verdicts: readonly string[];
    botClasses: readonly string[];
    categories: readonly string[];
    actions: readonly string[];
    /** Actions a downgrade may land on: everything except the terminal ones. */
    fallbackActions: readonly string[];
    falsePositivePolicies: readonly string[];
    methods: readonly string[];
    detectors: readonly string[];
    presets: readonly string[];
  };
}

/** Assessment plus the decision that followed it, as the feed records it. */
export interface DashboardRecord {
  assessment: Assessment;
  action?: ActionName | undefined;
}
