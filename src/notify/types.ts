import type { Assessment } from "../types.js";
import type { Decision } from "../policy/types.js";
import type { TrafficAnomaly } from "../audit.js";

/** Why a notification was raised. */
export type BotEventType =
  /** An assessment concluded something other than "unknown". */
  | "detection"
  /** An action was taken that withheld or altered the response. */
  | "action"
  /** The safety guard replaced a terminal action with something recoverable. */
  | "downgrade"
  /** A detector, sink or store failed. Operational, not about traffic. */
  | "error"
  /**
   * The audit noticed the *shape* of your traffic change — a spike in automation, a
   * collapse in human traffic, a policy suddenly denying far more than usual.
   *
   * The one event type that is not about a single request, which is why
   * {@link BotEvent.assessment} is optional.
   */
  | "anomaly";

export interface BotEvent {
  type: BotEventType;
  /** ISO-8601 timestamp. */
  at: string;
  /** The request this is about. Absent on `anomaly`, which is about a stretch of time. */
  assessment?: Assessment | undefined;
  decision?: Decision | undefined;
  /** Present on `error` events. */
  error?: { source: string; message: string } | undefined;
  /** Present on `anomaly` events. */
  anomaly?: TrafficAnomaly | undefined;
}

export interface Notifier {
  id: string;
  /**
   * Delivers an event.
   *
   * Called off the request path — the engine never awaits a sink — so taking time
   * here is fine. Throwing is also fine: failures are caught, reported once through
   * `onError`, and never surfaced to the client.
   */
  notify(event: BotEvent): void | Promise<void>;
}

/** Controls what a sink is told about. */
export interface NotifyFilter {
  /** Event types to deliver. Default: everything except `detection`. */
  types?: readonly BotEventType[];
  /** Minimum score for a `detection` event. Default 60. */
  minScore?: number;
  /** Only deliver proven detections. Default false. */
  certainOnly?: boolean;
}
