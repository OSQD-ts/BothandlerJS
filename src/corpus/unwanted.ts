import { plain } from "./headers.js";
import { bot } from "./schema.js";
import type { TrafficCase } from "./schema.js";

/**
 * Automation that is honest about itself and that most sites would still rather not
 * serve.
 *
 * SEO and market-intelligence crawlers are run by legitimate businesses doing
 * legitimate work. They also cost you bandwidth to build a product you are not paid
 * for, and at scale a handful of them can outweigh your human traffic. Declining them
 * is a business decision rather than a security one, and the corpus's only assertion
 * is that the library names them precisely enough for a rule to be written.
 *
 * All of them declare themselves, so all of them are `certain`. That matters: a
 * policy that declines these is acting on a statement the crawler made, not on a
 * guess, so it can decline them without any risk to a person.
 */

function seo(id: string, title: string, userAgent: string, identity: string, provenance: string, notes?: string): TrafficCase {
  return bot({
    id,
    title,
    audience: "unwanted-bot",
    category: "seo-crawler",
    provenance,
    ...(notes !== undefined ? { notes } : {}),
    requests: [plain(userAgent)],
    expect: { verdict: "confirmed-bot", certain: true, identity, detectors: ["self-identified"] },
  });
}

export const UNWANTED_BOT_CASES: TrafficCase[] = [
  seo("ahrefsbot", "AhrefsBot", "Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)", "ahrefsbot", "Backlink index crawler; publishes FCrDNS under ahrefs.com, so it is one of the few here that can actually be verified"),
  seo("ahrefs-site-audit", "AhrefsSiteAudit", "Mozilla/5.0 (compatible; AhrefsSiteAudit/6.1; +http://ahrefs.com/robot/site-audit)", "ahrefsbot", "Runs when somebody audits your site — possibly you"),
  seo("semrushbot", "SemrushBot", "Mozilla/5.0 (compatible; SemrushBot/7~bl; +http://www.semrush.com/bot.html)", "semrushbot", "Competitive research crawler"),
  seo("mj12bot", "MJ12bot", "Mozilla/5.0 (compatible; MJ12bot/v1.4.8; http://mj12bot.com/)", "mj12bot", "Majestic's distributed crawler — it runs on volunteers' machines, so it arrives from residential addresses"),
  seo("dotbot", "DotBot", "Mozilla/5.0 (compatible; DotBot/1.2; +https://opensiteexplorer.org/dotbot; help@moz.com)", "dotbot", "Feeds Moz's link index and Open Site Explorer"),
  seo("blexbot", "BLEXBot", "Mozilla/5.0 (compatible; BLEXBot/1.0; +http://webmeup-crawler.com/)", "blexbot", "Link research crawler feeding a backlink index"),
  seo("dataforseo", "DataForSeoBot", "Mozilla/5.0 (compatible; DataForSeoBot/1.0; +https://dataforseo.com/dataforseo-bot)", "dataforseo", "SERP and backlink data as a service"),
  seo("serpstatbot", "Serpstatbot", "serpstatbot/2.1 (advanced backlink tracking bot; https://serpstatbot.com/; abuse@serpstatbot.com)", "serpstatbot", "Backlink tracking for an SEO analytics product"),
  seo("barkrowler", "Barkrowler", "Mozilla/5.0 (compatible; Barkrowler/0.9; +https://babbar.tech/crawler)", "barkrowler", "Builds a link graph for the Babbar SEO product"),
  seo("zoominfobot", "ZoominfoBot", "ZoominfoBot (zoominfobot at zoominfo dot com)", "zoominfobot", "Harvests contact data for a sales product — a crawler many sites decline on privacy grounds rather than cost"),

  bot({
    id: "seo-crawler-aggressive-rate",
    title: "An SEO crawler ignoring Crawl-delay",
    audience: "unwanted-bot",
    category: "seo-crawler",
    provenance: "Declared crawlers sometimes crawl far faster than a site can comfortably serve",
    notes:
      "Honest and inconsiderate at once. The right answer is a rate limit, not a block: it identified itself truthfully, and the problem is throughput rather than deception.",
    requests: Array.from({ length: 40 }, (_, index) => ({
      ...plain("Mozilla/5.0 (compatible; SemrushBot/7~bl; +http://www.semrush.com/bot.html)"),
      path: `/products/${index + 1}`,
      atMs: index * 120,
    })),
    expect: { verdict: "confirmed-bot", certain: true, identity: "semrushbot" },
  }),

  bot({
    id: "unrecognised-polite-crawler",
    title: "A crawler nobody has heard of that follows the conventions",
    audience: "declared-bot",
    category: "unknown-crawler",
    provenance: "New crawlers appear constantly; the convention of naming yourself and publishing a contact URL does not change",
    notes:
      "Not in any signature database and correctly handled anyway. Word plus contact address is a declaration, so it reaches `certain` on structure alone — which is what keeps the library useful as the world adds crawlers.",
    requests: [plain("Mozilla/5.0 (compatible; NewIndexBot/0.4; +https://newindex.example/about-our-crawler)")],
    expect: { verdict: "confirmed-bot", botClass: "declared-bot", certain: true },
  }),

  bot({
    id: "crawler-word-without-contact",
    title: "A crawler-ish name with no contact address",
    audience: "unwanted-bot",
    category: "unknown-crawler",
    provenance: "Half of the convention followed",
    notes: "Suggestive, not conclusive. Without the contact address there is no declaration of intent, only a word.",
    requests: [plain("Mozilla/5.0 (compatible; Some Spider 1.0)")],
    expect: { verdict: "suspected-bot", certain: false, botClass: "declared-bot", minScore: 55 },
  }),
];
