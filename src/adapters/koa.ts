import { createFacts } from "../facts.js";
import { pause, parseJson, readBoundedBody, verificationBody } from "./shared.js";
import type { BotHandler } from "../core.js";

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
    try {
      proceed = await evaluate(handler, mountChallenge, context);
    } catch (error) {
      // Serve the request rather than let a detection bug become a 500. The try
      // covers the engine only: `next()` runs the rest of your application, and
      // catching *its* failures here would both swallow them and call `next` twice.
      handler.config.onError(error, { source: "adapter:koa" });
      proceed = true;
    }
    if (proceed) await next();
  };
}

/** Runs the engine and applies its outcome. Returns whether the request continues downstream. */
async function evaluate(handler: BotHandler, mountChallenge: boolean, context: KoaLikeContext): Promise<boolean> {
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
    return false;
  }

  const { outcome } = await handler.handle(facts);

  if (outcome.kind === "drop") {
    context.req.socket.destroy();
    return false;
  }

  if (outcome.kind === "respond") {
    context.status = outcome.status;
    for (const [name, value] of Object.entries(outcome.headers)) context.set(name, value);
    context.body = outcome.body;
    return false;
  }

  for (const [name, value] of Object.entries(outcome.requestHeaders ?? {})) {
    context.req.headers[name] = value;
  }
  if (outcome.responseHeaders) {
    for (const [name, value] of Object.entries(outcome.responseHeaders)) context.set(name, value);
  }
  if (outcome.delayMs !== undefined) await pause(outcome.delayMs);
  return true;
}
