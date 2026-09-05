import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { BotHandler } from "../src/index.js";
import { botHandler } from "../src/adapters/node.js";
import { createFetchAdapter } from "../src/adapters/fetch.js";
import { fastifyBotHandler } from "../src/adapters/fastify.js";
import { koaBotHandler } from "../src/adapters/koa.js";
import { MAX_VERIFY_BODY, parseJson, readBoundedBody } from "../src/adapters/shared.js";
import { failingResolver } from "./helpers.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { BotHandlerConfig } from "../src/config.js";
import type { FastifyLikeReply, FastifyLikeRequest } from "../src/adapters/fastify.js";
import type { KoaLikeContext } from "../src/adapters/koa.js";

/**
 * What each adapter does with an outcome.
 *
 * The engine is tested to death elsewhere; this file is about the last inch, where a
 * decision becomes a socket operation. It matters disproportionately because it is
 * the only code here that every single user runs, and because the four adapters
 * express the same six outcomes in four different vocabularies — `response.end`, a
 * Koa context assignment, a chained Fastify reply, a returned `Response` — so a
 * behaviour that is right in one is not thereby right in the others.
 *
 * Every framework object below is a hand-built double. That is not a shortcut: each
 * adapter declares the shape it needs structurally and takes no dependency on the
 * framework, so a double that satisfies the interface is exactly the contract, and
 * testing through the real Fastify would test Fastify.
 */

const CURL = "curl/8.4.0";
const SECRET = "a-test-secret-that-is-long-enough-to-be-accepted";

function engine(config: BotHandlerConfig = {}): BotHandler {
  return new BotHandler({ resolver: failingResolver(), metrics: false, ...config });
}

/** A handler that refuses self-identified bots outright, which is a `respond` outcome. */
function blocking(): BotHandler {
  return engine({ rules: [{ id: "block-bots", match: { verdict: "confirmed-bot" }, action: "block", params: { status: 403, body: "no" } }] });
}

interface FakeSocket {
  remoteAddress: string;
  destroyed: boolean;
  destroy(): void;
  encrypted?: boolean;
}

function socket(encrypted = false): FakeSocket {
  const it: FakeSocket = {
    remoteAddress: "203.0.113.7",
    destroyed: false,
    destroy(): void {
      it.destroyed = true;
    },
  };
  if (encrypted) it.encrypted = true;
  return it;
}

interface RequestOptions {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: string;
  socket?: FakeSocket;
}

/** A readable `IncomingMessage` double — readable because the verification endpoint consumes the stream. */
function nodeRequest(options: RequestOptions = {}): IncomingMessage & { socket: FakeSocket } {
  const headers = options.headers ?? { host: "shop.example", "user-agent": CURL, accept: "*/*" };
  const stream = Readable.from(options.body !== undefined ? [Buffer.from(options.body, "utf8")] : []);
  return Object.assign(stream, {
    method: options.method ?? "GET",
    url: options.url ?? "/",
    headers: { ...headers },
    rawHeaders: Object.keys(headers),
    httpVersion: "1.1",
    socket: options.socket ?? socket(),
  }) as unknown as IncomingMessage & { socket: FakeSocket };
}

interface FakeResponse {
  statusCode: number;
  headersSent: boolean;
  headers: Record<string, string>;
  body: unknown;
  ended: boolean;
  setHeader(name: string, value: string): void;
  end(body?: unknown): void;
}

function nodeResponse(): FakeResponse {
  const it: FakeResponse = {
    statusCode: 200,
    headersSent: false,
    headers: {},
    body: undefined,
    ended: false,
    setHeader(name, value): void {
      it.headers[name] = value;
    },
    end(body): void {
      it.body = body;
      it.ended = true;
      it.headersSent = true;
    },
  };
  return it;
}

/** Runs the node middleware and resolves with whether `next()` was reached. */
function runNode(handler: BotHandler, request: IncomingMessage, response: FakeResponse, options = {}): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (reached: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(reached);
    };
    botHandler(handler, options)(request, response as unknown as ServerResponse, () => finish(true));
    // The middleware answers the request instead of calling `next` on every refusal,
    // so the other ending has to be noticed rather than waited for.
    const poll = setInterval(() => {
      if (response.ended || (request as unknown as { socket: FakeSocket }).socket.destroyed) {
        clearInterval(poll);
        finish(false);
      }
    }, 2);
    poll.unref?.();
    setTimeout(() => {
      clearInterval(poll);
      finish(false);
    }, 800).unref?.();
  });
}

interface KoaState {
  context: KoaLikeContext;
  headers: Record<string, string>;
}

function koaContext(options: RequestOptions = {}): KoaState {
  const request = nodeRequest(options);
  const headers: Record<string, string> = {};
  const context = {
    method: request.method,
    url: request.url,
    headers: request.headers,
    req: request,
    status: 404,
    body: undefined,
    set(name: string, value: string): void {
      headers[name] = value;
    },
  } as unknown as KoaLikeContext;
  return { context, headers };
}

interface FastifyState {
  request: FastifyLikeRequest;
  reply: FastifyLikeReply;
  status: number;
  headers: Record<string, string>;
  body: unknown;
  sent: boolean;
  hijacked: boolean;
}

function fastifyPair(options: RequestOptions = {}): FastifyState {
  const raw = nodeRequest(options);
  const state = {
    status: 200,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    sent: false,
    hijacked: false,
  };
  const reply: FastifyLikeReply = {
    code(status: number): FastifyLikeReply {
      state.status = status;
      return reply;
    },
    header(name: string, value: string): FastifyLikeReply {
      state.headers[name] = value;
      return reply;
    },
    send(body: unknown): unknown {
      state.body = body;
      state.sent = true;
      return reply;
    },
    hijack(): void {
      state.hijacked = true;
    },
  };
  const request: FastifyLikeRequest = {
    method: raw.method ?? "GET",
    url: raw.url ?? "/",
    headers: raw.headers,
    raw,
  };
  return Object.assign(state, { request, reply });
}

describe("a refusal, in each adapter's own vocabulary", () => {
  it("node writes the status, the headers and the body, and never calls next", async () => {
    const response = nodeResponse();
    const reached = await runNode(blocking(), nodeRequest(), response);
    expect(reached, "a refused request must not reach the application").toBe(false);
    expect(response.statusCode).toBe(403);
    expect(response.body).toBe("no");
    expect(response.ended).toBe(true);
  });

  it("koa sets status and body and does not call next", async () => {
    const { context, headers } = koaContext();
    let reached = false;
    await koaBotHandler(blocking())(context, async () => {
      reached = true;
    });
    expect(reached).toBe(false);
    expect(context.status).toBe(403);
    expect(context.body).toBe("no");
    expect(headers["content-type"]).toBeDefined();
  });

  it("fastify sends through the reply", async () => {
    const state = fastifyPair();
    await fastifyBotHandler(blocking())(state.request, state.reply);
    expect(state.status).toBe(403);
    expect(state.body).toBe("no");
    expect(state.sent).toBe(true);
  });

  it("fetch returns a response instead of a result", async () => {
    const evaluate = createFetchAdapter(blocking());
    const { response } = await evaluate(new Request("https://shop.example/", { headers: { "user-agent": CURL } }));
    expect(response?.status).toBe(403);
    expect(await response?.text()).toBe("no");
  });
});

/**
 * `drop` closes the connection without an answer, which is the one outcome with no
 * response to inspect — so each adapter is checked on the socket instead.
 */
describe("a dropped connection", () => {
  const dropping = (): BotHandler => engine({ rules: [{ id: "drop-bots", match: { verdict: "confirmed-bot" }, action: "drop" }] });

  it("node destroys the socket and writes nothing", async () => {
    const request = nodeRequest();
    const response = nodeResponse();
    const reached = await runNode(dropping(), request, response);
    expect(reached).toBe(false);
    expect(request.socket.destroyed).toBe(true);
    expect(response.ended, "a dropped connection gets no reply at all").toBe(false);
  });

  it("koa destroys the socket and does not continue", async () => {
    const { context } = koaContext();
    let reached = false;
    await koaBotHandler(dropping())(context, async () => {
      reached = true;
    });
    expect(reached).toBe(false);
    expect((context.req as unknown as { socket: FakeSocket }).socket.destroyed).toBe(true);
  });

  /**
   * Fastify needs telling. Without `hijack()` it goes looking for a reply to
   * serialise onto a socket that has already gone, and logs the failure as an error
   * in the operator's own application.
   */
  it("fastify hijacks the reply before destroying the socket", async () => {
    const state = fastifyPair();
    await fastifyBotHandler(dropping())(state.request, state.reply);
    expect(state.hijacked).toBe(true);
    expect(state.sent).toBe(false);
    expect((state.request.raw as unknown as { socket: FakeSocket }).socket.destroyed).toBe(true);
  });
});

describe("a request that continues", () => {
  const tagging = (): BotHandler =>
    engine({ rules: [{ id: "tag-bots", match: { verdict: "confirmed-bot" }, action: "tag", params: { headers: { "x-checked": "yes" } } }] });

  it("node injects the request headers, sets the response headers and calls next", async () => {
    const request = nodeRequest();
    const response = nodeResponse();
    expect(await runNode(tagging(), request, response)).toBe(true);
    expect(request.headers["x-bot-verdict"]).toBe("confirmed-bot");
    expect(response.headers["x-checked"]).toBe("yes");
    expect(response.ended, "the application answers, not the adapter").toBe(false);
  });

  it("koa injects onto the underlying request and calls next", async () => {
    const { context, headers } = koaContext();
    let reached = false;
    await koaBotHandler(tagging())(context, async () => {
      reached = true;
    });
    expect(reached).toBe(true);
    expect(context.req.headers["x-bot-verdict"]).toBe("confirmed-bot");
    expect(headers["x-checked"]).toBe("yes");
  });

  it("fastify mutates the request headers the route will read", async () => {
    const state = fastifyPair();
    await fastifyBotHandler(tagging())(state.request, state.reply);
    expect(state.request.headers["x-bot-verdict"]).toBe("confirmed-bot");
    expect(state.headers["x-checked"]).toBe("yes");
    expect(state.sent, "returning from onRequest is how Fastify is told to carry on").toBe(false);
  });

  /** `delay` is a `continue` that arrives late, and every adapter has to actually wait. */
  it("holds the request for the delay before handing it on", async () => {
    const delaying = engine({ rules: [{ id: "slow-bots", match: { verdict: "confirmed-bot" }, action: "delay", params: { delayMs: 120 } }] });
    const started = Date.now();
    const state = fastifyPair();
    await fastifyBotHandler(delaying)(state.request, state.reply);
    expect(Date.now() - started).toBeGreaterThanOrEqual(90);
  });
});

/**
 * The promise every adapter's doc comment makes: a failure inside detection costs the
 * operator a log line and the visitor nothing. Two of these four were unexercised.
 */
describe("an engine that throws", () => {
  function exploding(): { handler: BotHandler; errors: unknown[] } {
    const errors: unknown[] = [];
    const handler = engine();
    handler.handle = () => Promise.reject(new Error("engine exploded"));
    handler.config.onError = (error) => errors.push(error);
    return { handler, errors };
  }

  it("fastify serves the request and reports the error", async () => {
    const { handler, errors } = exploding();
    const state = fastifyPair();
    await fastifyBotHandler(handler)(state.request, state.reply);
    expect(state.sent, "a sent reply here would be a 500 charged to the visitor").toBe(false);
    expect((errors[0] as Error).message).toBe("engine exploded");
  });

  it("fetch reports the error and asks for no response", async () => {
    const { handler, errors } = exploding();
    const evaluate = createFetchAdapter(handler);
    const { response } = await evaluate(new Request("https://shop.example/", { headers: { "user-agent": CURL } }));
    expect(response).toBeUndefined();
    expect((errors[0] as Error).message).toBe("engine exploded");
  });
});

/**
 * The verification endpoint, which is the only place an adapter reads a body.
 *
 * It has to be served before assessment, not after: a client that has just solved a
 * proof of work has not yet been granted anything, so assessing the submission would
 * challenge it again and the loop never closes.
 */
describe("the challenge verification endpoint", () => {
  const withChallenge = (): BotHandler => engine({ challenge: { secrets: [SECRET] } });
  const post = { method: "POST", url: "/__bothandler/verify", body: JSON.stringify({ challenge: "nonsense", solution: "0" }) };

  it("node answers it as JSON without caching", async () => {
    const response = nodeResponse();
    const reached = await runNode(withChallenge(), nodeRequest(post), response);
    expect(reached, "the endpoint is the adapter's own, not the application's").toBe(false);
    expect(response.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(JSON.parse(String(response.body))).toHaveProperty("ok", false);
  });

  it("koa answers it and stops", async () => {
    const { context, headers } = koaContext(post);
    let reached = false;
    await koaBotHandler(withChallenge())(context, async () => {
      reached = true;
    });
    expect(reached).toBe(false);
    expect(headers["cache-control"]).toBe("no-store");
    expect(JSON.parse(String(context.body))).toHaveProperty("ok", false);
  });

  it("fastify answers it from onRequest, before any body parser has run", async () => {
    const state = fastifyPair(post);
    await fastifyBotHandler(withChallenge())(state.request, state.reply);
    expect(state.sent).toBe(true);
    expect(state.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(JSON.parse(String(state.body))).toHaveProperty("ok", false);
  });

  it("can be switched off so the application can serve it itself", async () => {
    const state = fastifyPair(post);
    await fastifyBotHandler(withChallenge(), { mountChallengeEndpoint: false })(state.request, state.reply);
    expect(state.sent).toBe(false);
  });
});

describe("what fastify reads off the request", () => {
  it("takes the address through the handler rather than from a header", async () => {
    const handler = engine({ denylist: ["198.51.100.5"] });
    const state = fastifyPair({ headers: { host: "shop.example", "user-agent": CURL, "x-forwarded-for": "198.51.100.5" } });
    await fastifyBotHandler(handler)(state.request, state.reply);
    // Proxies are not trusted by default, so the forged header is not the actor and
    // the denylist entry it names does not fire.
    expect(state.sent).toBe(false);
  });

  it("reads a TLS fingerprint from the header the operator nominated", async () => {
    const handler = engine();
    const seen: string[] = [];
    handler.on("assessment", (assessment) => seen.push(assessment.facts.tlsFingerprint ?? ""));
    const state = fastifyPair({ headers: { host: "shop.example", "user-agent": CURL, "x-ja3-hash": "abc123" } });
    await fastifyBotHandler(handler, { tlsFingerprintHeader: "x-ja3-hash" })(state.request, state.reply);
    expect(seen[0]).toBe("abc123");
  });

  it("joins a repeated header rather than dropping it", async () => {
    const handler = engine();
    const state = fastifyPair();
    (state.request.headers as Record<string, string | string[]>)["accept-language"] = ["en", "fr"];
    await expect(fastifyBotHandler(handler)(state.request, state.reply)).resolves.toBeUndefined();
  });

  it("lets enrich replace the facts", async () => {
    const handler = engine();
    const seen: string[] = [];
    handler.on("assessment", (assessment) => seen.push(assessment.facts.path));
    const state = fastifyPair();
    await fastifyBotHandler(handler, { enrich: (_request, facts) => ({ ...facts, path: "/enriched" }) })(state.request, state.reply);
    expect(seen[0]).toBe("/enriched");
  });

  it("calls https for a request that arrived over TLS", async () => {
    const handler = engine();
    const seen: string[] = [];
    handler.on("assessment", (assessment) => seen.push(assessment.facts.protocol ?? ""));
    const state = fastifyPair({ socket: socket(true) });
    await fastifyBotHandler(handler)(state.request, state.reply);
    expect(seen[0]).toBe("https");
  });
});

/**
 * The body reader every adapter shares.
 *
 * It reads input from a client that is, by construction, already under suspicion —
 * one that has just been challenged — so nothing here may throw and nothing may
 * buffer without a ceiling.
 */
describe("the bounded body reader", () => {
  it("reads a small body whole", async () => {
    expect(await readBoundedBody(nodeRequest({ body: '{"a":1}' }))).toBe('{"a":1}');
  });

  it("stops reading and destroys the socket past the cap", async () => {
    const request = nodeRequest({ body: "x".repeat(MAX_VERIFY_BODY + 1) });
    expect(await readBoundedBody(request)).toBe("");
  });

  it("resolves to empty rather than throwing when the stream errors", async () => {
    const request = Readable.from(
      (async function* () {
        yield Buffer.from("part");
        throw new Error("connection reset");
      })(),
    ) as unknown as IncomingMessage;
    await expect(readBoundedBody(request)).resolves.toBe("");
  });

  it("returns undefined for anything that is not parseable JSON", () => {
    expect(parseJson("")).toBeUndefined();
    expect(parseJson("{not json")).toBeUndefined();
    expect(parseJson("x".repeat(MAX_VERIFY_BODY + 1))).toBeUndefined();
    expect(parseJson('{"ok":true}')).toEqual({ ok: true });
  });
});
