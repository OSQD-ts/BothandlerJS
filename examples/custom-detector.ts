/**
 * Extending the library: a custom detector, a custom action, and a custom actor key.
 *
 * The example detector is a real and useful one — it catches a client that asks for a
 * page it could not have known about without reading your sitemap. It is also a good
 * illustration of the certainty rules: it is `strong`, not `certain`, because a
 * person can reach a deep link from a bookmark, a chat message or a search result.
 */
import { BotHandler, defineHandler } from "../src/index.js";
import type { Detector, Evidence } from "../src/index.js";

function sitemapOnlyPathDetector(paths: ReadonlySet<string>): Detector {
  return {
    id: "sitemap-only-path",
    description: "Requests a path that appears only in the sitemap, never in the rendered navigation",
    cost: "cheap",
    stage: "always",

    inspect(context): Evidence | undefined {
      if (!paths.has(context.facts.path)) return undefined;
      // No Referer and no prior request from this actor: nothing led here.
      if (context.facts.headers["referer"] !== undefined) return undefined;
      if (context.state.total > 1) return undefined;

      return {
        detector: "sitemap-only-path",
        summary: `First request from this actor went straight to ${context.facts.path}, which is linked only from the sitemap`,
        direction: "bot",
        // Deliberately not `certain`. A bookmark, a shared link or a search result
        // all put a real person here with no Referer and no history.
        certainty: "strong",
        weight: 0.55,
        botClass: "scraper",
        metadata: { path: context.facts.path },
      };
    },
  };
}

/** A custom action: serve a deliberately stale cached copy instead of refusing. */
const serveStale = defineHandler({
  id: "serve-stale",
  description: "Serves a cached snapshot rather than the live page",
  execute(context) {
    return {
      kind: "respond",
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8", "x-served": "stale", "cache-control": "public, max-age=3600" },
      body: `<!doctype html><title>Archive</title><p>A cached copy of ${context.assessment.facts.path}.</p>`,
    };
  },
});

export const detector = new BotHandler({
  extraDetectors: [sitemapOnlyPathDetector(new Set(["/products/legacy-sku-4471", "/archive/2019/notes"]))],
  handlers: [serveStale],

  // An actor key narrower than an address. With a session id in the mix, "one actor"
  // stops meaning "one office NAT", and every behavioural detector gets sharper —
  // sharp enough that `identityRotationDetector` becomes worth enabling.
  actorKey: (facts) => {
    const session = facts.cookies?.["sid"];
    return session !== undefined ? `sid:${session}` : `ip:${facts.ip}`;
  },

  rules: [
    { id: "stale-for-scrapers", match: { detector: "sitemap-only-path", minScore: 50 }, action: "custom", params: { handler: "serve-stale" } },
    { id: "proven-bots-blocked", match: { certain: true, botClass: ["scanner", "impersonator"] }, action: "block" },
  ],
});
