import { CREDENTIAL_HEADERS } from "../notify/redact.js";
import { maskAddresses, networkKey } from "../internal/ip.js";
import type { BotHandler } from "../core.js";
import type { DashboardChange, DashboardEntry, DashboardNotice, DashboardRedaction } from "./types.js";
import type { Assessment, RequestFacts } from "../types.js";
import type { Decision } from "../policy/types.js";

/** Hard ceiling on the ring, whatever the caller asks for. Every entry is attacker-shaped data. */
const MAX_FEED_LIMIT = 5000;
/** Headers kept per request, and the longest value shown. Both are attacker-chosen. */
const MAX_HEADERS = 40;
const MAX_HEADER_VALUE = 300;
const REDACTED = "[redacted]";
const STRIPPED = new Set(CREDENTIAL_HEADERS);

/**
 * The live feed: a bounded ring of recent assessments, and whoever is watching.
 *
 * Two engine events describe one request. `assess()` emits `assessment`; `decide()`
 * emits `decision` a moment later, and a caller who only ever assesses — a monitor
 * deployment, a log replay — never emits the second one at all. Showing a row per
 * event would double every request; waiting for the decision would show nothing at
 * all in monitor mode.
 *
 * So an entry is created when the assessment lands and *published* one turn of the
 * event loop later, by which time the decision has usually arrived and filled in the
 * action. A decision that arrives after publication sends a small update frame
 * instead. The result is one row per request, whichever way the engine is being used.
 */
/** How the stream is throttled. See {@link DashboardOptions.maxEventsPerSecond}. */
export interface FeedLimits {
  maxEventsPerSecond: number;
  /** Oldest an entry may be before it is evicted, whatever the count. `0` disables it. */
  ttlMs: number;
}

export class DashboardFeed {
  private readonly entries: DashboardEntry[] = [];
  private readonly pending = new Map<string, DashboardEntry>();
  /**
   * The frame each entry was last written on, by request id.
   *
   * Kept beside the ring rather than on the entry because it describes the *stream*,
   * not the request, and a viewer has no use for it. It is what makes a resume exact:
   * see {@link since}.
   */
  private readonly frames = new Map<string, number>();
  private readonly subscribers = new Set<(event: string, entry: DashboardEntry | undefined, frame: number) => void>();
  private readonly unsubscribe: Array<() => void> = [];
  private readonly limit: number;
  private readonly maskIp: boolean;
  private readonly truncateUserAgent: boolean;
  private readonly maskQuery: boolean;
  private readonly showHeaders: boolean;
  private sequence = 0;
  /**
   * A monotonic counter over everything ever *sent*, which is a different thing from
   * {@link DashboardEntry.seq}.
   *
   * `seq` numbers requests; this numbers frames. One request can be sent twice — once
   * when it is assessed and again when the decision lands — and a viewer that
   * reconnects between the two has to be told about the second. Numbering requests
   * cannot express that; numbering frames can, so this is what rides on the SSE `id:`
   * field and what {@link since} is asked about. It never resets, including across
   * {@link clear}, because a cursor a viewer is still holding must never point into a
   * reused range.
   */
  private frame = 0;
  private closed = false;
  /**
   * The stream's rate cap, and what it has cost.
   *
   * The cap is on *publishing*, never on recording. A thinned stream is a cosmetic
   * decision about how much a browser is asked to render; a thinned ring would be a
   * silent change to what `previewPolicy` runs over, which is the one thing on this
   * page that has to be exact.
   */
  private readonly maxPerSecond: number;
  /**
   * How long an entry may sit here. See {@link DashboardOptions.feedTtlMs}.
   *
   * The ring's other bound is a count, and a count is the wrong shape for this
   * question: on a quiet service five hundred requests can be a fortnight, and every
   * one of them holds an address, a User-Agent and a header set belonging to somebody.
   * "We keep the last five hundred requests" is a capacity statement; "we keep nothing
   * older than an hour" is a promise you can make to a person.
   */
  private readonly ttlMs: number;
  private windowStart = 0;
  private publishedThisSecond = 0;
  private skippedTotal = 0;

  constructor(handler: BotHandler, limit: number, redact: DashboardRedaction = {}, limits: FeedLimits = { maxEventsPerSecond: 0, ttlMs: 0 }) {
    this.limit = Math.max(1, Math.min(MAX_FEED_LIMIT, Math.floor(limit)));
    this.maxPerSecond = Math.max(0, Math.floor(limits.maxEventsPerSecond));
    this.ttlMs = Math.max(0, Math.floor(limits.ttlMs));
    this.maskIp = redact.maskIp === true;
    this.truncateUserAgent = redact.truncateUserAgent === true;
    this.maskQuery = redact.maskQuery !== false;
    this.showHeaders = redact.headers !== false;

    this.unsubscribe.push(handler.on("assessment", (assessment) => this.record(assessment)));
    this.unsubscribe.push(handler.on("decision", ({ assessment, decision }) => this.decide(assessment, decision)));
  }

  get size(): number {
    return this.entries.length;
  }

  /** The backlog, oldest first, so a dashboard opened late still sees the run so far. */
  backlog(): readonly DashboardEntry[] {
    return this.entries;
  }

  /**
   * Drops everything older than the TTL.
   *
   * Called when a request is recorded and on the dashboard's own timer, so the promise
   * holds on an idle process too — which is exactly the process where it matters, since
   * a busy one evicts by count long before anything reaches this age.
   */
  prune(now: number): number {
    if (this.ttlMs === 0) return 0;
    const cutoff = now - this.ttlMs;
    let expired = 0;
    while (expired < this.entries.length && (this.entries[expired] as DashboardEntry).at <= cutoff) expired++;
    if (expired === 0) return 0;
    for (const dropped of this.entries.splice(0, expired)) {
      this.pending.delete(dropped.requestId);
      this.frames.delete(dropped.requestId);
    }
    return expired;
  }

  /** The frame most recently sent. A viewer's cursor after it has been sent the backlog. */
  get cursor(): number {
    return this.frame;
  }

  /** Entries the rate cap kept off the stream since start. They are still in the ring. */
  get skipped(): number {
    return this.skippedTotal;
  }

  /**
   * Everything that has changed since a viewer's cursor, oldest change first.
   *
   * What a reconnecting browser gets instead of the whole ring. `EventSource` resends
   * the last `id:` it saw as `Last-Event-ID` without being asked, so a laptop lid, a
   * proxy timeout or a blip costs a handful of frames rather than several hundred
   * entries with their headers, evidence and actor history attached.
   *
   * `undefined` means the cursor cannot be honoured — it points before the oldest
   * frame still described by the ring, or past the newest one this server has issued
   * (a restarted process, a cleared feed) — and the caller should send the whole
   * backlog instead. Answering a stale cursor with "nothing changed" would leave a
   * viewer looking at a feed that has quietly stopped being true.
   */
  since(cursor: number): DashboardEntry[] | undefined {
    if (!Number.isFinite(cursor) || cursor < 0 || cursor > this.frame) return undefined;
    let oldest = Number.POSITIVE_INFINITY;
    for (const frame of this.frames.values()) if (frame < oldest) oldest = frame;
    // Nothing retained: any cursor is as good as any other, and there is nothing to
    // have missed.
    if (oldest === Number.POSITIVE_INFINITY) return [];
    // The ring has dropped frames the viewer never saw. It cannot know which, so it
    // is given everything.
    if (cursor < oldest - 1) return undefined;
    const changed = this.entries.filter((entry) => (this.frames.get(entry.requestId) ?? 0) > cursor);
    changed.sort((a, b) => (this.frames.get(a.requestId) ?? 0) - (this.frames.get(b.requestId) ?? 0));
    return changed;
  }

  subscribe(listener: (event: string, entry: DashboardEntry | undefined, frame: number) => void): () => void {
    this.subscribers.add(listener);
    return () => {
      this.subscribers.delete(listener);
    };
  }

  get clients(): number {
    return this.subscribers.size;
  }

  clear(): void {
    this.entries.length = 0;
    this.pending.clear();
    this.frames.clear();
    this.sequence = 0;
    this.skippedTotal = 0;
    // Every viewer, not just the one that pressed the button. Without this a second
    // browser goes on showing a feed of requests the server has forgotten, and its
    // next resume asks about frames nothing describes any more.
    this.publish("reset", undefined);
  }

  close(): void {
    this.closed = true;
    for (const off of this.unsubscribe) off();
    this.unsubscribe.length = 0;
    this.subscribers.clear();
    this.clear();
  }

  private record(assessment: Assessment): void {
    if (this.closed) return;

    this.prune(assessment.facts.timestamp);
    const entry = this.entryFor(assessment, ++this.sequence);

    this.entries.push(entry);
    if (this.entries.length > this.limit) {
      for (const dropped of this.entries.splice(0, this.entries.length - this.limit)) {
        this.pending.delete(dropped.requestId);
        this.frames.delete(dropped.requestId);
      }
    }
    this.pending.set(entry.requestId, entry);

    // `setImmediate`, not `queueMicrotask`. The decision is emitted from the
    // continuation of an awaited `assess()`, which is itself a microtask — so a
    // microtask scheduled here would run *before* it and publish every row with no
    // action on it. A check phase callback runs after the queue drains, which is
    // exactly the boundary we need. Unreffed, so a pending publish never keeps a
    // process alive on its own.
    const timer = setImmediate(() => {
      this.pending.delete(entry.requestId);
      if (this.allowedToPublish(entry.at)) this.publish("entry", entry);
    });
    timer.unref();
  }

  /**
   * One assessment as the page shows it.
   *
   * Split out of `record` because the request tester needs exactly this and must not go
   * anywhere near the ring: a dry run is not traffic, so it is shaped like a feed entry
   * and then handed straight back to whoever asked, never stored and never published.
   */
  entryFor(assessment: Assessment, seq: number): DashboardEntry {
    return {
      seq,
      requestId: assessment.requestId,
      at: assessment.facts.timestamp,
      method: assessment.facts.method,
      path: assessment.facts.path.slice(0, 200),
      actor: this.maskIp ? (networkKey(assessment.actor.key) ?? assessment.actor.key) : assessment.actor.key,
      userAgent: this.userAgent(assessment),
      verdict: assessment.verdict,
      botClass: assessment.botClass,
      identity: assessment.identity,
      score: assessment.score,
      certain: assessment.certain,
      durationMs: Number(assessment.durationMs.toFixed(3)),
      bypass: assessment.bypass,
      // Shadowed findings ride in the same list, flagged. They belong on the same screen
      // as the evidence that did decide — the comparison is the point — and the flag is
      // what stops the page, and `previewAssessment`, from treating them as such.
      evidence: [...assessment.evidence, ...assessment.humanEvidence, ...assessment.shadowEvidence].map((item) => ({
        detector: item.detector,
        summary: item.summary,
        certainty: item.certainty,
        direction: item.direction,
        ...(item.shadow === true ? { shadow: true as const } : {}),
        family: item.family,
        deterministicBasis: item.deterministicBasis,
        identity: item.identity,
        // The category rides along because the policy matcher reads it, and the
        // preview re-decides requests from these entries alone.
        category: typeof item.metadata?.["category"] === "string" ? (item.metadata["category"] as string) : undefined,
        weight: item.weight,
      })),
      ...(assessment.shadowVerdict === undefined ? {} : { shadowVerdict: assessment.shadowVerdict }),
      failures: assessment.failures.map((failure) => ({ detector: failure.detector, reason: failure.reason, message: failure.message })),
      actorStats: {
        requests: assessment.actor.requests,
        distinctPaths: assessment.actor.distinctPaths,
        priorConfirmations: assessment.actor.priorConfirmations,
        cleared: assessment.actor.cleared,
        firstSeen: assessment.actor.firstSeen,
        sinceLastMs: assessment.actor.sinceLastMs,
      },
      query: this.query(assessment.facts),
      ...(this.showHeaders ? { headers: this.headers(assessment.facts) } : {}),
      protocol: assessment.facts.protocol,
      httpVersion: assessment.facts.httpVersion,
    };
  }

  private decide(assessment: Assessment, decision: Decision): void {
    if (this.closed) return;
    const waiting = this.pending.get(assessment.requestId);
    const entry = waiting ?? this.entries.find((candidate) => candidate.requestId === assessment.requestId);
    if (entry === undefined) return;

    entry.action = decision.action;
    entry.rule = decision.rule;
    entry.downgradedFrom = decision.downgradedFrom;
    entry.downgradeReason = decision.downgradeReason;

    // Already on screen: send the difference rather than a second row — but only if it
    // ever reached the screen. An update for an entry the rate cap dropped would put a
    // row in front of a viewer that the stream never introduced, and withholding the
    // update from one it *did* send would leave that row saying "assessed only"
    // forever. So the cap is decided once, when the entry is published, and the update
    // follows whatever was decided.
    if (waiting === undefined && this.frames.has(entry.requestId)) this.publish("update", entry);
  }

  /**
   * Whether this entry goes out on the stream.
   *
   * A plain per-second counter rather than a smoothed rate: the front of a burst is
   * the part worth seeing, so a second's whole allowance is spendable at once. What is
   * dropped is counted and reported, because a feed that thins itself silently looks
   * like traffic that stopped.
   */
  private allowedToPublish(at: number): boolean {
    if (this.maxPerSecond === 0) return true;
    const second = Math.floor(at / 1000);
    if (second !== this.windowStart) {
      this.windowStart = second;
      this.publishedThisSecond = 0;
    }
    if (this.publishedThisSecond < this.maxPerSecond) {
      this.publishedThisSecond++;
      return true;
    }
    this.skippedTotal++;
    return false;
  }

  private publish(event: string, entry: DashboardEntry | undefined): void {
    const frame = ++this.frame;
    if (entry !== undefined) this.frames.set(entry.requestId, frame);
    for (const subscriber of this.subscribers) subscriber(event, entry, frame);
  }

  /**
   * Headers in wire order, with credentials removed.
   *
   * `facts.headerOrder` is the order they arrived in and is itself a fingerprint —
   * showing them alphabetically would hide the very thing `header-order` reads. The
   * map is consulted for values, and anything in {@link CREDENTIAL_HEADERS} is
   * replaced rather than omitted, so the reader can see that a cookie was sent
   * without seeing the cookie.
   */
  private headers(facts: RequestFacts): Array<[string, string]> {
    const rows: Array<[string, string]> = [];
    const seen = new Set<string>();
    const push = (name: string): void => {
      if (seen.has(name) || rows.length >= MAX_HEADERS) return;
      seen.add(name);
      const value = facts.headers[name];
      if (value === undefined) return;
      rows.push([name, STRIPPED.has(name) ? REDACTED : value.slice(0, MAX_HEADER_VALUE)]);
    };
    for (const name of facts.headerOrder) push(name);
    // Anything the transport did not give an order for still belongs on the list.
    for (const name of Object.keys(facts.headers)) push(name);
    return rows;
  }

  private query(facts: RequestFacts): Record<string, string> {
    const query: Record<string, string> = {};
    for (const [name, value] of Object.entries(facts.query)) {
      query[name] = this.maskQuery ? REDACTED : value.slice(0, 200);
    }
    return query;
  }

  private userAgent(assessment: Assessment): string {
    const raw = assessment.facts.headers["user-agent"] ?? "";
    if (raw.length === 0) return "(no User-Agent)";
    return raw.slice(0, this.truncateUserAgent ? 48 : 160);
  }
}

/**
 * Warnings and errors the engine raised, kept for the notices panel.
 *
 * Startup warnings are the ones that matter most and the ones most easily missed:
 * `resolveConfig` collects them at construction, they go to `onWarning`, and on a
 * busy boot they scroll past. A dashboard that shows a live feed of traffic while a
 * warning saying "two rules share an id" sits unread in a log file is showing you the
 * wrong half of the picture, so the panel is seeded with those and then follows the
 * `warning` and `error` events for the life of the process.
 */
export class DashboardNotices {
  private readonly notices: DashboardNotice[] = [];
  private readonly unsubscribe: Array<() => void> = [];

  /**
   * Masks addresses in what this list shows, on a listener that masks them.
   *
   * Notices are the library's warnings, and several name a client in full —
   * `Actor "203.0.113.7" was forgotten at runtime` — because they were written for the
   * operator's logs. Shown on a dashboard configured to hide every address, they undid
   * that configuration from the notices panel. The warnings are free text from all over
   * the library, so the addresses are found by shape; see `maskAddresses`.
   */
  private readonly shown: (message: string) => string;

  constructor(
    handler: BotHandler,
    private readonly limit = 100,
    options: { maskIp?: boolean } = {},
  ) {
    this.shown = options.maskIp === true ? maskAddresses : (message) => message;
    const now = handler.config.clock.now();
    for (const message of handler.config.warnings) this.notices.push({ at: now, kind: "warning", source: "startup", message: this.shown(message) });

    this.unsubscribe.push(handler.on("warning", (message) => this.add({ at: handler.config.clock.now(), kind: "warning", message })));
    // An anomaly belongs here for the same reason a startup warning does: it is
    // something the operator needs to have seen, and it is not about any one request
    // in the feed.
    this.unsubscribe.push(
      handler.on("anomaly", (anomaly) => this.add({ at: anomaly.at, kind: anomaly.severity === "critical" ? "error" : "warning", source: `audit:${anomaly.id}`, message: anomaly.summary })),
    );
    this.unsubscribe.push(
      handler.on("error", ({ error, source }) =>
        this.add({ at: handler.config.clock.now(), kind: "error", source, message: error instanceof Error ? error.message : String(error) }),
      ),
    );
  }

  list(): readonly DashboardNotice[] {
    return this.notices;
  }

  close(): void {
    for (const off of this.unsubscribe) off();
    this.unsubscribe.length = 0;
  }

  private add(notice: DashboardNotice): void {
    notice = { ...notice, message: this.shown(notice.message) };
    this.notices.push(notice);
    if (this.notices.length > this.limit) this.notices.splice(0, this.notices.length - this.limit);
  }
}

/**
 * Runtime changes, kept for the timeline markers.
 *
 * The traffic chart draws what happened; this is what somebody *did*, on the same axis.
 * A preview says "44 of 151 requests would be treated differently", which is a
 * prediction — and until the moment of the change is drawn against the traffic either
 * side of it, nothing on the page ever tells you whether the prediction held.
 *
 * Deliberately separate from the notices, which are the engine talking about itself.
 * These are people talking about the engine, and they are the shorter and more
 * interesting list.
 */
export class DashboardChanges {
  private readonly changes: DashboardChange[] = [];
  private readonly unsubscribe: Array<() => void> = [];
  private readonly redact: (text: string) => string;

  constructor(
    handler: BotHandler,
    private readonly limit = 50,
    options: { maskIp?: boolean } = {},
  ) {
    const now = (): number => handler.config.clock.now();
    // The timeline names the actor a change was made to, and on a listener that masks
    // addresses it has to name it the way the feed does. It did not: forgetting or
    // clearing an actor from anywhere — another listener, or code — put its full address
    // on the timeline of a dashboard configured to show nobody's. Acting is switched off
    // on a masked listener, which is presumably why this was missed; being told about
    // actions is not.
    const shown = (key: string): string => (options.maskIp === true ? (networkKey(key) ?? key) : key);
    // And any address written in the text around it — a name an operator typed can quote
    // one as easily as a warning can.
    this.redact = options.maskIp === true ? maskAddresses : (text) => text;
    this.unsubscribe.push(
      handler.on("policy-change", ({ rules, by }) => this.add({ at: now(), kind: "policy", summary: `${rules.length} rule(s) applied`, by })),
      handler.on("guard-change", ({ before, after, by }) =>
        this.add({
          at: now(),
          kind: "guard",
          summary:
            before.falsePositivePolicy === after.falsePositivePolicy
              ? `guard re-applied (${after.falsePositivePolicy})`
              : `guard ${before.falsePositivePolicy} → ${after.falsePositivePolicy}`,
          by,
        }),
      ),
      handler.on("range-change", ({ name, size, by }) => this.add({ at: now(), kind: "range", summary: `${name}: ${size} entr${size === 1 ? "y" : "ies"}`, by })),
      handler.on("actor-change", ({ key, action, label, by }) =>
        this.add({
          at: now(),
          kind: "actor",
          summary:
            action === "forget"
              ? `${shown(key)} forgotten`
              : action === "clear"
                ? `${shown(key)} cleared as human`
                : label === undefined
                  ? `${shown(key)} unlabelled`
                  : `${shown(key)} labelled "${label}"`,
          by,
        }),
      ),
    );
  }

  list(): readonly DashboardChange[] {
    return this.changes;
  }

  close(): void {
    for (const off of this.unsubscribe) off();
    this.unsubscribe.length = 0;
  }

  private add(change: DashboardChange): void {
    change = { ...change, summary: this.redact(change.summary) };
    this.changes.push(change);
    if (this.changes.length > this.limit) this.changes.splice(0, this.changes.length - this.limit);
  }
}
