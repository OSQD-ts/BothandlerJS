/**
 * The same engine on a Web-standard runtime — Cloudflare Workers, Deno, Bun, Vercel
 * Edge. One `export default`, no framework.
 *
 * The engine uses `node:crypto`, so on Workers enable `nodejs_compat` in
 * `wrangler.toml`. Deno and Bun provide it natively.
 */
import { BotHandler, defaultDetectors } from "../src/index.js";
import { withBotHandler } from "../src/adapters/index.js";

const detector = new BotHandler({
  preset: "protect-data",
  challenge: { secrets: [process.env["BOT_SECRET"] ?? "development-secret-not-for-production!!"] },

  // At an edge, the platform header is the only address you have — and it is only
  // trustworthy because the platform overwrites it. Never list a header a client can set.
  proxy: { trustProxy: true, header: "cf-connecting-ip", hops: 1 },

  // Header order carries no meaning over HTTP/2 — nearly all edge traffic — and the
  // Fetch API normalises and sorts headers anyway, so the detector could only ever
  // return nothing. Dropping it is honest rather than merely faster.
  detectors: defaultDetectors().filter((detector) => detector.id !== "header-order"),
});

const handler = withBotHandler(
  detector,
  async (request) => {
    const verdict = request.headers.get("x-bot-verdict");
    return new Response(`assessed as: ${verdict}\n`, { headers: { "content-type": "text/plain" } });
  },
  {
    ipHeaders: ["cf-connecting-ip"],
    // Cloudflare computes a JA3 hash at the edge, where a client cannot forge it.
    tlsFingerprintHeader: "cf-ja3-hash",
  },
);

export default { fetch: handler };
