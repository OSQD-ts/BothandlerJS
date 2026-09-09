import { createFacts } from "../facts.js";
import { pause, parseJson, readBoundedBody, verificationBody } from "./shared.js";
import type { BotHandler } from "../core.js";
import type { RequestFacts } from "../types.js";

/** The parts of a Koa context this adapter touches, described structurally. */
export interface KoaLikeContext {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  req: import("node:http").IncomingMessage;
  status: number;
  body: unknown;
  set(name: string, value: string): void;
  secure?: boolean;
}

export interface KoaAdapterOptions {
  /** Also serve the challenge verification endpoint. Default true. */
  mountChallengeEndpoint?: boolean;
}

/**
 * Koa middleware.
 *
 * ```ts
 * app.use(koaBotHandler(handler));
 * ```
 *
 * Place it above everything else. Koa's downstream-then-upstream flow means anything
 * mounted before this still runs for a request that is about to be refused.
 */
export function koaBotHandler(handler: BotHandler, options: KoaAdapterOptions = {}) {
  const mountChallenge = options.mountChallengeEndpoint ?? true;

  return async function botHandlerMiddleware(context: KoaLikeContext, next: () => Promise<void>): Promise<void> {
    let proceed: boolean;
    let facts: RequestFacts | undefined;
    try {
      const decision = await evaluate(handler, mountChallenge, context);
      proceed = decision.proceed;
      facts = decision.facts;
    } catch (error) {
      // Serve the request rather than let a detection bug become a 500. The try
      // covers the engine only: `next()` runs the rest of your application, and
      // catching *its* failures here would both swallow them and call `next` twice.
      handler.config.onError(error, { source: "adapter:koa" });
      proceed = true;
    }
    if (!proceed) return;
    await next();
    // The status the application settled on, reported back on the way out. It feeds
    // `probe-volume`, which without it is installed and silently inert under Koa.
    // Reading `ctx.status` rather than listening on the socket keeps this on Koa's own
    // terms, where the status is whatever the middleware chain last set.
    if (facts !== undefined) handler.recordOutcome(facts, context.status);
  };
}

/** Runs the engine and applies its outcome. Says whether the request continues downstream. */
async function evaluate(handler: BotHandler, mountChallenge: boolean, context: KoaLikeContext): Promise<{ proceed: boolean; facts?: RequestFacts }> {
  const headers: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(context.headers)) {
    headers[name] = Array.isArray(value) ? value.join(", ") : value;
  }

  const facts = createFacts({
    method: context.method,
    url: context.url,
    headers: context.headers,
    rawHeaders: context.req.rawHeaders,
    ip: handler.resolveIp(context.req.socket.remoteAddress, headers),
    httpVersion: context.req.httpVersion,
    protocol:
      context.secure === true || (context.req.socket as { encrypted?: boolean }).encrypted === true || headers["x-forwarded-proto"] === "https" ? "https" : "http",
  });

  if (mountChallenge && handler.isChallengeEndpoint(facts)) {
    const verification = await handler.verifyChallenge(facts, parseJson(await readBoundedBody(context.req)));
    context.status = verification.ok ? 200 : verification.status;
    context.set("content-type", "application/json; charset=utf-8");
    context.set("cache-control", "no-store");
    if (verification.ok) context.set("set-cookie", verification.setCookie);
    context.body = verificationBody(verification);
    return { proceed: false };
  }

  const { outcome } = await handler.handle(facts);

  if (outcome.kind === "drop") {
    context.req.socket.destroy();
    return { proceed: false };
  }

  if (outcome.kind === "respond") {
    context.status = outcome.status;
    for (const [name, value] of Object.entries(outcome.headers)) context.set(name, value);
    context.body = outcome.body;
    return { proceed: false };
  }

  for (const [name, value] of Object.entries(outcome.requestHeaders ?? {})) {
    context.req.headers[name] = value;
  }
  if (outcome.responseHeaders) {
    for (const [name, value] of Object.entries(outcome.responseHeaders)) context.set(name, value);
  }
  if (outcome.delayMs !== undefined) await pause(outcome.delayMs);
  return { proceed: true, facts };
}
