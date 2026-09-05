import type { BotEvent, Notifier } from "./types.js";
import { sign } from "../internal/crypto.js";

export interface ConsoleNotifierOptions {
  /** `"pretty"` for humans, `"json"` for a log pipeline. Default `"pretty"`. */
  format?: "pretty" | "json";
  /** Where to write. Default `console`. */
  target?: Pick<Console, "log" | "warn" | "error">;
}

/** Writes events to the console. The default sink, and the right one to start with. */
export function consoleNotifier(options: ConsoleNotifierOptions = {}): Notifier {
  const format = options.format ?? "pretty";
  const target = options.target ?? console;

  return {
    id: "console",
    notify(event: BotEvent): void {
      if (format === "json") {
        target.log(JSON.stringify(event));
        return;
      }
      const { assessment, decision } = event;
      if (assessment === undefined) {
        // An anomaly is about a window, not a request. One line, same shape.
        target.warn(`[bothandler] ${event.type} ${event.anomaly?.id ?? "unknown"} — ${event.anomaly?.summary ?? ""}`);
        return;
      }
      const identity = assessment.identity !== undefined ? ` ${assessment.identity}` : "";
      const head = `[bothandler] ${event.type} ${assessment.verdict}${identity} score=${assessment.score}${assessment.certain ? " (proven)" : ""} actor=${assessment.actor.key} ${assessment.facts.method} ${assessment.facts.path}`;
      const why = assessment.evidence[0]?.summary ?? "no bot evidence";
      const what = decision ? ` -> ${decision.action}${decision.downgradedFrom ? ` (downgraded from ${decision.downgradedFrom})` : ""}` : "";
      const write = event.type === "error" ? target.error : event.type === "downgrade" ? target.warn : target.log;
      write.call(target, `${head}${what}\n           ${why}`);
    },
  };
}

export interface WebhookNotifierOptions {
  url: string;
  /**
   * Shared secret. When set, each request carries `X-BotHandler-Signature` as
   * `sha256=<hex-free base64url HMAC>` over the exact body, plus a timestamp header.
   *
   * Sign your webhooks. An unsigned endpoint accepting bot alerts is an endpoint
   * anyone on the internet can fill with fabricated ones.
   */
  secret?: string;
  /** Extra headers, e.g. an API token. */
  headers?: Record<string, string>;
  /** Per-attempt timeout, ms. Default 5000. */
  timeoutMs?: number;
  /** Retries after the first attempt. Default 2, with exponential backoff. */
  retries?: number;
  /** `fetch` implementation. Defaults to the global. */
  fetch?: typeof globalThis.fetch;
}

/**
 * POSTs events as JSON.
 *
 * Delivery is best-effort by design. This runs outside the request path, so a slow or
 * unreachable endpoint costs a visitor nothing — but it also means an alert can be
 * lost, and it is not a substitute for logging events where you can query them.
 */
export function webhookNotifier(options: WebhookNotifierOptions): Notifier {
  const timeoutMs = options.timeoutMs ?? 5000;
  const retries = Math.max(0, options.retries ?? 2);
  const doFetch = options.fetch ?? globalThis.fetch;
  if (typeof doFetch !== "function") throw new Error("webhookNotifier needs a fetch implementation; pass one via `fetch` on Node versions without a global.");

  return {
    id: "webhook",
    async notify(event: BotEvent): Promise<void> {
      const body = JSON.stringify(event);
      const timestamp = String(Date.now());
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "user-agent": "bothandlerjs",
        ...options.headers,
      };
      if (options.secret !== undefined) {
        headers["x-bothandler-timestamp"] = timestamp;
        // The timestamp is inside the signed payload, so a captured request cannot
        // be replayed later with a fresh header.
        headers["x-bothandler-signature"] = `sha256=${sign(`${timestamp}.${body}`, options.secret)}`;
      }

      let lastError: unknown;
      for (let attempt = 0; attempt <= retries; attempt++) {
        if (attempt > 0) await delay(2 ** attempt * 250);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        (timer as { unref?: () => void }).unref?.();
        try {
          const response = await doFetch(options.url, { method: "POST", headers, body, signal: controller.signal });
          if (response.ok) return;
          // A 4xx other than 429 is a rejection, not a hiccup: a wrong URL, a revoked
          // token, a malformed payload. Retrying cannot change any of those, and the
          // `throw` that used to end the loop here landed in this block's own `catch`
          // two lines below — so every one of them was retried anyway, and the
          // specific status was replaced by whatever the last attempt said.
          if (response.status >= 400 && response.status < 500 && response.status !== 429) {
            throw new WebhookRejected(response.status);
          }
          lastError = new Error(`webhook responded ${response.status}`);
        } catch (error) {
          if (error instanceof WebhookRejected) throw error;
          lastError = error;
        } finally {
          clearTimeout(timer);
        }
      }
      throw lastError instanceof Error ? lastError : new Error("webhook delivery failed");
    },
  };
}

/** A response the endpoint will give again however many times it is asked. */
class WebhookRejected extends Error {
  override readonly name = "WebhookRejected";
  constructor(readonly status: number) {
    super(`webhook rejected the event with ${status}`);
  }
}

export interface SlackNotifierOptions {
  /** Incoming-webhook URL. */
  url: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

/** Posts a compact, readable message to a Slack incoming webhook. */
export function slackNotifier(options: SlackNotifierOptions): Notifier {
  const doFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 5000;

  return {
    id: "slack",
    async notify(event: BotEvent): Promise<void> {
      const { assessment, decision, anomaly } = event;
      // An anomaly has no request behind it; it is the shape of a window.
      const lines = assessment === undefined
        ? [`:chart_with_upwards_trend: *${anomaly?.id ?? "anomaly"}*`, anomaly?.summary ?? "", anomaly ? `_${anomaly.metric}: ${anomaly.value.toFixed(3)} against a baseline of ${anomaly.baseline.toFixed(3)}_` : ""].filter(Boolean)
        : [
            `${event.type === "error" ? ":rotating_light:" : event.type === "downgrade" ? ":warning:" : assessment.certain ? ":no_entry:" : ":eyes:"} *${assessment.verdict}*${assessment.identity ? ` — ${assessment.identity}` : ""}${assessment.certain ? " (proven)" : ` (score ${assessment.score})`}`,
            `\`${assessment.facts.method} ${assessment.facts.path}\` from \`${assessment.actor.key}\``,
            assessment.evidence[0] ? `> ${assessment.evidence[0].summary}` : "> no bot evidence",
            decision ? `Action: *${decision.action}*${decision.downgradedFrom ? ` _(downgraded from ${decision.downgradedFrom})_` : ""}` : "",
          ].filter(Boolean);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      (timer as { unref?: () => void }).unref?.();
      try {
        const response = await doFetch(options.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: lines.join("\n"), mrkdwn: true }),
          signal: controller.signal,
        });
        // Checked, not discarded. A revoked webhook URL answers 404 and a
        // rate-limited one answers 429, and throwing away both left a sink that looked
        // configured, delivered nothing, and never reached `onError` to say so. The
        // hub turns this into one reported failure; it does not reach the visitor.
        if (!response.ok) throw new Error(`Slack rejected the notification with ${response.status}`);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export interface NotifyJsOptions {
  /** Base URL of your NotifyJS hub. */
  endpoint: string;
  /** Hub API token. */
  token: string;
  /** Channel or topic to publish under. Default "bothandler". */
  topic?: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

/**
 * Publishes to a NotifyJS hub, so bot alerts arrive on the same devices as the rest
 * of your operational notifications.
 *
 * Written against the hub's HTTP surface rather than importing the client, so this
 * adds no dependency and works whichever version of the hub you run.
 */
export function notifyJsNotifier(options: NotifyJsOptions): Notifier {
  const doFetch = options.fetch ?? globalThis.fetch;
  const topic = options.topic ?? "bothandler";
  const timeoutMs = options.timeoutMs ?? 5000;

  return {
    id: "notifyjs",
    async notify(event: BotEvent): Promise<void> {
      const { assessment, anomaly } = event;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      (timer as { unref?: () => void }).unref?.();
      // An `anomaly` carries no request, so the message is built from the window it
      // describes instead.
      const title = assessment === undefined ? (anomaly?.id ?? "anomaly") : `${assessment.verdict}${assessment.identity ? ` — ${assessment.identity}` : ""}`;
      const body = assessment === undefined ? (anomaly?.summary ?? "") : (assessment.evidence[0]?.summary ?? `${assessment.facts.method} ${assessment.facts.path}`);
      const priority = event.type === "error" || anomaly?.severity === "critical" ? "high" : assessment?.certain || anomaly !== undefined ? "normal" : "low";
      const data = assessment === undefined
        ? { anomaly: anomaly?.id, metric: anomaly?.metric, value: anomaly?.value, baseline: anomaly?.baseline }
        : { requestId: assessment.requestId, score: assessment.score, actor: assessment.actor.key };
      try {
        const response = await doFetch(`${options.endpoint.replace(/\/$/, "")}/publish`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${options.token}` },
          body: JSON.stringify({
            topic,
            title,
            body,
            priority,
            data,
          }),
          signal: controller.signal,
        });
        // As with Slack: an expired hub token is a 401, and silence about it is
        // indistinguishable from a quiet week.
        if (!response.ok) throw new Error(`NotifyJS hub rejected the notification with ${response.status}`);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    (timer as { unref?: () => void }).unref?.();
  });
}
