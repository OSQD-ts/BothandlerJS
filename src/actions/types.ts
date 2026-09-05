import type { Assessment } from "../types.js";
import type { Decision } from "../policy/types.js";
import type { BotHandlerStore } from "../stores/types.js";
import type { ChallengeService } from "../challenge/index.js";
import type { Clock } from "../internal/clock.js";

/**
 * What the engine decided should happen, expressed without reference to any
 * framework.
 *
 * The engine never touches a response object. It returns one of these and an adapter
 * applies it. That separation is what lets the same decision logic drive Express,
 * Fastify, a Fetch handler in a Worker, and a test that asserts on a plain object —
 * and it means the core has no way to accidentally write to a socket.
 */
export type ActionOutcome =
  | {
      kind: "continue";
      /** Headers to add to the *request* before it reaches your application. */
      requestHeaders?: Record<string, string>;
      /** Headers to add to the eventual response. */
      responseHeaders?: Record<string, string>;
      /** Hold the request this long before passing it on. */
      delayMs?: number;
    }
  | {
      kind: "respond";
      status: number;
      headers: Record<string, string>;
      body: string;
    }
  /** Close the connection with no response at all. */
  | { kind: "drop" };

export interface ActionContext {
  assessment: Assessment;
  decision: Decision;
  store: BotHandlerStore;
  challenge: ChallengeService | undefined;
  clock: Clock;
  /**
   * Whether verdict headers may appear on the *response*.
   *
   * Off by default. Echoing your verdict back to the client tells an operator
   * refining a scraper precisely which change made them invisible, turning your
   * detection into their test suite. Request-side tagging carries the same
   * information to your own application with none of that.
   */
  exposeVerdictHeaders: boolean;
  /** Custom handlers by id, for the `custom` action. */
  handlers: ReadonlyMap<string, CustomHandler>;
  /** Reports an action that could not run as configured. */
  onWarning: (message: string) => void;
  /** Records challenge lifecycle events for metrics. */
  onChallenge?: ((event: "issued") => void) | undefined;
}

export interface CustomHandler {
  id: string;
  description?: string;
  execute(context: ActionContext): ActionOutcome | Promise<ActionOutcome>;
}
