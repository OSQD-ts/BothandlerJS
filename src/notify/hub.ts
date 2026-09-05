import { TtlLru } from "../internal/lru.js";
import { redactEvent } from "./redact.js";
import { systemClock } from "../internal/clock.js";
import type { Clock } from "../internal/clock.js";
import type { RedactionOptions } from "./redact.js";
import type { BotEvent, BotEventType, NotifyFilter, Notifier } from "./types.js";

export interface NotificationOptions {
  /** Where events go. Empty means notifications are off. */
  sinks?: readonly Notifier[];
  filter?: NotifyFilter;
  /** Redaction applied before an event leaves the process. `false` disables it. */
  redaction?: RedactionOptions | false;
  /**
   * Suppress repeats of the same actor and verdict inside this window, ms. Default
   * 60000. A scraper generates thousands of identical events a minute; without this
   * the first thing your bot detection breaks is your alerting.
   */
  dedupeWindowMs?: number;
  /**
   * Hard ceiling on events delivered per dedupe window across all actors. Default
   * 200. The backstop for the case dedupe cannot help with — a distributed scrape
   * from ten thousand addresses, where every event is genuinely distinct.
   */
  maxPerWindow?: number;
  /** Called when a sink throws. Wire it to your logs. */
  onError?: (error: unknown, sinkId: string) => void;
  clock?: Clock;
}

const DEFAULT_TYPES: readonly BotEventType[] = ["action", "downgrade", "error"];

/**
 * Fans events out to sinks, with the two properties that decide whether a
 * notification system is an asset or a liability under load.
 *
 * **It never blocks a request.** `emit` returns immediately; delivery happens on its
 * own. A wedged Slack webhook slows down nothing.
 *
 * **It has a ceiling.** Bot traffic arrives in volumes that ordinary alerting was
 * not built for, and an unbounded notifier turns a scrape into an outage of your own
 * paging system. Repeats of the same actor and verdict collapse into one event per
 * window, and a global cap catches distributed traffic where every event is distinct.
 * Suppressed counts are reported when the window rolls, so a quiet channel is never
 * mistaken for quiet traffic.
 */
export class NotificationHub {
  private readonly sinks: readonly Notifier[];
  private readonly types: Set<BotEventType>;
  private readonly minScore: number;
  private readonly certainOnly: boolean;
  private readonly redaction: RedactionOptions | false;
  private readonly dedupe: TtlLru<true>;
  private readonly dedupeWindowMs: number;
  private readonly maxPerWindow: number;
  private readonly clock: Clock;
  private readonly onError: (error: unknown, sinkId: string) => void;

  private windowStart = 0;
  private windowCount = 0;
  private suppressed = 0;

  constructor(options: NotificationOptions = {}) {
    this.sinks = options.sinks ?? [];
    this.types = new Set(options.filter?.types ?? DEFAULT_TYPES);
    this.minScore = options.filter?.minScore ?? 60;
    this.certainOnly = options.filter?.certainOnly ?? false;
    this.redaction = options.redaction ?? {};
    this.dedupeWindowMs = options.dedupeWindowMs ?? 60_000;
    this.maxPerWindow = options.maxPerWindow ?? 200;
    this.clock = options.clock ?? systemClock;
    this.onError = options.onError ?? (() => {});
    this.dedupe = new TtlLru<true>(10_000, this.dedupeWindowMs, this.clock);
    this.windowStart = this.clock.now();
  }

  get enabled(): boolean {
    return this.sinks.length > 0;
  }

  /** Queues an event. Returns immediately; never throws. */
  emit(event: BotEvent): void {
    if (this.sinks.length === 0) return;
    if (!this.shouldDeliver(event)) return;

    this.dispatch(event);
  }

  /**
   * Redacts and fans out. The only way an event reaches a sink.
   *
   * Made the single path because it was not one: the suppression summary built its own
   * fan-out loop and sent `sample.assessment` straight through, so every time a window
   * rolled under load — precisely when bot traffic is heaviest — one request's raw
   * address, cookies and query string went to the sink in the clear, beside the
   * properly masked events it was summarising.
   */
  private dispatch(event: BotEvent): void {
    const payload = this.redaction === false ? event : redactEvent(event, this.redaction);
    for (const sink of this.sinks) {
      try {
        const result = sink.notify(payload);
        // A sink may be sync or async. Either way its failure is reported and
        // contained, and an async rejection never escapes as an unhandled one.
        if (result instanceof Promise) result.catch((error: unknown) => this.onError(error, sink.id));
      } catch (error) {
        this.onError(error, sink.id);
      }
    }
  }

  private shouldDeliver(event: BotEvent): boolean {
    if (!this.types.has(event.type)) return false;
    if (event.type === "detection" && event.assessment !== undefined) {
      if (this.certainOnly && !event.assessment.certain) return false;
      if (!event.assessment.certain && event.assessment.score < this.minScore) return false;
    }

    const now = this.clock.now();
    if (now - this.windowStart >= this.dedupeWindowMs) {
      const dropped = this.suppressed;
      this.windowStart = now;
      this.windowCount = 0;
      this.suppressed = 0;
      // Report what the window hid, so an operator can tell "nothing happened" from
      // "far too much happened".
      if (dropped > 0) this.deliverSummary(dropped, event);
    }

    // `error` events bypass deduplication: two different failures with the same
    // shape are two different problems, and losing the second is how an outage
    // becomes invisible. `anomaly` bypasses it too — the audit has a cooldown of its
    // own, so anything that reaches here has already been judged worth saying.
    if (event.type !== "error" && event.type !== "anomaly" && event.assessment !== undefined) {
      const key = `${event.type}:${event.assessment.actor.key}:${event.assessment.verdict}:${event.decision?.action ?? ""}`;
      if (this.dedupe.get(key) !== undefined) {
        this.suppressed++;
        return false;
      }
      this.dedupe.set(key, true);
    }

    if (this.windowCount >= this.maxPerWindow) {
      this.suppressed++;
      return false;
    }
    this.windowCount++;
    return true;
  }

  private deliverSummary(dropped: number, sample: BotEvent): void {
    const summary: BotEvent = {
      type: "error",
      at: new Date(this.clock.now()).toISOString(),
      assessment: sample.assessment,
      error: {
        source: "notification-hub",
        message: `${dropped} notification(s) were suppressed in the last ${this.dedupeWindowMs}ms by deduplication or the per-window ceiling. Bot traffic is exceeding what this channel is configured to report.`,
      },
    };
    this.dispatch(summary);
  }
}
