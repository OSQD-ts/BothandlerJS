import { createServer } from "node:http";
import { hostname } from "node:os";
import { ConfigError, validateRules } from "../config.js";
import { DashboardChanges, DashboardFeed, DashboardNotices } from "./feed.js";
import { candidatePolicy, previewPolicy } from "./preview.js";
import type { GuardSettings } from "../policy/policy.js";
import { constantTimeEqual, randomId } from "../internal/crypto.js";
import { bootFor, renderDashboardPage } from "./page.js";
import { robotsFromRules } from "../robots.js";
import { toPrometheus } from "../metrics.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { BotHandler } from "../core.js";
import { createFacts } from "../facts.js";
import { networkKey } from "../internal/ip.js";
import { parseRequest } from "./parse-request.js";
import type {
  DashboardAuth,
  DashboardEntry,
  DashboardHandlerOptions,
  DashboardOptions,
  DashboardRefusal,
  DashboardRequestHandler,
  DashboardSections,
  DashboardServer,
  DashboardSnapshot,
  PolicyDocument,
} from "./types.js";
import { IpRangeSet } from "../internal/ip.js";
import { TtlLru } from "../internal/lru.js";
import { ACTION_NAMES, TERMINAL_ACTIONS } from "../policy/types.js";
import { BOT_CATEGORIES } from "../detectors/known-bots.js";
import { BOT_CLASSES, VERDICTS } from "../types.js";
import { PRESETS } from "../policy/presets.js";
import type { PresetName } from "../policy/presets.js";
import type { Rule } from "../policy/types.js";

const DEFAULT_PORT = 9674;
const DEFAULT_HOST = "127.0.0.1";
const HEARTBEAT_MS = 15_000;
/** How often a connected viewer is sent fresh counters. The page redraws on receipt. */
const STATS_INTERVAL_MS = 2_000;
/** Largest policy document accepted from the editor. A rule set is kilobytes, not megabytes. */
const MAX_BODY_BYTES = 256 * 1024;
/**
 * Entries per second pushed to each viewer, unless the caller says otherwise.
 *
 * High enough that an ordinary site never reaches it, low enough that a busy one does
 * not hand every open browser two megabytes a second. See
 * {@link DashboardOptions.maxEventsPerSecond}.
 */
const DEFAULT_EVENTS_PER_SECOND = 100;
/**
 * How long a request stays in the feed by default.
 *
 * An hour rather than forever, because every entry holds somebody's address, their
 * User-Agent and their headers, and on a quiet service the ring's five hundred entries
 * can be a fortnight of them. A busy service never notices this bound; a quiet one is
 * the only place it matters, which is why it is a default rather than an option people
 * have to think of.
 */
const DEFAULT_FEED_TTL_MS = 60 * 60_000;
/** Actors listed on the Actors screen. More than a person reads, fewer than a registry holds. */
const MAX_ACTORS_LISTED = 200;
/** How long "clear as human" lasts when the page does not say. */
const DEFAULT_CLEARANCE_MS = 60 * 60_000;

/**
 * Addresses that reach only this machine.
 *
 * The list is exact rather than clever: an unrecognised host is treated as public,
 * which is the safe direction to be wrong in. A hostname that happens to resolve to
 * loopback still counts as public here — the check is about what you *wrote*, because
 * that is the thing a reviewer reads.
 */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost", "[::1]"]);

/**
 * What a mounted dashboard says its host is, for the checks that ask.
 *
 * A name rather than an address, and deliberately not a loopback one: mounted, there
 * is no bind address to inspect, so every "is this reachable from outside?" question
 * has to be answered "assume yes". It appears in the error messages those checks
 * raise, where it reads as what it is.
 */
const MOUNTED_HOST = "a server of your own";

/** How long a viewer may stay behind before its stream is dropped, and how much it may miss. */
const LAG_LIMIT_MS = 20_000;
const LAG_DROP_LIMIT = 5_000;

/**
 * Methods that change something here.
 *
 * The distinction matters because only these need protecting from a cross-site
 * caller. A cross-origin *read* is already useless to an attacker: this server sends
 * no `Access-Control-Allow-Origin`, so the browser fetches the response and then
 * refuses to show it to the page that asked. A write needs no response to have
 * happened.
 */
const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * One connected viewer, and how far behind it is.
 *
 * `response.write()` returns false when the kernel's send buffer is full, and until
 * this existed nothing looked at that. A viewer whose socket had stopped draining — a
 * laptop that slept with the tab open, a phone in a tunnel, a proxy that stopped
 * reading — did not slow down; its frames accumulated in this process's memory,
 * unboundedly, one queue per viewer. `maxEventsPerSecond` does not help: it bounds the
 * rate, and this is a backlog.
 *
 * So a stream that says it is full stops being sent feed entries until it drains, the
 * dropped frames are counted, and the viewer is told the count when it catches up —
 * because a gap it does not know about is worse than one it does. A stream that never
 * drains is ended, and the browser reconnects and resumes from its cursor, which is
 * the machinery that makes dropping it safe.
 */
interface Stream {
  response: ServerResponse;
  lagging: boolean;
  dropped: number;
  laggingSince: number;
}

/** What a built dashboard exposes to whichever of the two entry points made it. */
interface Dashboard {
  /** The request handler. Never rejects: an error inside it becomes a 500 and an `onError`. */
  serve: (request: IncomingMessage, response: ServerResponse) => void;
  readonly clients: number;
  /** Unsubscribes from the engine, ends every stream, stops every timer. */
  close: () => void;
}

/**
 * Everything that makes a dashboard, minus the question of who is listening.
 *
 * `host` is the bind address when this dashboard owns its listener, and `undefined`
 * when it is being mounted on somebody else's server. That single distinction decides
 * the two things that depend on knowing where the socket is:
 *
 * - **Whether loopback can be assumed.** A dashboard on `127.0.0.1` may skip `auth`,
 *   because the operating system is the access control. Mounted, there is no bind
 *   address to inspect and therefore nothing to assume, so `auth` becomes required —
 *   including the explicit `auth: false` that says something in front of it
 *   authenticates. Fails closed, in the direction the whole page is careful about.
 * - **Whether the `Host` header is checked.** The rebinding defence only applies to a
 *   loopback bind; mounted, it is enforced when `allowedHosts` is given and skipped
 *   when it is not, because the server that owns the socket is the thing that knows
 *   which names reach it.
 */
function buildDashboard(handler: BotHandler, options: DashboardOptions, host: string | undefined): Dashboard {
  const mounted = host === undefined;
  const basePath = normalizeBase(options.basePath ?? "/");
  // A mounted dashboard is treated as public: there is no bind address to read, so
  // "this is loopback, the OS is the access control" is not a claim anybody can make.
  const auth = validateAuth(options.auth, host ?? MOUNTED_HOST);
  const refusal = validateRefusal(options.refusal ?? "unauthorized", auth);
  const allowedHosts = mounted ? resolveMountedHosts(options.allowedHosts) : resolveAllowedHosts(host, options.allowedHosts);
  const maxClients = Math.max(1, options.maxClients ?? 16);
  const allowReset = options.controls?.reset === true;
  const allowEdit = validateEditing(options.controls?.editPolicy === true, auth, host ?? MOUNTED_HOST, "controls.editPolicy");
  const sections = resolveSections(options.sections);
  const maskIp = options.redact?.maskIp === true;
  // A masked actor key names a `/24`, and the registry is keyed by the address. Acting
  // on the wrong key silently is worse than not offering the button, so the whole
  // control goes rather than half of it.
  const allowActing = sections.ranges && !maskIp && validateEditing(options.controls?.editRanges === true, auth, host ?? MOUNTED_HOST, "controls.editRanges");
  // A guard editor inside a Policy tab that does not exist is not a feature anybody
  // asked for, and an operator who wrote both would have to read the code to find out
  // which won. The section decides.
  const allowGuardEdit = sections.guard && sections.policy && validateEditing(options.controls?.editGuard === true, auth, host ?? MOUNTED_HOST, "controls.editGuard");
  const startedAt = handler.config.clock.now();

  const feed = new DashboardFeed(handler, options.feedLimit ?? 500, options.redact ?? {}, {
    maxEventsPerSecond: options.maxEventsPerSecond ?? DEFAULT_EVENTS_PER_SECOND,
    ttlMs: options.feedTtlMs ?? DEFAULT_FEED_TTL_MS,
  });
  const allowedClients = options.allowedClients === undefined || options.allowedClients.length === 0 ? undefined : validateClients(options.allowedClients);
  const throttle = createAuthThrottle(options.authThrottle, handler);
  const notices = new DashboardNotices(handler);
  const changes = new DashboardChanges(handler);
  const instance = options.instance ?? hostname();
  const pageOptions = {
    title: options.title ?? "bothandlerjs",
    basePath,
    links: options.links ?? [],
    allowReset,
    allowEdit,
    allowGuardEdit,
    allowActing,
    sections,
    peers: options.peers ?? [],
  };
  const page = renderDashboardPage(pageOptions);
  // The same object the standalone page carries inline. The embeddable element cannot be
  // handed it at render time — it is somebody else's page — so it asks for it, and asking
  // must return exactly what the page would have been given or the two drift apart.
  const bootstrap = JSON.stringify(bootFor(pageOptions));

  const streams = new Set<Stream>();
  /**
   * One timer for every viewer, rather than one per viewer.
   *
   * `snapshot()` walks the detector list, the rule list, the range sets and both audit
   * windows. Sixteen browsers open on the same dashboard used to mean sixteen
   * identical walks every two seconds; now it means one walk and sixteen writes of the
   * same string. It runs only while somebody is watching.
   */
  let statsTimer: NodeJS.Timeout | undefined;

  function startStatsTimer(): void {
    if (statsTimer !== undefined) return;
    statsTimer = setInterval(() => {
      // Retention is a promise about time, so it is kept whether or not anybody is
      // watching: the eviction happens here rather than only when a request arrives.
      feed.prune(handler.config.clock.now());
      if (streams.size === 0) return;
      const frame = frameFor("stats", snapshot());
      for (const stream of streams) {
        // A viewer that has been stuck for twenty seconds is not a viewer. Ending it
        // frees the buffer; `EventSource` reconnects on its own and resumes from the
        // last id it saw, so nothing is lost that the ring still holds.
        if (stream.lagging && (handler.config.clock.now() - stream.laggingSince > LAG_LIMIT_MS || stream.dropped > LAG_DROP_LIMIT)) {
          stream.response.end();
          streams.delete(stream);
          continue;
        }
        // Counters are never dropped: they are small, they are the page's only sign of
        // life, and a viewer that is behind on the feed still needs to know it is behind.
        writeFrame(stream, frame, false);
      }
    }, STATS_INTERVAL_MS);
    statsTimer.unref();
  }

  /**
   * Writes one frame to one viewer, honouring what the socket says about itself.
   *
   * `droppable` is the whole distinction: a feed entry may be skipped, because the
   * viewer can catch up from the ring and will be told what it missed. A `stats` frame
   * or a `sync` marker may not, because those are how the page knows anything at all.
   */
  function writeFrame(stream: Stream, frame: string, droppable: boolean): void {
    if (stream.lagging && droppable) {
      stream.dropped++;
      return;
    }
    if (stream.response.write(frame)) return;
    if (stream.lagging) return;

    stream.lagging = true;
    stream.laggingSince = handler.config.clock.now();
    stream.response.once("drain", () => {
      stream.lagging = false;
      if (stream.dropped === 0) return;
      // Said out loud rather than papered over. The viewer's feed has a hole in it and
      // the page shows the size of it, next to the count the rate cap keeps.
      const missed = stream.dropped;
      stream.dropped = 0;
      stream.response.write(frameFor("lagged", { dropped: missed }));
    });
  }

  /** The handler both entry points hand out. It never rejects; a failure is a 500. */
  function serve(request: IncomingMessage, response: ServerResponse): void {
    void route(request, response).catch((error: unknown) => {
      handler.config.onError(error, { source: "dashboard" });
      if (!response.headersSent) response.writeHead(500, { "content-type": "text/plain" });
      response.end("dashboard error\n");
    });
  }

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://dashboard.invalid");
    const route = routeOf(url.pathname, basePath, mounted);

    // These run before authentication, and deliberately so: they answer "was this
    // request addressed to this server, by something allowed to address it" — a
    // question that credentials cannot settle, because the browser attaches them to a
    // forged request as willingly as to a real one.
    const peer = handler.resolveIp(request.socket.remoteAddress, request.headers as Record<string, string | undefined>);
    if (allowedClients !== undefined && !allowedClients.contains(peer)) {
      refuse(request, response, refusal, () =>
        send(response, 403, "text/plain; charset=utf-8", "403 forbidden\n\nThis dashboard answers only the client addresses it was configured for.\n"),
      );
      return;
    }

    // A wrong credential is slowed down before it is checked, so the check itself is
    // never the thing an attacker gets to repeat.
    const locked = throttle.check(peer);
    if (locked !== undefined) {
      refuse(request, response, refusal, () => {
        response.writeHead(429, { ...SECURITY_HEADERS, "content-type": "text/plain; charset=utf-8", "retry-after": String(Math.ceil(locked / 1000)) });
        response.end("429 too many attempts\n");
      });
      return;
    }

    if (!hostAllowed(request, allowedHosts)) {
      refuse(request, response, refusal, () =>
        send(
          response,
          421,
          "text/plain; charset=utf-8",
          "421 misdirected request\n\nThis dashboard answers only to the host names it was configured for. Add yours with `allowedHosts`.\n",
        ),
      );
      return;
    }

    if (request.method !== undefined && UNSAFE_METHODS.has(request.method) && !isSameOrigin(request)) {
      refuse(request, response, refusal, () =>
        send(
          response,
          403,
          "text/plain; charset=utf-8",
          "403 cross-site request\n\nThis dashboard accepts changes only from its own page.\n",
        ),
      );
      return;
    }

    // Authentication runs before routing, so an unauthenticated probe cannot even
    // learn which paths exist here.
    const viewer = await authorize(request, url, auth);
    if (viewer.ok) throttle.succeeded(peer);
    else throttle.failed(peer);
    if (!viewer.ok) {
      refuse(request, response, refusal, () => {
        const headers: Record<string, string> = { ...SECURITY_HEADERS, "content-type": "text/plain; charset=utf-8" };
        // Only Basic gets a challenge header. Prompting for a password when the server
        // wants a bearer token produces a dialog no credential can satisfy.
        if (auth !== false && "username" in auth) headers["www-authenticate"] = 'Basic realm="bothandlerjs dashboard", charset="UTF-8"';
        response.writeHead(401, headers);
        response.end("401 unauthorized\n");
      });
      return;
    }

    if (route === undefined) {
      send(response, 404, "text/plain; charset=utf-8", "404 not found\n");
      return;
    }

    // Who is asking, when the configured `auth` was able to say — a basic credential
    // knows its own username, and a custom `authorize` can return one. It travels with
    // every change made below, into the handler's warnings and its change events. An
    // audit trail that can say a rule set was replaced but not by whom is half of one.
    const by = viewer.by;

    switch (route) {
      case "/":
        return sendPage(response);
      case "/api/bootstrap":
        return send(response, 200, "application/json; charset=utf-8", bootstrap);
      case "/api/stats":
        return send(response, 200, "application/json; charset=utf-8", JSON.stringify(snapshot()));
      case "/api/feed":
        if (!sections.feed) return sectionOff(response, "feed");
        return send(response, 200, "application/json; charset=utf-8", JSON.stringify({ entries: feed.backlog().map(project) }));
      case "/api/stream":
        if (!sections.feed) return sectionOff(response, "feed");
        return stream(request, url, response);
      case "/api/policy":
        if (!sections.policy) return sectionOff(response, "policy");
        return send(response, 200, "application/json; charset=utf-8", JSON.stringify(policyDocument()));

      case "/api/settings":
        if (!sections.policy) return sectionOff(response, "policy");
        return send(response, 200, "application/json; charset=utf-8", JSON.stringify(settingsDocument(), null, 2));

      case "/api/actors": {
        if (!sections.registry) return sectionOff(response, "registry");
        const limit = Math.min(MAX_ACTORS_LISTED, Math.max(1, Number(url.searchParams.get("limit") ?? 50) || 50));
        const actors = handler.registry.top(limit, handler.config.clock.now()).map((actor) => ({
          ...actor,
          key: maskIp ? (networkKey(actor.key) ?? actor.key) : actor.key,
        }));
        return send(response, 200, "application/json; charset=utf-8", JSON.stringify({ actors, tracked: handler.registry.size, actionable: allowActing }));
      }

      case "/api/ranges": {
        if (!sections.ranges) return sectionOff(response, "ranges");
        if (request.method !== "POST") {
          return send(
            response,
            200,
            "application/json; charset=utf-8",
            JSON.stringify({
              ranges: handler.listRanges().map((range) => ({ ...range, entries: handler.rangeEntries(range.name) ?? [] })),
              editable: allowActing,
            }),
          );
        }
        if (!allowActing) {
          sendError(response, 403, "Editing ranges is disabled on this dashboard. Enable it with controls: { editRanges: true }.");
          return;
        }
        const body = await readJson(request);
        if ("error" in body) {
          send(response, 400, "application/json; charset=utf-8", JSON.stringify({ error: body.error }));
          return;
        }
        try {
          const { name, entries } = rangeUpdate(body.value, handler);
          handler.updateRanges(name, entries, { by });
          send(response, 200, "application/json; charset=utf-8", JSON.stringify({ ok: true, name, entries: handler.rangeEntries(name) ?? [] }));
        } catch (error) {
          send(response, 400, "application/json; charset=utf-8", JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
        }
        return;
      }

      case "/api/actor": {
        if (!sections.actors) return sectionOff(response, "actors");
        if (request.method !== "POST") {
          sendError(response, 405, "Use POST.");
          return;
        }
        if (!allowActing) {
          sendError(response, 403, "Acting on an actor is disabled on this dashboard. Enable it with controls: { editRanges: true }.");
          return;
        }
        const body = await readJson(request);
        if ("error" in body) {
          send(response, 400, "application/json; charset=utf-8", JSON.stringify({ error: body.error }));
          return;
        }
        const payload = body.value as { key?: unknown; action?: unknown; forMs?: unknown } | null;
        const key = typeof payload?.key === "string" ? payload.key.slice(0, 200) : "";
        const action = payload?.action;
        if (key === "") {
          sendError(response, 400, "Expected `key` naming the actor to act on.");
          return;
        }
        if (action === "forget") {
          handler.forgetActor(key, { by });
        } else if (action === "clear") {
          const forMs = typeof payload?.forMs === "number" && Number.isFinite(payload.forMs) ? Math.min(24 * 60 * 60_000, Math.max(0, payload.forMs)) : DEFAULT_CLEARANCE_MS;
          handler.clearActor(key, forMs, { by });
        } else {
          sendError(response, 400, 'Expected `action` to be "forget" or "clear".');
          return;
        }
        send(response, 200, "application/json; charset=utf-8", JSON.stringify({ ok: true }));
        return;
      }

      case "/api/test": {
        if (!sections.tester || !sections.feed) return sectionOff(response, "tester");
        if (request.method !== "POST") {
          sendError(response, 405, "Use POST.");
          return;
        }
        const body = await readJson(request);
        if ("error" in body) {
          send(response, 400, "application/json; charset=utf-8", JSON.stringify({ error: body.error }));
          return;
        }
        try {
          send(response, 200, "application/json; charset=utf-8", JSON.stringify(await testRequest(body.value)));
        } catch (error) {
          send(response, 400, "application/json; charset=utf-8", JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
        }
        return;
      }

      case "/api/guard": {
        if (!sections.guard || !sections.policy) return sectionOff(response, "guard");
        if (request.method !== "POST") {
          sendError(response, 405, "Use POST.");
          return;
        }
        // Gated twice, like the rule editor: the page hides the form, and the server
        // refuses the write. A hidden control is a UI decision; this is the control.
        if (!allowGuardEdit) {
          sendError(response, 403, "Guard editing is disabled on this dashboard. Enable it with controls: { editGuard: true }.");
          return;
        }
        const body = await readJson(request);
        if ("error" in body) {
          send(response, 400, "application/json; charset=utf-8", JSON.stringify({ error: body.error }));
          return;
        }
        try {
          const result = handler.updateGuard(guardSettings(body.value), { by });
          send(response, 200, "application/json; charset=utf-8", JSON.stringify({ ok: true, guard: result.guard }));
        } catch (error) {
          // Nothing has moved: `updateGuard` validates before it assigns.
          send(response, 400, "application/json; charset=utf-8", JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
        }
        return;
      }

      case "/api/policy/preview": {
        if (!sections.policy) return sectionOff(response, "policy");
        if (request.method !== "POST") {
          sendError(response, 405, "Use POST.");
          return;
        }
        const body = await readJson(request);
        if ("error" in body) {
          send(response, 400, "application/json; charset=utf-8", JSON.stringify({ error: body.error }));
          return;
        }
        try {
          const { rules, warnings } = candidateRules(body.value);
          // A guard is previewable whether or not it is editable here: "what would
          // balanced have done to my traffic?" is a question worth answering to
          // somebody who then has to go and write it into a deploy.
          const guard = sections.guard ? guardSettings((body.value as { guard?: unknown } | null)?.guard) : {};
          const preview = previewPolicy(feed.backlog(), handler.policy, candidatePolicy(mergeRules(rules), handler.policy, guard), warnings);
          send(response, 200, "application/json; charset=utf-8", JSON.stringify(preview));
        } catch (error) {
          send(response, 400, "application/json; charset=utf-8", JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
        }
        return;
      }

      case "/api/policy/apply": {
        if (!sections.policy) return sectionOff(response, "policy");
        // Gated twice on purpose: the page hides the editor, and the server refuses
        // it. A hidden button is a UI decision; this is the control.
        if (!allowEdit) {
          sendError(response, 403, "Policy editing is disabled on this dashboard. Enable it with controls: { editPolicy: true }.");
          return;
        }
        if (request.method !== "POST") {
          sendError(response, 405, "Use POST.");
          return;
        }
        const body = await readJson(request);
        if ("error" in body) {
          send(response, 400, "application/json; charset=utf-8", JSON.stringify({ error: body.error }));
          return;
        }
        try {
          const { rules } = candidateRules(body.value);
          const merged = mergeRules(rules);
          const result = handler.updatePolicy(merged, { by });
          send(response, 200, "application/json; charset=utf-8", JSON.stringify({ ok: true, rules: merged.length, warnings: result.warnings }));
        } catch (error) {
          // A rejected edit leaves the running policy exactly as it was: `updatePolicy`
          // validates before it swaps.
          send(response, 400, "application/json; charset=utf-8", JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
        }
        return;
      }

      case "/api/reset":
        if (!allowReset) {
          sendError(response, 403, "Reset is disabled on this dashboard. Enable it with controls: { reset: true }.");
          return;
        }
        if (request.method !== "POST") {
          sendError(response, 405, "Use POST.");
          return;
        }
        feed.clear();
        handler.registry.clear();
        handler.config.onWarning(`The dashboard's feed and actor registry were cleared${by === undefined ? "" : ` by ${by}`}.`);
        send(response, 200, "application/json; charset=utf-8", JSON.stringify({ ok: true }));
        return;
      case "/metrics": {
        if (options.exposePrometheus !== true) {
          send(response, 404, "text/plain; charset=utf-8", "404 not found\n");
          return;
        }
        const metrics = handler.metrics();
        if (metrics === undefined) {
          send(response, 503, "text/plain; charset=utf-8", "Metrics are disabled on this handler (metrics: false).\n");
          return;
        }
        send(response, 200, "text/plain; version=0.0.4; charset=utf-8", toPrometheus(metrics));
        return;
      }
      default:
        send(response, 404, "text/plain; charset=utf-8", "404 not found\n");
    }
  }

  function snapshot(): DashboardSnapshot {
    const described = handler.policy.describe();
    return {
      startedAt,
      now: handler.config.clock.now(),
      // Off with the Statistics section rather than merely unrendered: the counters
      // are the page's other description of your detection, and a section that is
      // switched off should not be readable from the network tab.
      metrics: sections.statistics ? handler.metrics() : undefined,
      detectors: sections.statistics ? handler.describeDetectors() : [],
      rules: sections.policy ? described.rules : [],
      ranges: sections.policy ? handler.listRanges() : [],
      policy: {
        falsePositivePolicy: described.falsePositivePolicy,
        fallbackAction: described.fallbackAction,
        suspectThreshold: handler.config.suspectThreshold,
        defaultAction: described.defaultAction,
        terminalScoreThreshold: described.terminalScoreThreshold,
        challengeEnabled: handler.challenge !== undefined,
        editable: allowEdit,
        guardEditable: allowGuardEdit,
      },
      notices: sections.notices ? notices.list() : [],
      instance,
      // The markers on the traffic timeline. Not gated on the policy section: a change
      // to the guard or the allowlist is a thing that happened to the traffic, and the
      // person watching the traffic should see it whether or not they may make one.
      changes: sections.changes ? changes.list() : [],
      skipped: feed.skipped,
      ...(handler.audit !== undefined && sections.audit
        ? { audit: { ...handler.audit.summary(), checks: handler.audit.checks.map((check) => ({ id: check.id, description: check.description })) } }
        : {}),
    };
  }

  /**
   * One feed entry as *this* listener is allowed to describe it.
   *
   * Applied on the way out rather than on the way in, because the entry the feed keeps
   * has to stay whole: `previewPolicy` re-decides requests from these, and a preview
   * run over entries with their evidence removed would quietly answer a different
   * question from the one asked. So the ring holds everything and a viewer is sent a
   * projection of it.
   */
  function project(entry: DashboardEntry): DashboardEntry {
    if (sections.evidence && sections.actors) return entry;
    // Rebuilt rather than edited, because the fields being withheld are optional ones:
    // deleting a key and assigning `undefined` to it are the same thing to a reader and
    // different things to the type system, and only one of them can be spread.
    const { headers, downgradeReason, ...rest } = entry;
    return {
      ...rest,
      ...(sections.evidence ? { ...(headers !== undefined ? { headers } : {}), ...(downgradeReason !== undefined ? { downgradeReason } : {}) } : {}),
      ...(sections.evidence ? {} : { evidence: [], failures: [], query: {} }),
      ...(sections.actors ? {} : { actorStats: { requests: 0, distinctPaths: 0, priorConfirmations: 0, cleared: false, firstSeen: entry.at } }),
    };
  }

  /**
   * What the engine would make of a request that is not happening.
   *
   * A **dry run**: `record: false` means no counter moves, no actor state changes, no
   * `assessment` event fires. Asking the question does not become part of the answer to
   * "what is my traffic doing?", which is the only way a tester belongs on a page whose
   * whole purpose is to describe that traffic honestly.
   *
   * The decision is real: `decide()` is pure, so the rule that would fire and the
   * action it would take — guard included — are exact rather than simulated. What the
   * dry run cannot know is history. It gets an actor with no past, so `cadence`,
   * `crawl-breadth` and `rate-anomaly` have nothing to read, and the answer is
   * "what would this look like as a first request", which is the question a support
   * ticket is actually asking.
   */
  async function testRequest(body: unknown): Promise<unknown> {
    const payload = body as { raw?: unknown; method?: unknown; url?: unknown; ip?: unknown } | null;
    const parsed = parseRequest(typeof payload?.raw === "string" ? payload.raw : "", {
      method: typeof payload?.method === "string" && payload.method !== "" ? payload.method : undefined,
      url: typeof payload?.url === "string" && payload.url !== "" ? payload.url : undefined,
      ip: typeof payload?.ip === "string" && payload.ip !== "" ? payload.ip : undefined,
    });

    const facts = createFacts({
      method: parsed.method,
      url: parsed.url,
      headers: parsed.headers,
      ip: parsed.ip,
      protocol: "https",
      httpVersion: "1.1",
    });

    const assessment = await handler.assess(facts, { record: false });
    const decision = handler.policy.decide(assessment);
    const entry = project(feed.entryFor(assessment, 0));
    return {
      entry: {
        ...entry,
        action: decision.action,
        rule: decision.rule,
        downgradedFrom: decision.downgradedFrom,
        downgradeReason: decision.downgradeReason,
      },
      reason: decision.reason,
      assumed: parsed.assumed,
    };
  }

  function sectionOff(response: ServerResponse, section: string): void {
    sendError(response, 403, `The "${section}" section is switched off on this dashboard (sections: { ${section}: false }).`);
  }

  /**
   * The rule set as JSON, plus the `robots.txt` it implies.
   *
   * Rules whose match is a *predicate function* cannot be serialised, so they are
   * listed with a flag instead of a body and preserved verbatim across an edit — see
   * `applyRules`. Silently dropping them would be the worst outcome available: an
   * operator saves an unrelated change and a rule they cannot see stops existing.
   */
  function policyDocument(): PolicyDocument {
    const rules = handler.policy.rules.map((rule, index) => {
      const editable = typeof rule.match !== "function";
      return { id: rule.id, index, editable, ...(editable ? { rule } : {}) };
    });
    const robots = sections.robots ? robotsFromRules(handler.policy.rules) : { robotsTxt: "", unreadable: [] };
    const guard = handler.policy.describeGuard();
    return {
      rules,
      robots: robots.robotsTxt,
      robotsNotes: [...robots.unreadable],
      editable: allowEdit,
      guardEditable: allowGuardEdit,
      guard: { ...guard, suspectThreshold: handler.config.suspectThreshold },
      // The editor's dropdowns are built from these rather than from a copy of its
      // own, so a verdict or an action added to the library appears in the GUI
      // without anybody remembering to update it.
      vocabulary: {
        verdicts: VERDICTS,
        botClasses: BOT_CLASSES,
        categories: BOT_CATEGORIES,
        actions: ACTION_NAMES,
        // What a downgraded decision may become. The terminal actions are absent
        // because a terminal fallback is the one setting that would let the guard
        // deny the request it stepped in to protect; `replaceGuard` refuses it, and
        // the form should not offer what the server will not take.
        fallbackActions: ACTION_NAMES.filter((action) => !TERMINAL_ACTIONS.has(action)),
        falsePositivePolicies: ["strict", "balanced", "aggressive"],
        methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
        detectors: handler.describeDetectors().map((detector) => detector.id),
        presets: Object.keys(PRESETS),
      },
    };
  }

  /**
   * Everything this dashboard knows about how the handler is configured.
   *
   * Split into what an import can *change* — the rules — and what it can only
   * describe. Detectors, ranges, the guard and the audit come from the code that
   * constructed the handler, and a settings file that appeared to carry them would be
   * promising something it cannot deliver.
   */
  function settingsDocument(): Record<string, unknown> {
    const described = handler.policy.describe();
    return {
      format: "bothandlerjs/settings",
      version: 1,
      exportedAt: new Date(handler.config.clock.now()).toISOString(),
      title: options.title ?? "bothandlerjs",
      // The importable half.
      rules: handler.policy.rules.filter((rule) => typeof rule.match !== "function"),
      // The describing half. Present so a file is a complete record of the running
      // configuration; ignored on import, and the page says so.
      readOnly: {
        guard: {
          falsePositivePolicy: described.falsePositivePolicy,
          fallbackAction: described.fallbackAction,
          defaultAction: described.defaultAction,
          terminalScoreThreshold: described.terminalScoreThreshold,
        },
        suspectThreshold: handler.config.suspectThreshold,
        challengeEnabled: handler.challenge !== undefined,
        detectors: handler.describeDetectors(),
        ranges: handler.listRanges(),
        lockedRules: handler.policy.rules.filter((rule) => typeof rule.match === "function").map((rule) => rule.id),
        audit: handler.audit !== undefined ? { checks: handler.audit.checks.map((check) => check.id) } : null,
        dashboard: {
          controls: { reset: allowReset, editPolicy: allowEdit, editGuard: allowGuardEdit },
          sections,
          basePath,
          exposePrometheus: options.exposePrometheus === true,
        },
      },
    };
  }

  /**
   * Puts a submitted rule list back together with the ones that could not be sent.
   *
   * A predicate rule keeps its position by id: the submitted list is walked, and any
   * function-matched rule that was in the running policy is spliced back where it was.
   * Order is the whole semantics of a first-match policy, so "keep the position" is
   * not a nicety.
   */
  function mergeRules(submitted: readonly Rule[]): Rule[] {
    const merged: Rule[] = [...submitted];
    handler.policy.rules.forEach((rule, index) => {
      if (typeof rule.match !== "function") return;
      // Back at the index it held. Order is the whole semantics of a first-match
      // policy, so "wherever it ends up" is not an option, and the editor shows these
      // in place and locked so the result is what the operator saw.
      merged.splice(Math.min(index, merged.length), 0, rule);
    });
    return merged;
  }

  function sendPage(response: ServerResponse): void {
    // A fresh nonce per response, so the page's own inline script runs under a CSP
    // that permits nothing else — no remote script, no remote style, no framing.
    const nonce = randomId(12);
    const html = page(nonce);
    response.writeHead(200, {
      ...SECURITY_HEADERS,
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    });
    response.end(html);
  }

  function stream(request: IncomingMessage, url: URL, response: ServerResponse): void {
    if (streams.size >= maxClients) {
      sendError(response, 503, `Too many dashboard viewers (limit ${maxClients}).`);
      return;
    }

    response.writeHead(200, {
      ...SECURITY_HEADERS,
      "content-type": "text/event-stream; charset=utf-8",
      connection: "keep-alive",
      // Nagle's algorithm holds small frames back; a live feed is nothing but small
      // frames, and the delay is visible as a stutter.
      "x-accel-buffering": "no",
    });
    request.socket.setNoDelay(true);
    const viewer: Stream = { response, lagging: false, dropped: 0, laggingSince: 0 };
    streams.add(viewer);

    writeFrame(viewer, frameFor("stats", snapshot()), false);

    // A reconnecting browser resends the last `id:` it saw, unasked, and a resume is
    // the difference between a handful of frames and the whole ring — five hundred
    // entries with their headers, evidence and actor history — every time a laptop
    // lid closes or a proxy times an idle stream out. `?since=` is the same thing for
    // a client that is not an `EventSource`.
    const resumeFrom = cursorOf(headerValue(request, "last-event-id") ?? url.searchParams.get("since") ?? undefined);
    const missed = resumeFrom === undefined ? undefined : feed.since(resumeFrom);
    const cursor = feed.cursor;
    // No cursor, or one this feed can no longer speak to: the viewer is told to start
    // again rather than left holding rows nothing will ever correct.
    writeFrame(viewer, frameFor("sync", missed === undefined ? { replace: true } : { replace: false, from: resumeFrom, entries: missed.length }), false);
    // The replay itself is droppable, because a viewer too slow to receive it is a
    // viewer that will ask for it again from the cursor it never advanced past.
    for (const entry of missed ?? feed.backlog()) writeFrame(viewer, frameFor("entry", project(entry)), true);
    // One id for the whole replay rather than one per entry, so that a connection
    // dropped halfway through it leaves the viewer's cursor where it was and the
    // replay simply happens again. A per-entry id would leave the cursor at the last
    // entry that *arrived* and silently skip the rest.
    writeFrame(viewer, frameFor("synced", { cursor }, cursor), false);

    const unsubscribe = feed.subscribe((event, entry, frame) => writeFrame(viewer, frameFor(event, entry === undefined ? {} : project(entry), frame), true));
    // A comment frame keeps proxies and browsers from closing an idle stream.
    const heartbeat = setInterval(() => writeFrame(viewer, ": ping\n\n", false), HEARTBEAT_MS);
    heartbeat.unref();
    startStatsTimer();

    const done = (): void => {
      unsubscribe();
      clearInterval(heartbeat);
      streams.delete(viewer);
    };
    request.on("close", done);
    response.on("close", done);
  }


  return {
    serve,
    get clients(): number {
      return streams.size;
    },
    close(): void {
      if (statsTimer !== undefined) clearInterval(statsTimer);
      statsTimer = undefined;
      feed.close();
      notices.close();
      changes.close();
      for (const stream of streams) stream.response.end();
      streams.clear();
    },
  };
}

/**
 * The dashboard as a request handler, for mounting on a server you already have.
 *
 * The reason to want this is almost always TLS. `startDashboard` opens a plain HTTP
 * listener, which is right on a laptop and wrong in most production networks: the
 * certificate lives at an ingress, everything has to be reachable under one hostname,
 * or the platform exposes exactly one port. None of that is an argument against the
 * design — it is an argument about *which* server the page is served from.
 *
 * ```ts
 * const dashboard = createDashboardHandler(botHandler, {
 *   basePath: "/_bots",
 *   auth: { authorize: (req) => sessionFrom(req)?.email ?? false },
 * });
 *
 * https.createServer(tls, (req, res) => {
 *   if (req.url?.startsWith("/_bots")) return dashboard(req, res);
 *   return app(req, res);
 * }).listen(443);
 * ```
 *
 * Two things are different from the listening form, and both follow from not owning
 * the socket:
 *
 * - **`auth` is required**, including the explicit `auth: false`. The listening form
 *   may skip it on `127.0.0.1` because the operating system is then the access
 *   control; here there is no bind address to inspect, so nothing can be assumed and
 *   the safe assumption is "public".
 * - **`close()` does not close a server it does not own.** It unsubscribes from the
 *   engine, ends every event stream and stops the timers. Your server is yours.
 *
 * What has *not* changed is the reason the dashboard is a separate listener from your
 * application: mount it on a server that does not run your bot handler. Serving it
 * from inside the application it reports on means reading the dashboard shows up in
 * the dashboard, and a challenge served to your site can lock you out of the tool you
 * are using to read about it.
 *
 * `basePath` should name the path the page is served under, so the page can build its
 * own URLs. Routing accepts the path with or without that prefix, so it works whether
 * or not your framework strips the mount point before calling this.
 */
export function createDashboardHandler(handler: BotHandler, options: DashboardHandlerOptions): DashboardRequestHandler {
  const dashboard = buildDashboard(handler, options, undefined);
  const mounted = ((request: IncomingMessage, response: ServerResponse): void => dashboard.serve(request, response)) as {
    (request: IncomingMessage, response: ServerResponse): void;
    clients: number;
    close: () => Promise<void>;
  };
  Object.defineProperty(mounted, "clients", { get: () => dashboard.clients });
  mounted.close = async (): Promise<void> => {
    dashboard.close();
    return Promise.resolve();
  };
  return mounted as DashboardRequestHandler;
}

/**
 * Starts the dashboard on a listener of its own.
 *
 * Two decisions in here are load-bearing, and both are about the fact that this page
 * is a description of your detection rather than a description of your traffic.
 *
 * **It binds to loopback by default.** The page lists client addresses and, on any
 * row you click, the individual pieces of evidence with the reason each one fired.
 * That is a tuning guide for whoever is scraping you: it names the next signal to fix.
 * A dashboard reachable from the internet is a scraper's fastest route to a
 * header set that passes.
 *
 * **It refuses to bind anywhere else without an explicit decision about access.**
 * Not a warning in a log nobody reads — a `ConfigError` at startup, naming the two
 * ways out: configure `auth`, or write `auth: false` to say you have another control
 * in front of it. The failure mode this prevents is the one where a dashboard goes up
 * on 0.0.0.0 for five minutes during an incident and stays there for two years.
 *
 * It is also, deliberately, a *separate listener* from the site it reports on. Serving
 * it from inside your own application would put it behind the bot handler, where
 * watching the dashboard shows up in the dashboard, and where a challenge served to
 * your site can lock you out of the tool you are using to read about it. To serve it
 * from a listener of your own — behind your own TLS, under your own path — see
 * {@link createDashboardHandler}, which is the same dashboard without the socket.
 */
export async function startDashboard(handler: BotHandler, options: DashboardOptions = {}): Promise<DashboardServer> {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const basePath = normalizeBase(options.basePath ?? "/");
  const dashboard = buildDashboard(handler, options, host);

  const sockets = new Set<Socket>();
  const server = createServer(dashboard.serve);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      if (error.code === "EADDRINUSE") {
        reject(new ConfigError(`The dashboard cannot listen on ${host}:${port} — the port is already in use. Pass a different \`port\`, or 0 to have one chosen.`));
        return;
      }
      reject(error);
    };
    server.once("error", onError);
    server.listen(port, host, () => {
      server.removeListener("error", onError);
      // Past startup an error must not reject a settled promise or take the process
      // down; it is reported the same way every other background failure is.
      server.on("error", (error) => handler.config.onError(error, { source: "dashboard" }));
      resolve();
    });
  });

  const address = server.address();
  const boundPort = typeof address === "object" && address !== null ? address.port : port;
  let closed = false;

  return {
    url: `http://${displayHost(host)}:${boundPort}${basePath === "/" ? "/" : `${basePath}/`}`,
    port: boundPort,
    host,
    get clients(): number {
      return dashboard.clients;
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      dashboard.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        // An event stream is a connection that never ends on its own, so `close()`
        // would otherwise wait for a client to lose interest.
        for (const socket of sockets) socket.destroy();
        sockets.clear();
      });
    },
  };
}

/**
 * Reads a JSON body, bounded.
 *
 * The cap is enforced while reading rather than after: a body that arrives in
 * gigabyte-shaped chunks must not be buffered first and rejected second.
 */
async function readJson(request: IncomingMessage): Promise<{ value: unknown } | { error: string }> {
  // Insisting on JSON is a second lock on the same door `isSameOrigin` guards, and it
  // is the one that does not depend on a header the client chose to send. An HTML
  // form can only post three media types — urlencoded, multipart and text/plain — and
  // none of them is this one. Anything else a browser sends has to ask permission
  // first, and this server answers no preflight, so permission never arrives.
  const mediaType = (headerValue(request, "content-type") ?? "").split(";", 1)[0]?.trim() ?? "";
  if (mediaType !== "application/json") {
    return { error: `Expected content-type: application/json${mediaType === "" ? ", and none was sent" : `, got "${mediaType}"`}.` };
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return { error: `Body larger than ${MAX_BODY_BYTES} bytes.` };
    chunks.push(buffer);
  }
  if (size === 0) return { error: "Empty body. Send { rules: [...] } or { preset: \"protect-content\" }." };
  try {
    return { value: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
  } catch (error) {
    return { error: `Body is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * Turns a submitted document into rules.
 *
 * Accepts either a rule list or the name of a shipped preset — previewing "what would
 * `protect-data` have done to my traffic?" is the question people ask before adopting
 * one, and answering it from the traffic they actually have beats answering it from
 * the documentation.
 */
function candidateRules(body: unknown): { rules: Rule[]; warnings: string[] } {
  if (typeof body !== "object" || body === null) throw new ConfigError("Expected an object with `rules` or `preset`.");

  const document = body as { rules?: unknown; preset?: unknown };

  if (typeof document.preset === "string") {
    const preset = PRESETS[document.preset as PresetName];
    if (preset === undefined) throw new ConfigError(`Unknown preset "${document.preset}". Available: ${Object.keys(PRESETS).join(", ")}.`);
    const rules = preset();
    return { rules, warnings: validateRules(rules) };
  }

  if (!Array.isArray(document.rules)) throw new ConfigError("Expected `rules` to be an array of rule objects.");
  const rules = document.rules as Rule[];
  // Throws on anything structurally wrong; returns the survivable complaints.
  const warnings = validateRules(rules);
  for (const rule of rules) {
    if (typeof rule.match === "function") throw new ConfigError(`Rule "${rule.id}" has a function match, which cannot arrive over HTTP.`);
  }
  return { rules, warnings };
}

/** A request header as a single trimmed, lowercased value. Node hands back an array for headers that may repeat. */
function headerValue(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  if (value === undefined) return undefined;
  return (Array.isArray(value) ? value[0] : value)?.trim().toLowerCase();
}

/** A host with its port removed, in both the bare and the bracketed-IPv6 form. */
function stripPort(host: string): string {
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end === -1 ? host : host.slice(0, end + 1);
  }
  const colon = host.lastIndexOf(":");
  if (colon === -1) return host;
  // Only a numeric tail is a port. A bare IPv6 address is not legal in a `Host`
  // header, but splitting one on its last colon would silently mangle it.
  return /^\d+$/.test(host.slice(colon + 1)) ? host.slice(0, colon) : host;
}

/**
 * Host names this server will answer to, or `undefined` when it will answer to any.
 *
 * Scoped to the one attack it exists for. A dashboard on loopback is reachable by any
 * page the operator visits, if that page's own domain resolves to 127.0.0.1 — and
 * then the browser calls it *same-origin*, so `isSameOrigin` waves it through and the
 * feed is readable. Refusing a `Host` the operator never wrote breaks the rebind,
 * because the name the attacker needs sent is not on the list.
 *
 * A public bind returns `undefined` on purpose: rebinding buys nothing against an
 * address the attacker can already reach directly, and enforcing a host list there
 * would break every reverse proxy that fronts this with a real domain name.
 */
function resolveAllowedHosts(host: string, extra: readonly string[] | undefined): Set<string> | undefined {
  if (extra?.includes("*")) return undefined;
  if (!LOOPBACK_HOSTS.has(host)) return undefined;
  const allowed = new Set(["localhost", "127.0.0.1", "[::1]", "::1", stripPort(host).toLowerCase()]);
  for (const entry of extra ?? []) allowed.add(stripPort(entry).toLowerCase());
  return allowed;
}

function hostAllowed(request: IncomingMessage, allowed: ReadonlySet<string> | undefined): boolean {
  if (allowed === undefined) return true;
  const host = headerValue(request, "host");
  // HTTP/1.1 requires a `Host`; HTTP/2 gives Node one synthesised from `:authority`.
  // Nothing legitimate arrives without it.
  if (host === undefined) return false;
  return allowed.has(stripPort(host));
}

/**
 * Whether a state-changing request came from this dashboard's own page.
 *
 * Two signals, in order of how much they can be trusted.
 *
 * `Sec-Fetch-Site` is attached by the browser and is on the forbidden-header list, so
 * script cannot set or remove it. When it is there it decides the question outright:
 * `same-origin` is the page talking to its own server and `none` is someone typing
 * the address, while `same-site` and `cross-site` are, by definition, another page.
 *
 * `Origin` is the fallback for clients that send no fetch metadata. Its *absence* has
 * to be read as allow — curl, a deploy script and a health check all omit it — which
 * is exactly why it cannot be the only check and runs second. When it is present it
 * must name this same server; a sandboxed frame's literal `null` parses as no URL at
 * all and is refused.
 */
function isSameOrigin(request: IncomingMessage): boolean {
  const site = headerValue(request, "sec-fetch-site");
  if (site !== undefined) return site === "same-origin" || site === "none";

  const origin = headerValue(request, "origin");
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === headerValue(request, "host");
  } catch {
    return false;
  }
}

/**
 * Answers a caller this dashboard will not serve.
 *
 * One function for all three pre-routing refusals — bad host, cross-site write, failed
 * auth — because the moment they differ from each other they become an oracle: a probe
 * that can tell "wrong host" from "wrong password" has learned that a password exists.
 * Under the default they *do* differ, deliberately, because the likelier reader is an
 * operator debugging their own deployment and three distinct statuses are three
 * distinct diagnoses. Concealment is the thing you opt into, not the thing you get.
 *
 * `honest` is that default, passed as a thunk so the header work behind it is skipped
 * entirely when the answer is going to be a dropped connection.
 */
function refuse(request: IncomingMessage, response: ServerResponse, refusal: DashboardRefusal, honest: () => void): void {
  if (refusal === "unauthorized") {
    honest();
    return;
  }
  if (refusal === "close") {
    // No status line, no headers, nothing to fingerprint. `destroy` rather than `end`
    // so no bytes are written at all.
    request.socket.destroy();
    return;
  }
  if (refusal === "not-found") {
    // Byte-identical to the 404 for an unknown path — see `serve`. If these two ever
    // drift apart the concealment is gone, because the difference is the signal.
    send(response, 404, "text/plain; charset=utf-8", "404 not found\n");
    return;
  }
  response.writeHead(refusal.status ?? 302, { ...SECURITY_HEADERS, location: refusal.redirect });
  response.end();
}

/**
 * Checks a refusal mode against the authentication it has to coexist with.
 *
 * The combination this exists to catch is Basic auth with a silent refusal. A browser
 * prompts for a password because a `401` told it to; answer `404` or drop the
 * connection and no prompt ever appears, so there is no way to supply the credential
 * the server is waiting for. That is not a hardened dashboard, it is a locked one, and
 * it fails at the moment someone needs it rather than at startup.
 */
/**
 * A range update, read as an add or a remove against what is there now.
 *
 * Add-and-remove rather than "here is the new list", because the page is not the owner
 * of these sets: they come from configuration, from a crawler's published ranges, from
 * whatever else has written to them since boot. A dashboard that submitted a whole list
 * would silently discard anything added between the read and the write.
 */
function rangeUpdate(body: unknown, handler: BotHandler): { name: string; entries: string[] } {
  const payload = body as { name?: unknown; add?: unknown; remove?: unknown } | null;
  const name = typeof payload?.name === "string" ? payload.name.trim() : "";
  if (name === "" || name.length > 100) throw new ConfigError("Expected `name` to be the range set to update.");

  const add = Array.isArray(payload?.add) ? payload.add.filter((entry): entry is string => typeof entry === "string") : [];
  const remove = new Set(Array.isArray(payload?.remove) ? payload.remove.filter((entry): entry is string => typeof entry === "string") : []);
  if (add.length === 0 && remove.size === 0) throw new ConfigError("Expected `add` or `remove` to name at least one address or CIDR.");

  const current = handler.rangeEntries(name) ?? [];
  const entries = current.filter((entry) => !remove.has(entry));
  for (const entry of add) if (!entries.includes(entry)) entries.push(entry.trim());
  return { name, entries };
}

/** Host names a mounted dashboard answers to: whatever was configured, or anything. */
function resolveMountedHosts(extra: readonly string[] | undefined): Set<string> | undefined {
  // Nothing to compare a default against. The server that owns the socket knows which
  // names reach it; this one does not, and inventing a list would break every mount
  // that is doing the ordinary thing.
  if (extra === undefined || extra.length === 0 || extra.includes("*")) return undefined;
  return new Set(extra.map((name) => stripPort(name).toLowerCase()));
}

/** The client allowlist, refused at startup rather than at the moment somebody is locked out. */
function validateClients(entries: readonly string[]): IpRangeSet {
  const set = new IpRangeSet(entries);
  if (set.invalid.length > 0) {
    throw new ConfigError(`\`allowedClients\` contains ${set.invalid.join(", ")}, which are not addresses or CIDRs. Nothing would have been able to reach this dashboard.`);
  }
  return set;
}

/**
 * Slowing down a wrong credential.
 *
 * Comparing both halves in constant time defeats a timing attack and does nothing at
 * all about the obvious attack, which is trying again. This is the other half: after a
 * few failures from one address the next attempt is refused outright, for a delay that
 * doubles each time.
 *
 * Keyed by address in a bounded LRU, so the memory this can be made to consume is
 * fixed — an attacker with a large address pool evicts their own entries rather than
 * this process's heap. A success clears the count, so somebody who mistyped a password
 * four times and then got it right is not left waiting.
 */
interface AuthThrottle {
  /** Milliseconds remaining on a lockout, or `undefined` when the address may try. */
  check: (address: string) => number | undefined;
  failed: (address: string) => void;
  succeeded: (address: string) => void;
}

const NO_THROTTLE: AuthThrottle = { check: () => undefined, failed: () => {}, succeeded: () => {} };

function createAuthThrottle(options: DashboardOptions["authThrottle"], handler: BotHandler): AuthThrottle {
  if (options === false) return NO_THROTTLE;
  const maxAttempts = Math.max(1, options?.maxAttempts ?? 5);
  const lockoutMs = Math.max(100, options?.lockoutMs ?? 1_000);
  const maxLockoutMs = Math.max(lockoutMs, options?.maxLockoutMs ?? 5 * 60_000);
  // The TTL is the longest a lockout can last: past that there is nothing to remember.
  const attempts = new TtlLru<{ failures: number; until: number }>(10_000, maxLockoutMs * 2, handler.config.clock);

  return {
    check(address) {
      const now = handler.config.clock.now();
      const record = attempts.get(address);
      if (record === undefined || record.until <= now) return undefined;
      return record.until - now;
    },
    failed(address) {
      const now = handler.config.clock.now();
      const record = attempts.get(address) ?? { failures: 0, until: 0 };
      record.failures++;
      if (record.failures >= maxAttempts) {
        // Doubling from the first lockout, so a determined prober spends exponentially
        // more time for linearly more guesses.
        const delay = Math.min(maxLockoutMs, lockoutMs * 2 ** (record.failures - maxAttempts));
        record.until = now + delay;
      }
      attempts.set(address, record);
    },
    succeeded(address) {
      attempts.delete(address);
    },
  };
}

/** Every section on, unless the caller said otherwise. A dashboard is a whole tool by default. */
function resolveSections(sections: DashboardSections | undefined): Required<DashboardSections> {
  const on = (value: boolean | undefined): boolean => value !== false;
  const policy = on(sections?.policy);
  const actors = on(sections?.actors);
  const feed = on(sections?.feed);
  return {
    feed,
    evidence: on(sections?.evidence),
    actors,
    // The Actors screen is the registry's view of the same subject, so it follows the
    // section that decides whether actors are a subject at all.
    registry: actors && on(sections?.registry),
    // The tester lives on the Live tab and returns an assessment, so it needs both.
    tester: feed && on(sections?.tester),
    statistics: on(sections?.statistics),
    audit: on(sections?.audit),
    notices: on(sections?.notices),
    changes: on(sections?.changes),
    policy,
    // Three sections that live inside the Policy tab, so switching that off takes them
    // with it rather than leaving them addressable by an endpoint nothing renders.
    guard: policy && on(sections?.guard),
    robots: policy && on(sections?.robots),
    ranges: policy && on(sections?.ranges),
  };
}

/**
 * The guard fields out of a submitted body, and nothing else.
 *
 * Reading named fields rather than passing the object through is what stops a
 * `{ rules: [...] }` smuggled into a guard request from meaning anything, and what
 * stops a future field on `GuardSettings` from being settable here by accident. Types
 * are checked by `updateGuard`; this only decides which keys exist.
 */
function guardSettings(body: unknown): Partial<GuardSettings> & { suspectThreshold?: number } {
  if (body === null || typeof body !== "object") return {};
  const source = body as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of ["falsePositivePolicy", "fallbackAction", "defaultAction", "terminalScoreThreshold", "suspectThreshold"]) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out as Partial<GuardSettings> & { suspectThreshold?: number };
}

function validateRefusal(refusal: DashboardRefusal, auth: DashboardAuth): DashboardRefusal {
  if (typeof refusal === "object") {
    if (typeof refusal.redirect !== "string" || refusal.redirect.length === 0) {
      throw new ConfigError("The dashboard's `refusal.redirect` needs a URL or a path to send people to.");
    }
    return refusal;
  }

  if ((refusal === "not-found" || refusal === "close") && auth !== false && "username" in auth) {
    throw new ConfigError(
      `The dashboard is set to answer "${refusal}" and to authenticate with basic auth, which cannot both work: a browser prompts for a password only when a 401 asks it to, ` +
        `so nobody would ever be able to log in. Use \`auth: { token }\` or \`auth: { authorize }\` with a link people already hold, or leave \`refusal\` at "unauthorized".`,
    );
  }
  return refusal;
}

/**
 * Whether the policy editor may be enabled at all.
 *
 * An editor with no authentication on an address other people can reach is not a
 * feature, it is a stranger's bot policy — so that combination is refused at startup
 * rather than warned about.
 */
function validateEditing(requested: boolean, auth: DashboardAuth, host: string, control: string): boolean {
  if (!requested) return false;
  if (auth === false && !LOOPBACK_HOSTS.has(host)) {
    throw new ConfigError(
      `The dashboard's editor was enabled with \`auth: false\` on ${host}, which would let anyone who can reach it rewrite your bot policy. ` +
        `Configure \`auth\`, or bind loopback, or leave \`${control}\` off.`,
    );
  }
  return true;
}

/**
 * Headers on every response.
 *
 * `no-store` because a dashboard cached anywhere is an evidence trail cached
 * anywhere; `frame-ancestors`/`DENY` because a page with a reset button has no
 * business in somebody else's iframe; `no-referrer` because the path can carry a
 * token when the query form of auth is used.
 */
const SECURITY_HEADERS: Record<string, string> = {
  "cache-control": "no-store, max-age=0",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
};

/** Every `/api` failure is JSON, so a caller that parses one response can parse them all. */
function sendError(response: ServerResponse, status: number, message: string): void {
  send(response, status, "application/json; charset=utf-8", JSON.stringify({ error: message }));
}

function send(response: ServerResponse, status: number, contentType: string, body: string): void {
  response.writeHead(status, { ...SECURITY_HEADERS, "content-type": contentType });
  response.end(body);
}

/**
 * One server-sent event.
 *
 * The `id:` is what a browser hands back as `Last-Event-ID` when it reconnects, so it
 * goes on the frames a viewer can miss and on nothing else: a `stats` frame carrying
 * one would overwrite the viewer's place in the feed with a number that does not name
 * a place in it.
 */
function frameFor(event: string, payload: unknown, id?: number): string {
  // A newline inside the JSON would terminate the frame early; `JSON.stringify`
  // escapes them, so a single `data:` line is always well-formed.
  const head = id === undefined ? "" : `id: ${id}\n`;
  return `${head}event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

/** A `Last-Event-ID` is whatever the client chose to send. Only a plain counter is one. */
function cursorOf(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d{1,15}$/.test(value.trim())) return undefined;
  return Number(value.trim());
}

/** Normalises a mount path to `/` or `/segment` with no trailing slash. */
function normalizeBase(basePath: string): string {
  const trimmed = basePath.trim();
  if (trimmed === "" || trimmed === "/") return "/";
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withSlash.endsWith("/") ? withSlash.slice(0, -1) : withSlash;
}

/** The route within the mount, or `undefined` when the request is for something else entirely. */
function routeOf(pathname: string, basePath: string, stripped: boolean): string | undefined {
  if (basePath === "/") return pathname === "" ? "/" : pathname;
  if (pathname === basePath) return "/";
  if (pathname.startsWith(`${basePath}/`)) {
    const rest = pathname.slice(basePath.length);
    return rest === "/" ? "/" : rest;
  }
  // The prefix is not there. On a listener of its own that is a request for something
  // else, and a dashboard mounted under `/_bots` answering at `/` would be a surprise
  // — so it is a 404, which is what it has always been. Mounted, it is far more likely
  // that the surrounding router removed the prefix before calling us.
  return stripped ? (pathname === "" ? "/" : pathname) : undefined;
}

function displayHost(host: string): string {
  if (host === "0.0.0.0" || host === "::" || host === "") return "localhost";
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

/**
 * Checks the configuration before anything listens.
 *
 * Every branch here fails at startup rather than at request time. A dashboard whose
 * access control is wrong is not a thing you want to discover from its traffic.
 */
function validateAuth(auth: DashboardAuth | undefined, host: string): DashboardAuth {
  const isPublic = !LOOPBACK_HOSTS.has(host);

  if (auth === undefined) {
    if (host === MOUNTED_HOST) {
      throw new ConfigError(
        "A mounted dashboard needs `auth`. With no bind address of its own there is nothing to inspect and nothing to assume, " +
          "and the page shows client addresses and the individual evidence behind every verdict — which is a tuning guide for whoever is scraping you. " +
          "Configure `auth: { username, password }`, `auth: { token }` or `auth: { authorize }`; " +
          "or write `auth: false` to state that the server you are mounting it on already authenticates.",
      );
    }
    if (isPublic) {
      throw new ConfigError(
        `The dashboard is set to bind ${host}, which publishes it beyond this machine, and no \`auth\` was configured. ` +
          `It shows client addresses and the individual evidence behind every verdict — which is a tuning guide for whoever is scraping you. ` +
          `Configure \`auth: { username, password }\`, \`auth: { token }\` or \`auth: { authorize }\`; keep the default \`host: "127.0.0.1"\`; ` +
          `or write \`auth: false\` to state that something in front of it already authenticates.`,
      );
    }
    return false;
  }

  if (auth === false) return false;

  if ("username" in auth) {
    if (auth.username.length === 0 || auth.password.length === 0) {
      throw new ConfigError("The dashboard's basic auth needs a non-empty username and password. An empty credential is an open dashboard with a login prompt on it.");
    }
    return auth;
  }

  if ("token" in auth) {
    // Short enough to guess is the same as no token at all, and this endpoint invites
    // exactly the sort of client that would try.
    if (auth.token.length < 16) {
      throw new ConfigError(`The dashboard's \`token\` is ${auth.token.length} characters. Use at least 16 from a random source — this is a bearer credential on a page describing your detection.`);
    }
    return auth;
  }

  return auth;
}

/**
 * May this request touch the dashboard, and who is it?
 *
 * Two answers rather than one, because the second is what an audit trail needs and the
 * page has no other way to learn it. A basic credential names itself; a custom
 * `authorize` may return a string instead of `true`; a bearer token names nobody, which
 * is a property of tokens and not something to paper over.
 *
 * The identity is used for attribution only. It is never a permission: what a viewer
 * may do is decided by `controls`, which belongs to the listener.
 */
async function authorize(request: IncomingMessage, url: URL, auth: DashboardAuth): Promise<{ ok: boolean; by?: string | undefined }> {
  if (auth === false) return { ok: true };

  if ("authorize" in auth) {
    try {
      const answer = await auth.authorize(request);
      // A string is an identity *and* an admission; an empty one is neither, so a
      // lookup returning "" for "no such user" fails closed.
      if (typeof answer === "string") return answer === "" ? { ok: false } : { ok: true, by: answer };
      return { ok: answer === true };
    } catch {
      // A throwing check is a failed check. Never an open door.
      return { ok: false };
    }
  }

  const header = request.headers.authorization ?? "";

  if ("token" in auth) {
    const bearer = header.startsWith("Bearer ") ? header.slice(7) : undefined;
    const supplied = bearer ?? url.searchParams.get("token") ?? "";
    return { ok: constantTimeEqual(supplied, auth.token) };
  }

  if (!header.startsWith("Basic ")) return { ok: false };
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator === -1) return { ok: false };
  // Both halves are compared, and neither comparison short-circuits the other: a
  // wrong username must not be distinguishable from a wrong password by timing.
  const userOk = constantTimeEqual(decoded.slice(0, separator), auth.username);
  const passOk = constantTimeEqual(decoded.slice(separator + 1), auth.password);
  return userOk && passOk ? { ok: true, by: auth.username } : { ok: false };
}
