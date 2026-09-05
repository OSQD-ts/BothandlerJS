import { describe, expect, it } from "vitest";
import { BotHandler } from "../src/index.js";
import { createFetchAdapter, withBotHandler } from "../src/adapters/fetch.js";
import { botHandler } from "../src/adapters/node.js";
import { koaBotHandler } from "../src/adapters/koa.js";
import { failingResolver } from "./helpers.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { KoaLikeContext } from "../src/adapters/koa.js";
import type { BotHandlerConfig } from "../src/config.js";

/**
 * The adapters, which are the only code here that touches a socket.
 *
 * Two properties matter more than the plumbing. The address an adapter reports is the
 * actor key, so anything a client can write into it is an identity a client can
 * choose. And an error inside detection must cost the operator a log line, never the
 * visitor their page — every adapter's doc comment promises exactly that.
 */

function handler(config: BotHandlerConfig = {}): BotHandler {
  return new BotHandler({ resolver: failingResolver(), metrics: false, ...config });
}

describe("the fetch adapter's idea of who is calling", () => {
  it("does not let a client name its own address", async () => {
    const evaluate = createFetchAdapter(handler({ denylist: ["203.0.113.66"] }));
    const request = new Request("https://shop.example/", {
      headers: { "user-agent": "curl/8.4.0", "x-forwarded-for": "198.51.100.5" },
    });
    expect((await evaluate(request)).result?.assessment.facts.ip).toBe("");
  });

  it("reads an address the edge overwrites", async () => {
    const evaluate = createFetchAdapter(handler());
    for (const header of ["cf-connecting-ip", "x-real-ip"]) {
      const request = new Request("https://shop.example/", { headers: { [header]: "198.51.100.5" } });
      expect((await evaluate(request)).result?.assessment.facts.ip, header).toBe("198.51.100.5");
    }
  });

  it("reads a forwarded chain only when explicitly told to", async () => {
    const evaluate = createFetchAdapter(handler(), { ipHeaders: ["x-forwarded-for"] });
    const request = new Request("https://shop.example/", { headers: { "x-forwarded-for": "198.51.100.5, 10.0.0.1" } });
    expect((await evaluate(request)).result?.assessment.facts.ip).toBe("198.51.100.5");
  });

  it("prefers a platform-supplied address over any header", async () => {
    const evaluate = createFetchAdapter(handler(), { clientIp: () => "203.0.113.7" });
    const request = new Request("https://shop.example/", { headers: { "cf-connecting-ip": "198.51.100.5" } });
    expect((await evaluate(request)).result?.assessment.facts.ip).toBe("203.0.113.7");
  });

  // An empty address becomes one actor key for the whole site, so it must not be
  // silent — but it also must not be a warning per request.
  it("says so once when it cannot find an address at all", async () => {
    const warnings: string[] = [];
    const evaluate = createFetchAdapter(handler({ onWarning: (message: string) => warnings.push(message) }));
    for (let i = 0; i < 3; i++) await evaluate(new Request("https://shop.example/"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("could not determine a client address");
  });
});

describe("the challenge verification endpoint", () => {
  const secrets = ["a-verification-secret-long-enough-to-pass"];

  // `assess` records the request against the actor. Running it here fed the rate and
  // cadence detectors with the evidence of a client's own compliance.
  it("is answered without being assessed or counted against the actor", async () => {
    const bot = handler({ challenge: { secrets } });
    const evaluate = createFetchAdapter(bot);
    const request = new Request("https://shop.example/__bothandler/verify", {
      method: "POST",
      body: "{}",
      headers: { "cf-connecting-ip": "198.51.100.5", "content-type": "application/json" },
    });

    const decision = await evaluate(request);
    expect(decision.response?.status).toBe(400);
    expect(decision.result, "a request that was not judged must not report a judgement").toBeUndefined();
    expect(bot.registry.peek("198.51.100.5"), "the verify POST must not become part of the actor's history").toBeUndefined();
  });
});

describe("an adapter whose engine fails", () => {
  // Every adapter's doc comment promises this, and none of them did it: the error
  // went to the framework's error path, which answers 500.
  const exploding = (): BotHandler => {
    const bot = handler();
    bot.handle = () => Promise.reject(new Error("engine exploded"));
    return bot;
  };

  it("serves the request through the node middleware rather than erroring", async () => {
    const errors: unknown[] = [];
    const bot = exploding();
    bot.config.onError = (error) => errors.push(error);

    const request = { method: "GET", url: "/", headers: {}, rawHeaders: [], httpVersion: "1.1", socket: {} } as unknown as IncomingMessage;
    const response = { headersSent: false, setHeader: () => {}, end: () => {} } as unknown as ServerResponse;

    const nextArgs = await new Promise<unknown[]>((resolve) => {
      botHandler(bot)(request, response, (...args: unknown[]) => resolve(args));
    });
    expect(nextArgs, "next(error) would route Express into a 500").toEqual([]);
    expect((errors[0] as Error).message).toBe("engine exploded");
  });

  it("serves the request through the koa middleware rather than erroring", async () => {
    const errors: unknown[] = [];
    const bot = exploding();
    bot.config.onError = (error) => errors.push(error);

    let reached = false;
    const context = {
      method: "GET",
      url: "/",
      headers: {},
      req: { rawHeaders: [], httpVersion: "1.1", socket: {}, headers: {} },
      status: 200,
      body: undefined,
      set: () => {},
    } as unknown as KoaLikeContext;

    await koaBotHandler(bot)(context, async () => {
      reached = true;
    });
    expect(reached).toBe(true);
    expect((errors[0] as Error).message).toBe("engine exploded");
  });

  // The catch must cover the engine, not the application behind it: swallowing a
  // downstream failure would hide it and run the rest of the stack twice.
  it("lets a failure from further down the stack through", async () => {
    const bot = handler();
    const context = {
      method: "GET",
      url: "/",
      headers: {},
      req: { rawHeaders: [], httpVersion: "1.1", socket: {}, headers: {} },
      status: 200,
      body: undefined,
      set: () => {},
    } as unknown as KoaLikeContext;

    await expect(
      koaBotHandler(bot)(context, () => Promise.reject(new Error("the application failed"))),
    ).rejects.toThrow("the application failed");
  });
});

describe("withBotHandler", () => {
  it("passes the request on and merges the response headers it was given", async () => {
    const bot = handler({
      rules: [{ id: "tag-all", match: {}, action: "tag", params: { headers: { "x-checked": "yes" } } }],
    });
    const wrapped = withBotHandler(bot, () => new Response("hello", { status: 200 }));
    const response = await wrapped(new Request("https://shop.example/", { headers: { "cf-connecting-ip": "198.51.100.5" } }));
    expect(await response.text()).toBe("hello");
    expect(response.headers.get("x-checked")).toBe("yes");
  });

  it("returns the engine's own response instead of calling through", async () => {
    let called = false;
    const bot = handler({
      denylist: ["198.51.100.5"],
      rules: [{ id: "block-denied", match: { certain: true }, action: "block" }],
    });
    const wrapped = withBotHandler(bot, () => {
      called = true;
      return new Response("hello");
    });
    const response = await wrapped(new Request("https://shop.example/", { headers: { "cf-connecting-ip": "198.51.100.5" } }));
    expect(response.status).toBe(403);
    expect(called).toBe(false);
  });
});

/**
 * Hono and Next.js middleware.
 *
 * Neither gets an adapter of its own, and that claim needs checking rather than
 * assuming — "it probably works with X" is how a framework ends up unsupported by
 * accident. Both speak the platform's `Request` and `Response`; what differs is the way
 * each says "carry on", which is the one line the integration consists of.
 */
describe("the fetch adapter under Hono and Next", () => {
  const browser = {
    "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "en-GB,en;q=0.9",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "none",
    "cf-connecting-ip": "198.51.100.20",
  };

  function guard(): ReturnType<typeof createFetchAdapter> {
    const handler = new BotHandler({ preset: "protect-content", challenge: { secrets: ["a-secret-of-at-least-thirty-two-characters"] } });
    return createFetchAdapter(handler, { ipHeaders: ["cf-connecting-ip"] });
  }

  /** Hono: `(context, next)`, where the raw request is `context.req.raw`. */
  it("answers instead of the route when the engine wants to, and calls next when it does not", async () => {
    const evaluate = guard();
    const middleware = async (context: { req: { raw: Request } }, next: () => Promise<void>): Promise<Response | undefined> => {
      const decision = await evaluate(context.req.raw);
      if (decision.response !== undefined) return decision.response;
      await next();
      return undefined;
    };

    let reachedTheRoute = false;
    const served = await middleware(
      { req: { raw: new Request("https://shop.example/products", { headers: browser }) } },
      async () => {
        reachedTheRoute = true;
      },
    );
    expect(served).toBeUndefined();
    expect(reachedTheRoute).toBe(true);

    reachedTheRoute = false;
    const stopped = await middleware(
      { req: { raw: new Request("https://shop.example/products", { headers: { "user-agent": "curl/8.4.0", "cf-connecting-ip": "203.0.113.9" } }) } },
      async () => {
        reachedTheRoute = true;
      },
    );
    expect(stopped?.status).toBe(429);
    expect(reachedTheRoute).toBe(false);
  });

  /**
   * Next: the middleware returns either a `Response` or a "carry on" carrying the
   * request's headers — which is the part worth passing along, since the adapter puts
   * the verdict on the request it hands back.
   */
  it("hands Next a request wearing the verdict", async () => {
    const evaluate = guard();
    const decision = await evaluate(new Request("https://shop.example/products", { headers: browser }));
    expect(decision.response).toBeUndefined();
    expect(decision.request.headers.get("x-bot-verdict") ?? decision.result?.assessment.verdict).toBeTruthy();
  });

  /** The edge runtime has no `ConnInfo`, so the header is the only address there is. */
  it("reads the address from the header the edge sets", async () => {
    const evaluate = guard();
    const decision = await evaluate(new Request("https://shop.example/products", { headers: browser }));
    expect(decision.result?.assessment.actor.key).toBe("198.51.100.20");
  });
});
