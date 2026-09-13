# Adapters

Four adapters, six frameworks, and how to write a fifth.

← [Documentation](../index.md) · [Integration](index.md)

---

```ts
import { botHandler, fastifyBotHandler, koaBotHandler, withBotHandler } from "@osqd/bothandlerjs/adapters";

app.use(botHandler(detector));                                  // Express / Connect / node:http
fastify.addHook("onRequest", fastifyBotHandler(detector));
app.use(koaBotHandler(detector));
export default { fetch: withBotHandler(detector, myHandler) };  // Workers / Deno / Bun / Edge
```

## Why adapters exist at all

The engine never touches a response object. It takes `RequestFacts` and returns an
`ActionOutcome` — "serve it", "respond with this", "destroy the connection" — and the
adapter is the only code that knows what a response *is* in your framework.

That separation is what makes a policy portable, makes the engine testable without a
server, and makes the [request tester](../operations/dashboard.md) and the
[corpus](../testing/corpus.md) possible.

## Hono and Next.js need no adapter of their own

Both speak the platform's `Request` and `Response`, which is exactly what
`createFetchAdapter` takes and returns. The only difference between them is how each says
"carry on".

```ts
const guard = createFetchAdapter(detector, { ipHeaders: ["cf-connecting-ip"] });

// Hono
app.use(async (c, next) => {
  const decision = await guard(c.req.raw, c.env);
  if (decision.response) return decision.response;
  await next();
});

// Next.js — middleware.ts
export async function middleware(request: Request) {
  const decision = await guard(request);
  if (decision.response) return decision.response;
  return NextResponse.next({ request: { headers: decision.request.headers } });
}
```

Passing `decision.request.headers` on is the part worth doing: the adapter puts the verdict
on the request it hands back, so a route further in can read it without assessing anything
itself.

`examples/hono-and-next.ts` is both, executable, and `tests/adapters.test.ts` drives both
shapes — because "it probably works with X" is how a framework ends up unsupported by
accident.

## What every adapter does for you

**Attaches the verdict to the request** — `x-bot-verdict`, `x-bot-score`, `x-bot-class`,
`x-bot-certain`, `x-bot-reason` — so your handlers can react without re-running detection.

Response-side headers are **off by default** (`exposeVerdictHeaders`): an `X-Bot-Score` in
the response is a live feedback signal for anyone tuning a scraper against you.

**Serves the [challenge](../challenge/index.md) verification endpoint.** Fastify and Koa
read the raw stream in the hook, because by the time a route handler sees the request its
body has been consumed by a parser that knows nothing about this endpoint.

**Fails open.** An unexpected failure inside detection serves the request; the error goes to
your `onError`.

## Handing over a parsed body

The engine reads no request body — doing so would consume the stream before your own parser
saw it. So a [trap](../detection/detectors.md) field on a `method="post"` form arrives
somewhere this library cannot see, and the forms worth protecting are POSTs.

`enrich` is the hand-over:

```ts
import { TRAP_FIELD_SOURCE, defaultDetectors, trapDetector } from "@osqd/bothandlerjs";

const detector = new BotHandler({
  detectors: defaultDetectors().map((d) => (d.id === "trap" ? trapDetector({ formFields: ["company_url"] }) : d)),
});

app.use(express.urlencoded({ extended: false }));   // your parser runs first
app.use(
  botHandler(detector, {
    enrich: (request, facts) => ({ ...facts, extra: { [TRAP_FIELD_SOURCE]: request.body } }),
  }),
);
```

A field arriving in the query string is read without any of this.

## Fetch runtimes

The three Node adapters read the socket address and honour [`proxy`](client-ip.md). There is
no socket on a Fetch runtime, so `withBotHandler` and `createFetchAdapter` take the address
from a header instead — which is the same decision `proxy` exists to make carefully.

```ts
export default {
  fetch: withBotHandler(detector, myHandler, {
    // Best: ask the platform, not a header.
    clientIp: (request, env) => (env as { cf?: { connectingIp?: string } }).cf?.connectingIp,
  }),
};
```

Only `cf-connecting-ip` and `x-real-ip` are trusted by default. `x-forwarded-for` is **not**
— see [the client IP](client-ip.md) for why.

Two platform notes: on Workers, enable `nodejs_compat`, because the engine uses
`node:crypto`. And Fetch runtimes normalise header order, so `header-order` returns nothing
there — drop it.

## When the application is not in Node

This library is in-process middleware, which assumes the thing serving your pages is
something it can sit inside. Plenty of sites are not shaped like that: the application is
in another language, or the pages are static files served by nginx and only `/api` reaches
Node. Those deployments are **half covered** — the guard judges the routes it is mounted
on, and every page and asset is judged by `robots.txt`, which is an honour system.

That gap is easy to miss, because an empty feed for static routes looks exactly like a
quiet site. Nothing in the dashboard says "the paths you are most worried about never
reach me".

nginx's `auth_request` closes it: every request is sent to a guard endpoint as a
subrequest first, and what that answers decides what happens to the real one.
[`examples/edge-auth-request.ts`](../../examples/edge-auth-request.ts) is a working
endpoint with the nginx configuration it expects.

```nginx
location = /_guard {
  internal;
  proxy_pass              http://127.0.0.1:9680/;
  proxy_pass_request_body off;
  proxy_set_header        Content-Length "";
  proxy_set_header        X-Original-URI    $request_uri;
  proxy_set_header        X-Original-Method $request_method;
  proxy_set_header        X-Real-IP         $remote_addr;
}

location / {
  auth_request     /_guard;
  auth_request_set $verdict $upstream_http_x_bot_verdict;
  proxy_set_header X-Bot-Verdict $verdict;
  error_page 401 = @challenge;
  proxy_pass http://your-application;
}

location @challenge { proxy_pass http://127.0.0.1:9680/; }
location @served    { proxy_pass http://your-application; }
```

Four things this costs, worth knowing before building on it:

**Decide now what happens when the guard is not running.** `auth_request` reads anything
that is not a 2xx as a refusal, so a guard that has died refuses *everybody* — the bot
protection takes the site down with it, which is worse than the outcome it exists to
prevent. That is the default unless the configuration says otherwise, which is what the
`error_page 500 502 503 504 = @served` line above is for. Failing open should be a
decision rather than an accident; if you would rather fail closed, choose that explicitly
and alert on the guard being down.

**The subrequest has no body.** nginx sends a GET with the headers and no content, so
anything reading a body cannot work — the [trap form field](../detection/detectors.md)
most of all. Trap *links* still work, because those are a path.

**It is a second round trip on every request**, including every image and font. Scope it
with `location` blocks rather than putting it in front of the whole site out of habit.

**The interstitial needs `error_page`.** `auth_request` can only allow or refuse; it has
no way to return a page. A challenge is therefore a 401 that nginx turns into a real
response by fetching it from the guard — that is the `error_page` line above, and without
it a challenged visitor gets nginx's own error page and no way through.

The method and the target are passed across explicitly because `auth_request` preserves
neither: judging every request as a `GET /` would have half the detectors reading the same
thing about everybody.

## Writing your own

About thirty lines. `src/adapters/node.ts` is the model. The shape is:

1. Build `RequestFacts` with `createFacts({ method, url, headers, rawHeaders, ip })`.
2. `await detector.handle(facts)`.
3. Apply the returned `ActionOutcome` in your framework's terms.
4. Route the challenge verification path to `detector.verifyChallenge`.

Pass `rawHeaders` if your framework exposes them — the `header-order` detector needs the
order as it arrived, and a normalised object has already lost it.

## Related

- [The client IP](client-ip.md) — do this before deploying behind a proxy
- [Actions](../policy/actions.md) — the outcomes an adapter applies
- [Detectors](../detection/detectors.md) — including `trap`, which `enrich` feeds
