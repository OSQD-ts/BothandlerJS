/**
 * Hono, and Next.js middleware.
 *
 * Neither needs an adapter of its own. Both speak the web platform's `Request` and
 * `Response`, which is what `createFetchAdapter` is: one function that takes a
 * `Request` and tells you whether to serve something else instead. What each framework
 * adds is a different way of saying "carry on" — `await next()` in Hono, a
 * `NextResponse.next()` in Next — so the whole integration is that one line.
 *
 * This file is executable rather than a snippet in a document, because "it probably
 * works with X" is a claim nobody has checked. `tests/adapters.test.ts` drives both
 * shapes with real `Request` objects.
 *
 * Run it: `npx tsx examples/hono-and-next.ts`
 */
import { BotHandler } from "../src/index.js";
import { createFetchAdapter } from "../src/adapters/index.js";

const detector = new BotHandler({
  preset: "protect-content",
  // Without this a rule asking for a challenge degrades to a tag, and the interstitial
  // below never appears — which is a half-configured deployment rather than a demo.
  // In production this comes from your secret manager, never from source.
  challenge: { secrets: ["demo-secret-not-for-production-use"] },
});

/**
 * The adapter, made once.
 *
 * `ipHeaders` is the part to get right, and it is the same decision on every platform:
 * name only the headers your edge *overwrites*. One a client can set is one it can use
 * to choose its own identity, and with it the address you rate-limit and block on.
 * `x-forwarded-for` is appended to rather than replaced, which is why it is not in the
 * default list.
 */
const guard = createFetchAdapter(detector, { ipHeaders: ["cf-connecting-ip", "x-real-ip"] });

// ---------------------------------------------------------------------------
// Hono
// ---------------------------------------------------------------------------

/**
 * Middleware for Hono, in the shape Hono expects: a function of `(context, next)`.
 *
 * Typed structurally rather than against Hono's own types, so this file — and the
 * library — depend on nothing. Copy it into a project that has Hono and the types line
 * up.
 */
export function honoBotGuard() {
  return async (context: { req: { raw: Request }; env?: unknown; res: Response }, next: () => Promise<void>): Promise<Response | void> => {
    const decision = await guard(context.req.raw, context.env);

    // A response means the engine wants to answer instead of your route: a challenge
    // page, a 403, a redirect. Anything else and the request carries on, now wearing
    // whatever verdict headers you configured.
    if (decision.response !== undefined) return decision.response;

    await next();

    // Optional, and worth doing: the tag travels to your own logs, so a slow endpoint
    // and a scraper hammering it are the same line in your traces.
    if (decision.result !== undefined) context.res.headers.set("x-bot-verdict", decision.result.assessment.verdict);
  };
}

// ---------------------------------------------------------------------------
// Next.js — middleware.ts
// ---------------------------------------------------------------------------

/**
 * Next's middleware runs on the edge runtime, where `Request` is the only request there
 * is. In a real project this is `middleware.ts` at the root and the return type is
 * `NextResponse`; the only Next-specific line is the "carry on" value.
 *
 * ```ts
 * // middleware.ts
 * import { NextResponse } from "next/server";
 * export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
 *
 * export async function middleware(request: Request) {
 *   const decision = await guard(request);
 *   if (decision.response) return decision.response;
 *   return NextResponse.next({ request: { headers: decision.request.headers } });
 * }
 * ```
 *
 * `decision.request.headers` is the part worth passing on: the adapter puts the verdict
 * on the request it hands back, so a route handler further in can read it without
 * assessing anything itself.
 */
export async function nextMiddleware(request: Request): Promise<Response | { headers: Headers }> {
  const decision = await guard(request);
  if (decision.response !== undefined) return decision.response;
  return { headers: decision.request.headers };
}

// ---------------------------------------------------------------------------

if (process.argv[1]?.endsWith("hono-and-next.ts") === true) {
  const requests = [
    new Request("https://shop.example/products", { headers: { "user-agent": "curl/8.4.0", "cf-connecting-ip": "203.0.113.9" } }),
    new Request("https://shop.example/products", {
      headers: {
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-GB,en;q=0.9",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "none",
        "cf-connecting-ip": "198.51.100.20",
      },
    }),
  ];

  for (const request of requests) {
    const decision = await guard(request);
    const agent = request.headers.get("user-agent")?.slice(0, 40) ?? "";
    console.log(
      `${agent.padEnd(42)} ${decision.response === undefined ? "served" : `answered ${decision.response.status}`}` +
        `   ${decision.result === undefined ? "" : `${decision.result.assessment.verdict} → ${decision.result.decision.action}`}`,
    );
  }
}
