/**
 * The ordinary case: an Express site that wants to keep its search traffic, slow
 * down scrapers, and refuse only what it can prove.
 *
 * Run it with `npm run example`, then try:
 *
 *   curl -s localhost:3000/                       # proven http-client -> challenged
 *   curl -s localhost:3000/internal/export.csv    # trap -> blocked
 *   open http://localhost:3000/                   # a real browser -> served
 */
import express from "express";
import { BotHandler, renderTrapLink, trapRobotsEntries, DEFAULT_TRAP_PATHS } from "../src/index.js";
import { botHandler } from "../src/adapters/index.js";

const detector = new BotHandler({
  preset: "protect-content",

  // Everything below is the part worth copying. The preset is just rules.
  challenge: {
    // In production this comes from your secret manager, never from source.
    secrets: [process.env["BOT_SECRET"] ?? "development-secret-not-for-production!!"],
    cookieSecure: false, // plaintext localhost; drop this line anywhere real
    contactHtml: '<p>Trouble getting through? Email <a href="mailto:support@example.com">support@example.com</a>.</p>',
  },

  // Your own monitors and CI. Allowlisted actors skip detection entirely.
  //
  // Note what is *not* here: loopback. It is tempting, and it is a trap — the moment
  // this sits behind nginx or inside a container with a sidecar, every request in the
  // world arrives from 127.0.0.1 and the allowlist silently disables the library.
  // Allowlist the networks your monitors actually come from.
  allowlist: ["10.0.0.0/8"],

  // Health checks and your own polling endpoints. Detection would only ever see
  // machine-regular traffic here and be right about it, which helps nobody.
  ignorePaths: ["/healthz", "/metrics", "/favicon.ico"],

  // Behind a load balancer, name it. Left off, the forwarded header is ignored
  // entirely — which is the safe default and also wrong once you deploy.
  // proxy: { trustProxy: true, trustedProxies: ["10.0.0.0/8"] },

  notifications: {
    // `assessment` is absent on `anomaly` events, which describe a window of traffic
    // rather than one request.
    sinks: [{ id: "log", notify: (event) => console.log(`[bot] ${event.type}`, event.assessment?.verdict ?? event.anomaly?.summary ?? "", event.decision?.action ?? "") }],
  },

  onWarning: (message) => console.warn("[bothandler]", message),
  onError: (error, context) => console.error("[bothandler]", context.source, error),
});

const app = express();
app.use(botHandler(detector));

// Publish the trap paths. A crawler that obeys robots.txt is one you want to keep,
// and it should never be caught in a net it had no way to see.
app.get("/robots.txt", (_request, response) => {
  response.type("text/plain").send(trapRobotsEntries(DEFAULT_TRAP_PATHS));
});

app.get("/", (request, response) => {
  // The middleware tags the request, so your own handlers can react without
  // re-running any detection.
  const verdict = request.headers["x-bot-verdict"];
  response.type("html").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Example</title></head>
<body>
  <h1>Hello</h1>
  <p>This request was assessed as: <strong>${verdict}</strong></p>
  ${renderTrapLink("/internal/export.csv", { label: "Full data export" })}
</body></html>`);
});

app.get("/healthz", (_request, response) => response.send("ok"));

const server = app.listen(Number(process.env["PORT"] ?? 3000), () => {
  const address = server.address();
  console.log(`listening on http://localhost:${typeof address === "object" && address ? address.port : 3000}`);
  console.log("detectors:", detector.describeDetectors().map((entry) => entry.id).join(", "));
});
