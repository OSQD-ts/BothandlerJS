import { createFacts } from "../facts.js";
import { pause, parseJson, readBoundedBody, verificationBody } from "./shared.js";
import type { BotHandler } from "../core.js";
import type { RequestFacts } from "../types.js";

/**
 * The parts of Fastify's request and reply this adapter touches, described
 * structurally so the library takes no dependency on Fastify or its types.
 */
export interface FastifyLikeRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  raw: import("node:http").IncomingMessage;
}

export interface FastifyLikeReply {
  code(status: number): FastifyLikeReply;
  header(name: string, value: string): FastifyLikeReply;
  send(body: unknown): unknown;
  hijack?(): void;
}

export interface FastifyAdapterOptions {
  tlsFingerprintHeader?: string;
  /**
   * Also serve the challenge verification endpoint. Default true.
   *
   * Fastify parses bodies after `onRequest`, so this reads the raw stream itself.
   * That is why it must run here rather than as a route: by the time a route handler
   * sees the request, the body has been consumed by a parser that does not know about
   * this endpoint.
   */
  mountChallengeEndpoint?: boolean;
  enrich?: (request: FastifyLikeRequest, facts: RequestFacts) => RequestFacts;
}

/**
 * An `onRequest` hook for Fastify.
 *
 * ```ts
 * fastify.addHook("onRequest", fastifyBotHandler(handler));
 * ```
 *
 * `onRequest` rather than `preHandler` on purpose: it is the earliest hook, so a
 * refused request never reaches routing, validation or your body parser — none of
 * which should be doing work for traffic that has already been decided about.
 */
export function fastifyBotHandler(handler: BotHandler, options: FastifyAdapterOptions = {}) {
  const mountChallenge = options.mountChallengeEndpoint ?? true;

  return async function onRequest(request: FastifyLikeRequest, reply: FastifyLikeReply): Promise<void> {
    try {
      await evaluate(handler, options, mountChallenge, request, reply);
    } catch (error) {
      // Returning normally lets routing continue. Letting the throw reach Fastify
      // would answer 500 instead — a detection bug charged to the visitor, which is
      // the one thing every adapter here promises not to do.
      handler.config.onError(error, { source: "adapter:fastify" });
    }
  };
}

async function evaluate(
  handler: BotHandler,
  options: FastifyAdapterOptions,
  mountChallenge: boolean,
  request: FastifyLikeRequest,
  reply: FastifyLikeReply,
): Promise<void> {
  const headers: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    headers[name] = Array.isArray(value) ? value.join(", ") : value;
  }

  const ip = handler.resolveIp(request.raw.socket.remoteAddress, headers);
  const fingerprint = options.tlsFingerprintHeader !== undefined ? headers[options.tlsFingerprintHeader.toLowerCase()] : undefined;

  let facts = createFacts({
    method: request.method,
    url: request.url,
    headers: request.headers,
    rawHeaders: request.raw.rawHeaders,
    ip,
    httpVersion: request.raw.httpVersion,
    protocol: (request.raw.socket as { encrypted?: boolean }).encrypted === true || headers["x-forwarded-proto"] === "https" ? "https" : "http",
    ...(fingerprint !== undefined ? { tlsFingerprint: fingerprint } : {}),
  });
  if (options.enrich) facts = options.enrich(request, facts);

  if (mountChallenge && handler.isChallengeEndpoint(facts)) {
    const verification = await handler.verifyChallenge(facts, parseJson(await readBoundedBody(request.raw)));
    reply.code(verification.ok ? 200 : verification.status);
    reply.header("content-type", "application/json; charset=utf-8");
    reply.header("cache-control", "no-store");
    if (verification.ok) reply.header("set-cookie", verification.setCookie);
    reply.send(verificationBody(verification));
    return;
  }

  const { outcome } = await handler.handle(facts);

  if (outcome.kind === "drop") {
    // `hijack` tells Fastify this route will not produce a reply, so it does not
    // try to serialise one for a socket that is about to disappear.
    reply.hijack?.();
    request.raw.socket.destroy();
    return;
  }

  if (outcome.kind === "respond") {
    reply.code(outcome.status);
    for (const [name, value] of Object.entries(outcome.headers)) reply.header(name, value);
    reply.send(outcome.body);
    return;
  }

  for (const [name, value] of Object.entries(outcome.requestHeaders ?? {})) {
    request.headers[name] = value;
  }
  if (outcome.responseHeaders) {
    for (const [name, value] of Object.entries(outcome.responseHeaders)) reply.header(name, value);
  }
  if (outcome.delayMs !== undefined) await pause(outcome.delayMs);
}
