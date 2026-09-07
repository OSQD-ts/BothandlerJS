import { createFacts } from "../facts.js";
import { pause, parseJson, readBoundedBody, verificationBody } from "./shared.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { BotHandler } from "../core.js";
import type { RequestFacts } from "../types.js";

export type NextFunction = (error?: unknown) => void;
export type NodeMiddleware = (request: IncomingMessage, response: ServerResponse, next: NextFunction) => void;

export interface NodeMiddlewareOptions {
  /**
   * Extracts a TLS fingerprint your edge computed, e.g. `"x-ja3-hash"` or
   * Cloudflare's `"cf-ja3-hash"`. Only set it if the header cannot be forged by a
   * client — that is, your edge always overwrites it.
   */
  tlsFingerprintHeader?: string;
  /** Also handle the challenge verification endpoint. Default true. */
  mountChallengeEndpoint?: boolean;
  /** Extra facts, e.g. a session id for a better actor key. */
  enrich?: (request: IncomingMessage, facts: RequestFacts) => RequestFacts;
}

/**
 * Connect/Express middleware. Also works with a bare `node:http` server.
 *
 * Mount it early — ahead of your routes, behind anything that terminates TLS and
 * sets forwarded headers — and after your body parser only if you need one, since
 * this reads no body except on its own verification endpoint.
 *
 * `next()` is always reached unless a response was actually produced, and any
 * unexpected error inside the engine results in the request being served rather than
 * refused. A bot filter that fails closed is an outage with extra steps.
 */
export function botHandler(handler: BotHandler, options: NodeMiddlewareOptions = {}): NodeMiddleware {
  const mountChallenge = options.mountChallengeEndpoint ?? true;

  return function botHandlerMiddleware(request, response, next): void {
    let handedOff = false;
    void (async (): Promise<void> => {
      try {
        const headers: Record<string, string | undefined> = {};
        for (const [name, value] of Object.entries(request.headers)) {
          headers[name] = Array.isArray(value) ? value.join(", ") : value;
        }

        const ip = handler.resolveIp(request.socket.remoteAddress, headers);
        const fingerprint = options.tlsFingerprintHeader !== undefined ? headers[options.tlsFingerprintHeader.toLowerCase()] : undefined;

        let facts = createFacts({
          method: request.method,
          url: request.url,
          headers: request.headers,
          rawHeaders: request.rawHeaders,
          ip,
          httpVersion: request.httpVersion,
          // `encrypted` is present only on a TLS socket. Behind a terminating proxy
          // the forwarded protocol header is the only truth available.
          protocol: (request.socket as { encrypted?: boolean }).encrypted === true || headers["x-forwarded-proto"] === "https" ? "https" : "http",
          ...(fingerprint !== undefined ? { tlsFingerprint: fingerprint } : {}),
        });
        if (options.enrich) facts = options.enrich(request, facts);

        if (mountChallenge && handler.isChallengeEndpoint(facts)) {
          await serveVerification(handler, request, response, facts);
          return;
        }

        const { outcome } = await handler.handle(facts);

        if (outcome.kind === "drop") {
          request.socket.destroy();
          return;
        }

        if (outcome.kind === "respond") {
          response.statusCode = outcome.status;
          for (const [name, value] of Object.entries(outcome.headers)) response.setHeader(name, value);
          response.end(outcome.body);
          return;
        }

        for (const [name, value] of Object.entries(outcome.requestHeaders ?? {})) {
          request.headers[name] = value;
        }
        if (outcome.responseHeaders) {
          for (const [name, value] of Object.entries(outcome.responseHeaders)) response.setHeader(name, value);
        }
        if (outcome.delayMs !== undefined) await pause(outcome.delayMs);
        // What the application answers is the one thing detection cannot see for itself:
        // the verdict above was reached before this response existed, which is what lets
        // it shape the response. Reported back on the way out, it feeds `probe-volume` —
        // an actor whose requests are almost all misses is looking for something rather
        // than reading anything. One listener, and nothing depends on it arriving.
        response.once("finish", () => {
          handler.recordOutcome(facts, response.statusCode);
        });
        handedOff = true;
        next();
      } catch (error) {
        // Fail open, loudly: reported to the operator, invisible to the visitor.
        // `next(error)` — which this used to call — routes into Express's error
        // handler and answers 500, which is failing *closed* and contradicts the
        // guarantee stated above.
        //
        // `handedOff` guards the case where the throw came from downstream rather
        // than from us: once `next()` has run, the rest of the application owns the
        // request, and calling `next` a second time would run it twice.
        failOpen(handler, error, "adapter:node");
        if (!handedOff && !response.headersSent) next();
      }
    })();
  };
}

/**
 * Reports an error the engine raised and says whether the request can still be served.
 *
 * Every adapter promises the same thing in its own doc comment: an unexpected failure
 * inside detection serves the request rather than refusing it, because a bot filter
 * that fails closed is an outage with extra steps. Handing the error to the
 * framework's error path does the opposite — Express, Koa and Fastify all turn it into
 * a 500 — so a bug in this library became a broken page for a real visitor. The error
 * is reported through the operator's own `onError`, which is where it is useful, and
 * the visitor gets their page.
 */
function failOpen(handler: BotHandler, error: unknown, source: string): void {
  handler.config.onError(error, { source });
}

async function serveVerification(handler: BotHandler, request: IncomingMessage, response: ServerResponse, facts: RequestFacts): Promise<void> {
  const outcome = await handler.verifyChallenge(facts, parseJson(await readBoundedBody(request)));
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  if (outcome.ok) response.setHeader("set-cookie", outcome.setCookie);
  response.statusCode = outcome.ok ? 200 : outcome.status;
  response.end(verificationBody(outcome));
}
