import { createFacts } from "../facts.js";
import { MAX_VERIFY_BODY, parseJson, pause } from "./shared.js";
import type { BotHandler } from "../core.js";
import type { HandleResult } from "../core.js";
import type { RequestFacts } from "../types.js";

export interface FetchAdapterOptions {
  /**
   * Headers to read the client address from, in order of preference.
   *
   * Only headers your edge *overwrites* belong here. One a client can set is one it
   * can use to choose its own identity — and with it the address you rate-limit,
   * allowlist, denylist and block on. `x-forwarded-for` is deliberately **not** in the
   * default list: it is appended to rather than replaced, so its leftmost entry is
   * whatever the client wrote. List it explicitly only if you know your edge replaces
   * the whole header.
   */
  ipHeaders?: readonly string[];
  /** Reads the address from the platform's own context object, e.g. a Workers `ConnInfo`. */
  clientIp?: (request: Request, context: unknown) => string | undefined;
  /** Header carrying an edge-computed JA3/JA4 fingerprint. */
  tlsFingerprintHeader?: string;
  mountChallengeEndpoint?: boolean;
  enrich?: (request: Request, facts: RequestFacts) => RequestFacts;
}

/**
 * Address headers trusted without being asked for.
 *
 * Both are single-valued and written by the edge that terminates the connection, so a
 * client cannot choose what they say. `x-forwarded-for` used to be here and is not any
 * more: it is a chain a proxy *appends* to, so its leftmost entry — the one this
 * adapter reads — is supplied by the client. Trusting it by default let anyone pick
 * their own address and walk straight past a denylist, a rate limit and every
 * behavioural signal keyed on the actor. The other three adapters never did: they go
 * through `resolveIp`, where reading a forwarded header at all requires
 * `proxy.trustProxy` and the configuration warns at length about exactly this. This
 * one now agrees with them.
 */
const DEFAULT_IP_HEADERS = ["cf-connecting-ip", "x-real-ip"] as const;

export interface FetchDecision {
  /** Serve this instead of calling your handler. `undefined` means carry on. */
  response?: Response | undefined;
  /** The request to pass on, carrying the verdict headers. */
  request: Request;
  /**
   * What the engine concluded — absent for a challenge verification request, which is
   * answered without being assessed.
   *
   * Reported as missing rather than filled in with a placeholder assessment: "we did
   * not judge this request" and "we judged it and found nothing" must not look the
   * same to whatever is reading this.
   */
  result?: HandleResult | undefined;
}

/**
 * Web-standard adapter, for Cloudflare Workers, Deno, Bun, Vercel Edge and anything
 * else built on `Request`/`Response`.
 *
 * Returns a decision rather than wrapping your handler, so the same primitive fits a
 * router, a middleware chain or a plain `fetch` export. {@link withBotHandler} wraps it
 * for the common case.
 *
 * Note that the engine uses `node:crypto` for HMAC and hashing. On Workers that means
 * enabling `nodejs_compat`; Deno and Bun provide it natively.
 */
export function createFetchAdapter(handler: BotHandler, options: FetchAdapterOptions = {}) {
  const ipHeaders = options.ipHeaders ?? DEFAULT_IP_HEADERS;
  const mountChallenge = options.mountChallengeEndpoint ?? true;
  let warnedAboutAddress = false;

  return async function evaluate(request: Request, context: unknown = undefined): Promise<FetchDecision> {
    try {
      return await decide(request, context);
    } catch (error) {
      // Fail open, loudly — the same promise the node, Koa and Fastify adapters make,
      // and the one this adapter was not keeping. An error escaping here reaches the
      // runtime's own handler, and Workers, Deno and Bun all answer 500: a detection
      // bug charged to the visitor. Returning the request unchanged, with no verdict,
      // serves the page instead; `result` is absent, which already means "we did not
      // judge this request" to everything downstream.
      handler.config.onError(error, { source: "adapter:fetch" });
      return { request };
    }
  };

  async function decide(request: Request, context: unknown): Promise<FetchDecision> {
    const headers: Record<string, string | undefined> = {};
    const order: string[] = [];
    for (const [name, value] of request.headers) {
      headers[name] = value;
      order.push(name);
    }

    const url = new URL(request.url);
    const ip = options.clientIp?.(request, context) ?? firstHeaderAddress(headers, ipHeaders) ?? "";
    // An empty address is not a harmless blank: it becomes the actor key, so every
    // visitor collapses into one actor and every rate limit and behavioural signal
    // becomes site-wide. Said once, because it is a deployment mistake rather than a
    // per-request event, and a warning on every request is a warning nobody reads.
    if (ip === "" && !warnedAboutAddress) {
      warnedAboutAddress = true;
      // Through the handler rather than straight to the callback, so a subscriber —
      // and the dashboard's notices panel — hears about it too.
      handler.warn(
        `The fetch adapter could not determine a client address: none of ${ipHeaders.join(", ")} is present and no \`clientIp\` was supplied. ` +
          `Every request will be tracked under one empty actor key, so rate limits and behavioural detection apply to your whole site at once. ` +
          `Pass \`clientIp\` to read the address from your platform's connection info, or list the header your edge sets.`,
      );
    }
    const fingerprint = options.tlsFingerprintHeader !== undefined ? headers[options.tlsFingerprintHeader.toLowerCase()] : undefined;

    let facts = createFacts({
      method: request.method,
      url: `${url.pathname}${url.search}`,
      headers,
      // The Fetch API normalises and sorts headers, so wire order is genuinely
      // unavailable here. Passing the sorted order would be worse than passing none:
      // the header-order detector would compare against an ordering no client chose.
      rawHeaders: [],
      ip,
      protocol: url.protocol === "https:" ? "https" : "http",
      ...(fingerprint !== undefined ? { tlsFingerprint: fingerprint } : {}),
    });
    if (options.enrich) facts = options.enrich(request, facts);

    if (mountChallenge && handler.isChallengeEndpoint(facts)) {
      const body = await readBounded(request);
      const outcome = await handler.verifyChallenge(facts, parseJson(body));
      const responseHeaders = new Headers({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      if (outcome.ok) responseHeaders.set("set-cookie", outcome.setCookie);
      // Deliberately not assessed. `assess` records the request against the actor, so
      // running it here inflated the request count and arrival cadence of the one
      // client that is trying to answer a challenge — feeding the rate and cadence
      // detectors with the evidence of its own compliance. The comment here already
      // said the request was not assessed; the code called `assess` anyway.
      return {
        response: new Response(JSON.stringify(outcome.ok ? { ok: true } : { ok: false, error: outcome.reason }), {
          status: outcome.ok ? 200 : outcome.status,
          headers: responseHeaders,
        }),
        request,
      };
    }

    const result = await handler.handle(facts);
    const { outcome } = result;

    if (outcome.kind === "drop") {
      // A Fetch runtime cannot close a connection without answering, so the nearest
      // equivalent is an empty 444-style refusal. Say so rather than pretend.
      return { response: new Response(null, { status: 444 }), request, result };
    }

    if (outcome.kind === "respond") {
      return { response: new Response(outcome.body, { status: outcome.status, headers: outcome.headers }), request, result };
    }

    if (outcome.delayMs !== undefined) await pause(outcome.delayMs);

    // Requests are immutable, so tagging means constructing a new one.
    const tagged = outcome.requestHeaders
      ? new Request(request, { headers: mergeHeaders(request.headers, outcome.requestHeaders) })
      : request;

    return { request: tagged, result };
  }
}

/** Wraps a handler. The common case: one call, one line. */
export function withBotHandler(
  handler: BotHandler,
  next: (request: Request, context: unknown) => Response | Promise<Response>,
  options: FetchAdapterOptions = {},
): (request: Request, context?: unknown) => Promise<Response> {
  const evaluate = createFetchAdapter(handler, options);
  return async (request, context = undefined) => {
    const decision = await evaluate(request, context);
    if (decision.response) return decision.response;
    const response = await next(decision.request, context);
    const extra = decision.result?.outcome.kind === "continue" ? decision.result.outcome.responseHeaders : undefined;
    if (!extra) return response;
    const merged = new Response(response.body, response);
    for (const [name, value] of Object.entries(extra)) merged.headers.set(name, value);
    return merged;
  };
}

function firstHeaderAddress(headers: Record<string, string | undefined>, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = headers[name];
    if (value === undefined) continue;
    // A forwarded chain is left-to-right, oldest first. The leftmost entry is the
    // one the client itself can write, so it is taken only from headers the caller
    // has declared trustworthy by listing them.
    const first = value.split(",")[0]?.trim();
    if (first !== undefined && first.length > 0) return first;
  }
  return undefined;
}

function mergeHeaders(original: Headers, additions: Record<string, string>): Headers {
  const merged = new Headers(original);
  for (const [name, value] of Object.entries(additions)) merged.set(name, value);
  return merged;
}

async function readBounded(request: Request): Promise<string> {
  const text = await request.clone().text();
  return text.length > MAX_VERIFY_BODY ? "" : text;
}
