#!/usr/bin/env tsx
/**
 * Running the guard at the edge, for a site whose application is not in Node.
 *
 *   npx tsx examples/edge-auth-request.ts
 *
 * This library is in-process middleware, which assumes the thing serving your pages is
 * something it can sit inside. Plenty of sites are not shaped like that: the application
 * is in another language, or the pages are static files served by nginx and only `/api`
 * reaches Node. Those deployments are half covered — the guard sees the routes it is
 * mounted on and every page and asset is judged by `robots.txt`, which is an honour
 * system — and the shape of that gap is easy to miss, because an empty feed for static
 * routes looks exactly like a quiet site.
 *
 * nginx's `auth_request` closes it. Every request is sent to this endpoint as a
 * subrequest first; what it answers decides what happens to the real one.
 *
 * ## What this costs, said before you build on it
 *
 * **The subrequest has no body.** nginx sends `auth_request` a GET with the headers and
 * no content, so anything reading a body cannot work here — the trap *form field* most
 * of all. Trap links still work, because those are a path.
 *
 * **It is a second round trip on every request**, including every image and font. Scope
 * it with `location` blocks rather than putting it in front of the whole site out of
 * habit.
 *
 * **The interstitial needs `error_page`.** `auth_request` can only allow or refuse — it
 * has no way to return a page — so a challenge is a 401 that nginx turns into a real
 * response by fetching it from here. That is the `error_page` line in the config below,
 * and without it a challenged visitor gets nginx's own error page and no way through.
 */
import { createServer } from "node:http";
import { BotHandler, createFacts } from "../src/index.js";

const PORT = Number(process.env["PORT"] ?? 9680);

const detector = new BotHandler({
  preset: "protect-content",
  // The address is nginx's unless it is told otherwise; see the `X-Real-IP` line in the
  // config below and `docs/integration/client-ip.md` for why this is the setting to get
  // right before any other.
  proxy: { trustProxy: true, hops: 1 },
  challenge: { secrets: [process.env["CHALLENGE_SECRET"] ?? "a-secret-of-at-least-32-characters!!"] },
});

/**
 * The statuses nginx is told to read.
 *
 * `auth_request` treats 2xx as "carry on" and 401/403 as "do not", and nothing else is
 * meaningful to it — so everything this library can decide has to be folded into those
 * three, with the interesting cases routed through `error_page` on the nginx side.
 */
const ALLOW = 204;
const CHALLENGE = 401;
const REFUSE = 403;

const server = createServer((request, response) => {
  void (async () => {
    // The subrequest is a GET carrying the original request's headers, so the method and
    // the target have to be passed across explicitly — `auth_request` does not preserve
    // either, and judging every request as a GET for `/` would make half the detectors
    // read the same thing about everybody.
    const headers = request.headers as Record<string, string>;
    const method = headers["x-original-method"] ?? "GET";
    const url = headers["x-original-uri"] ?? "/";

    const facts = createFacts({
      method,
      url,
      headers: request.headers as Record<string, string | string[] | undefined>,
      rawHeaders: request.rawHeaders,
      ip: headers["x-real-ip"] ?? request.socket.remoteAddress ?? "0.0.0.0",
      protocol: headers["x-forwarded-proto"] === "https" ? "https" : "http",
    });

    const { outcome, decision } = await detector.handle(facts);

    if (outcome.kind === "drop") {
      // Nothing to answer with: the connection is meant to end. A refusal is the closest
      // `auth_request` can express, and nginx closes its own connection after it.
      response.writeHead(REFUSE).end();
      return;
    }

    if (outcome.kind === "respond") {
      // A challenge is the one refusal the visitor is meant to get *through*, so it is
      // answered as 401 and the page itself is served by the `error_page` route below.
      // Everything else is a plain refusal.
      const challenged = decision.action === "challenge";
      response.writeHead(challenged ? CHALLENGE : REFUSE, {
        // Read back on the nginx side with `auth_request_set`, so the real response can
        // carry the rate-limit headers this decision produced.
        ...pick(outcome.headers, ["retry-after", "x-ratelimit-limit", "x-ratelimit-remaining"]),
      });
      response.end();
      return;
    }

    // Served. Any request headers the decision added are handed back through
    // `auth_request_set` so the application behind nginx can read the verdict.
    response.writeHead(ALLOW, { ...(outcome.requestHeaders ?? {}) }).end();
  })().catch(() => {
    // A guard that fails open is a guard that stops guarding quietly; a guard that fails
    // *closed* takes the site down with it. Serving is the right default for an edge
    // check, and the failure is the operator's to notice in the notices panel.
    response.writeHead(ALLOW).end();
  });
});

function pick(source: Record<string, string>, names: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const value = source[name] ?? source[name.toLowerCase()];
    if (value !== undefined) out[name] = value;
  }
  return out;
}

server.listen(PORT, () => {
  console.log(`edge guard listening on :${PORT}`);
  console.log(`
  nginx:

    location = /_guard {
      internal;
      proxy_pass              http://127.0.0.1:${PORT}/;
      proxy_pass_request_body off;
      proxy_set_header        Content-Length "";
      proxy_set_header        X-Original-URI    $request_uri;
      proxy_set_header        X-Original-Method $request_method;
      proxy_set_header        X-Real-IP         $remote_addr;
      proxy_set_header        X-Forwarded-Proto $scheme;
    }

    location / {
      auth_request      /_guard;
      auth_request_set  $verdict $upstream_http_x_bot_verdict;
      proxy_set_header  X-Bot-Verdict $verdict;

      error_page 401 = @challenge;
      proxy_pass http://your-application;
    }

    # The interstitial, which auth_request cannot return by itself.
    location @challenge {
      proxy_pass http://127.0.0.1:${PORT}/;
    }
`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close();
    process.exit(0);
  });
}
