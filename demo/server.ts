#!/usr/bin/env tsx
/**
 * The demo. One command, two listeners:
 *
 *   npm run demo
 *
 *   :9673  a small protected site — the thing bots actually hit
 *   :9674  a live dashboard showing every assessment as it happens
 *
 * Then, in a second terminal:
 *
 *   npm run simulate
 *
 * The dashboard is the one the library ships — `detector.serveDashboard()` — not a
 * demo-only page. What you see here is what you get in your own application, which is
 * the point: the demo exercises the shipped code path rather than a parallel copy of
 * it that can quietly drift.
 *
 * The two listeners are separate on purpose, and `serveDashboard` enforces it. The
 * dashboard is not behind the bot handler, so watching the dashboard never shows up in
 * the dashboard — and a challenge served to the demo site can never lock you out of
 * the tool you are using to read about it.
 *
 * The policy below is deliberately a little more aggressive than the shipped preset,
 * because the most instructive thing this demo has to show is the **safety guard**
 * refusing to carry a rule out. Watch for the amber "downgraded" rows.
 */
import express from "express";
import { BotHandler, DEFAULT_TRAP_PATHS, TRAP_FIELD_SOURCE, defaultDetectors, renderTrapField, renderTrapLink, trapDetector, trapRobotsEntries } from "../src/index.js";
import { botHandler } from "../src/adapters/index.js";
import { parseClientSignals, renderClientScript } from "../src/client/index.js";
import type { RequestFacts } from "../src/index.js";

/** Defaults. Override with SITE_PORT / GUI_PORT if either is taken. */
const DEFAULT_SITE_PORT = 9673;
const DEFAULT_GUI_PORT = 9674;

const SITE_PORT = Number(process.env["SITE_PORT"] ?? DEFAULT_SITE_PORT);
const GUI_PORT = Number(process.env["GUI_PORT"] ?? DEFAULT_GUI_PORT);

/**
 * Signals the page script reported, keyed by address.
 *
 * A real deployment would key this by session and put it somewhere shared. Keeping
 * the storage decision out of the library is deliberate — where per-session data
 * lives is a choice only your application can make.
 */
const clientSignals = new Map<string, unknown>();

/** The hidden field planted in the login form. Rendered *and* registered — both halves are required. */
const TRAP_FIELD = "company_url";

const detector = new BotHandler({
  // Configuring a built-in detector means replacing it in the list rather than
  // appending (duplicate ids are rejected, so a second `trap` cannot silently
  // shadow the first). Registering the form field is easy to forget, and forgetting
  // it means the field is rendered, filled by bots, and never checked.
  detectors: defaultDetectors().map((entry) => (entry.id === "trap" ? trapDetector({ formFields: [TRAP_FIELD] }) : entry)),

  // The published ranges an operator would fetch on a schedule. Hard-coded here so
  // the simulator can demonstrate a *verified* crawler without any DNS at all —
  // 198.51.100.0/24 is the documentation range, and the simulator crawls from it.
  crawlerRanges: { gptbot: ["198.51.100.0/24"] },

  // The marker probe, on here so the demo exercises it and the dashboard has something
  // to show for it. Off by default in the library itself, and `secure: false` because
  // the demo serves plain HTTP — which is exactly the case the warning it prints
  // describes. `site` is deliberately *not* enabled: a baseline needs far more traffic
  // than a demo produces, so it would warn and then detect nothing.
  probe: { secrets: ["a-demo-only-marker-secret-not-for-production"], secure: false },

  challenge: {
    secrets: ["demo-secret-only-for-the-local-demo-do-not-ship"],
    difficulty: 14, // a little easier than the default so the interstitial is quick
    cookieSecure: false, // plaintext localhost only
    contactHtml: '<p>In a real deployment this is where you tell people how to reach a human.</p>',
  },

  ignorePaths: ["/healthz", "/favicon.ico", "/signals"],

  // Off by default in the library — two clock reads per detector per request. On here
  // so the dashboard's detector list shows what each one actually costs.
  metrics: { perDetectorTiming: true },

  // Demo only. Echoing the verdict back lets the simulator report what happened,
  // and would let anyone tuning a scraper against you watch their score fall as
  // they iterate. Leave it off in production; the request-side tag carries the
  // same information to your own handlers and tells the client nothing.
  exposeVerdictHeaders: true,

  // The simulator gives every scenario its own source address, so each one is a
  // distinct actor and the behavioural detectors have something to work with.
  proxy: { trustProxy: true, hops: 1 },

  rules: [
    { id: "allow-verified", match: { verdict: "verified-bot" }, action: "allow", reason: "Identity confirmed against the operator's published ranges." },
    { id: "block-impersonators", match: { botClass: "impersonator", certain: true }, action: "block", params: { status: 403 } },
    { id: "block-scanners", match: { botClass: "scanner", certain: true }, action: "block", params: { status: 403 } },
    { id: "block-traps", match: { detector: "trap", certain: true }, action: "block", params: { status: 403 } },
    { id: "challenge-clients", match: { botClass: ["http-client", "automation"], certain: true }, action: "challenge" },
    { id: "limit-declared-bots", match: { botClass: "declared-bot" }, action: "rate-limit", params: { limit: { max: 30, windowMs: 60_000 } } },

    // Deliberately overreaching, and the point of the whole demo. This asks to block
    // on probabilistic evidence; strict mode refuses and substitutes a challenge,
    // recording both. Every amber row in the dashboard is this rule being stopped.
    { id: "block-suspected-OVERREACH", match: { verdict: "suspected-bot" }, action: "block", params: { status: 403 } },

    { id: "delay-logins", match: { path: "/login", method: "POST" }, action: "delay", params: { delayMs: 250 } },
  ],
  defaultAction: "allow",

  // The audit's spans are tiny here so a simulator run is enough to trip it; the
  // defaults are a five-minute window against the hour before.
  audit: { windowMs: 30_000, baselineMs: 120_000, minSamples: 20, intervalMs: 5_000, cooldownMs: 30_000 },

  // The hooks. Every one of these is also an event on `detector.on(...)` — this is
  // the shape a real integration takes: your logger, your pager, your own webhook.
  onDenial: ({ assessment, decision }) => console.log(`  ! denied ${assessment.facts.path} by "${decision.rule}"`),
  onDowngrade: ({ decision }) => console.log(`  ~ guard refused "${decision.rule}" (${decision.downgradedFrom} -> ${decision.action})`),
  onAnomaly: (anomaly) => console.warn(`  # audit: ${anomaly.severity} — ${anomaly.summary}`),
  onPolicyChange: ({ rules }) => console.warn(`  # policy now: ${rules.join(", ")}`),

  onWarning: (message) => console.warn("  ! " + message),
  onError: (error, context) => console.error("  ! " + context.source, error),
});

// ---------------------------------------------------------------------------
// A line per decision in the terminal. The dashboard shows the same events with the
// evidence attached; this is for the half of the audience that lives in a terminal.
// ---------------------------------------------------------------------------

detector.on("decision", ({ assessment, decision }) => {
  const mark = decision.downgradedFrom ? "~" : decision.action === "allow" ? " " : "*";
  console.log(
    `${mark} ${assessment.facts.method} ${assessment.facts.path.padEnd(28)} ${assessment.verdict.padEnd(14)} ` +
      `${assessment.certain ? "proven" : `score ${String(assessment.score).padStart(3)}`}  -> ${decision.action}` +
      (decision.downgradedFrom ? `  (downgraded from ${decision.downgradedFrom})` : ""),
  );
});

// ---------------------------------------------------------------------------
// :9673 — the protected site
// ---------------------------------------------------------------------------

const site = express();

// Ahead of the handler, and only for form posts. The engine reads no request body, so
// the honeypot field rendered into the sign-in form below arrives somewhere it cannot
// see unless something parses it first and hands it over. This only touches
// `application/x-www-form-urlencoded`, so the challenge endpoint's JSON body still
// reaches the raw-stream reader untouched.
site.use(express.urlencoded({ extended: false, limit: "16kb" }));

site.use(
  botHandler(detector, {
    // Hand the page script's report and the submitted form fields to the detectors
    // through `facts.extra`, which is the seam the library leaves for exactly this.
    enrich: (request, facts: RequestFacts): RequestFacts => {
      const signals = clientSignals.get(facts.ip);
      const body = (request as { body?: unknown }).body;
      const extra: Record<string, unknown> = { ...facts.extra };
      if (signals !== undefined) extra["clientSignals"] = signals;
      if (typeof body === "object" && body !== null) extra[TRAP_FIELD_SOURCE] = body;
      return Object.keys(extra).length === 0 ? facts : { ...facts, extra };
    },
  }),
);

site.use(express.json({ limit: "16kb" }));

site.post("/signals", (request, response) => {
  const parsed = parseClientSignals(request.body);
  const ip = detector.resolveIp(request.socket.remoteAddress, request.headers as Record<string, string | undefined>);
  if (parsed) clientSignals.set(ip, parsed);
  response.status(204).end();
});

site.get("/robots.txt", (_request, response) => {
  response.type("text/plain").send(trapRobotsEntries(DEFAULT_TRAP_PATHS));
});

site.get("/healthz", (_request, response) => response.type("text/plain").send("ok"));

const PRODUCTS = Array.from({ length: 40 }, (_, index) => ({ id: index + 1, name: `Widget ${index + 1}`, price: 9 + index }));

site.get("/api/items", (_request, response) => response.json(PRODUCTS));

site.get("/products/:id", (request, response) => {
  const product = PRODUCTS.find((entry) => String(entry.id) === request.params.id);
  if (!product) return response.status(404).type("text/plain").send("not found");
  return response.type("html").send(page(`${product.name}`, `<p>Price: $${product.price}</p><p><a href="/products">Back to all products</a></p>`, request));
});

site.get("/products", (request, response) => {
  const list = PRODUCTS.map((product) => `<li><a href="/products/${product.id}">${product.name}</a></li>`).join("");
  response.type("html").send(page("Products", `<ul>${list}</ul>`, request));
});

site.get("/search", (request, response) => {
  const query = String(request.query["q"] ?? "");
  response.type("html").send(page("Search", `<p>No results for <strong>${escapeHtml(query)}</strong>.</p>`, request));
});

site.get("/login", (request, response) => {
  response.type("html").send(
    page(
      "Sign in",
      `<form method="post" action="/login">
         <p><label>Email <input name="email" type="email" autocomplete="username"></label></p>
         <p><label>Password <input name="password" type="password" autocomplete="current-password"></label></p>
         ${renderTrapField(TRAP_FIELD)}
         <p><button type="submit">Sign in</button></p>
       </form>`,
      request,
    ),
  );
});

site.post("/login", (_request, response) => {
  response.status(401).type("text/plain").send("Invalid credentials.\n");
});

site.get("/", (request, response) => {
  response.type("html").send(
    page(
      "bothandlerjs demo",
      `<p>A small site behind the bot handler. Every request you make appears on the
          <a href="http://localhost:${GUI_PORT}/">dashboard</a> within a moment.</p>
       <ul>
         <li><a href="/products">Products</a> — 40 pages, enough for the crawl-breadth detector to notice enumeration</li>
         <li><a href="/login">Sign in</a> — carries a hidden trap field</li>
         <li><a href="/api/items">/api/items</a> — a JSON endpoint worth scraping</li>
         <li><a href="/robots.txt">robots.txt</a> — publishes the trap paths, as it must</li>
       </ul>
       <p>Run <code>npm run simulate</code> in another terminal to point fifteen
          different kinds of client at this.</p>`,
      request,
    ),
  );
});

// ---------------------------------------------------------------------------
// :9674 — the dashboard, straight from the library.
//
// `controls: { reset: true }` is on because this is a demo and resetting the actor
// registry between simulator runs is the whole workflow. It is off by default in the
// library, and should stay off anywhere the registry holds real history.
// ---------------------------------------------------------------------------

const dashboard = await detector.serveDashboard({
  port: GUI_PORT,
  title: "bothandlerjs demo",
  links: [{ label: "Demo site", href: `http://localhost:${SITE_PORT}/` }],
  // Both controls are on because this is a demo on loopback and the whole point is to
  // let you press things. Both are off by default in the library: `reset` discards the
  // actor registry, and `editPolicy` rewrites the running rule set.
  controls: { reset: true, editPolicy: true },
  exposePrometheus: true,
});

// ---------------------------------------------------------------------------

function page(title: string, body: string, request: express.Request): string {
  const verdict = String(request.headers["x-bot-verdict"] ?? "unknown");
  const score = String(request.headers["x-bot-score"] ?? "0");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root{color-scheme:light dark}
  body{max-width:44rem;margin:3rem auto;padding:0 1.25rem;font:16px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
  code{background:color-mix(in srgb,currentColor 10%,transparent);padding:.1em .35em;border-radius:4px}
  .verdict{font:13px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;opacity:.7;border-top:1px solid color-mix(in srgb,currentColor 20%,transparent);margin-top:2.5rem;padding-top:1rem}
  ul{padding-left:1.2rem}
</style></head>
<body>
  <h1>${escapeHtml(title)}</h1>
  ${body}
  <p class="verdict">This request was assessed as <strong>${escapeHtml(verdict)}</strong> (score ${escapeHtml(score)}).<br>
     The verdict reaches this handler as a request header, so the page can react without re-running detection.</p>
  ${renderTrapLink("/internal/export.csv", { label: "Complete data export" })}
  ${renderClientScript({ endpoint: "/signals" })}
</body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
}

/**
 * A port already in use is the single most likely thing to go wrong on a first run —
 * usually a demo from five minutes ago that is still alive. An unhandled
 * `EADDRINUSE` surfaces as a raw stack trace, which buries the one fact that
 * actually helps.
 */
function fatal(server: { on(event: "error", listener: (error: NodeJS.ErrnoException) => void): unknown }, port: number, label: string): void {
  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      console.error(`\n  Port ${port} is already in use, so the ${label} cannot start.`);
      console.error(`  Another demo is probably still running. Stop it, or pick a different port:\n`);
      console.error(`      SITE_PORT=9675 GUI_PORT=9676 npm run demo\n`);
    } else {
      console.error(`\n  The ${label} failed to start: ${error.message}\n`);
    }
    process.exit(1);
  });
}

fatal(site as unknown as Parameters<typeof fatal>[0], SITE_PORT, "demo site");

const httpSite = site.listen(SITE_PORT, () => {
  const line = "─".repeat(64);
  console.log(`\n${line}`);
  console.log("  bothandlerjs demo");
  console.log(line);
  console.log(`  dashboard   ${dashboard.url}     <- open this`);
  console.log(`  demo site   http://localhost:${SITE_PORT}/`);
  console.log(`\n  ${detector.describeDetectors().length} detectors, ${detector.policy.ruleIds.length} rules`);
  // Carry the ports into the suggested command. On anything but the defaults a bare
  // `npm run simulate` looks for the default port, fails, and the message blames
  // the wrong thing.
  const custom = SITE_PORT !== DEFAULT_SITE_PORT || GUI_PORT !== DEFAULT_GUI_PORT;
  console.log(`  then run:   ${custom ? `SITE_URL=http://127.0.0.1:${SITE_PORT} GUI_PORT=${GUI_PORT} ` : ""}npm run simulate`);
  console.log(`${line}\n`);
});

// Shut both listeners down on Ctrl-C rather than leaving a half-dead process
// holding the ports — which is exactly how the "port already in use" above happens.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    httpSite.close();
    void dashboard.close().then(() => process.exit(0));
  });
}
