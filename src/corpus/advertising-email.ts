import { crawler, plain } from "./headers.js";
import { bot } from "./schema.js";
import type { TrafficCase } from "./schema.js";

/**
 * Advertising verification, and the machinery that opens links before people do.
 *
 * Two categories that share a property worth noticing: both fetch a page **because a
 * person is about to see it**, and neither is that person.
 *
 * Ad verification vendors load your landing pages to check they are what was sold —
 * that the creative rendered, that the page is brand-safe, that the impression was
 * viewable. Blocking them does not protect anything; it fails the verification, and
 * the campaign is what gets paused.
 *
 * Email link scanners are stranger and more consequential. Every enterprise mail
 * gateway rewrites links and fetches them before delivery, which means a link you
 * emailed to one customer arrives at your server first from Microsoft, Proofpoint or
 * Mimecast — often several times, from several regions, before the human clicks. If
 * those fetches are blocked the scanner may mark the link unsafe, and the person
 * never sees your page at all.
 */

function fetcher(id: string, title: string, category: string, userAgent: string, provenance: string, options: { notes?: string; audience?: TrafficCase["audience"]; certain?: boolean } = {}): TrafficCase {
  return bot({
    id,
    title,
    audience: options.audience ?? "benign-bot",
    category,
    provenance,
    ...(options.notes !== undefined ? { notes: options.notes } : {}),
    requests: [crawler(userAgent)],
    expect: options.certain === false ? { certain: false, neverAction: ["drop"] } : { verdict: "confirmed-bot", certain: true, detectors: ["self-identified"] },
  });
}

export const ADVERTISING_EMAIL_CASES: TrafficCase[] = [
  // ---------------------------------------------------------------------------
  // Ad verification, viewability and brand safety.
  // ---------------------------------------------------------------------------
  fetcher("adv-doubleverify", "DoubleVerify", "ad-verification", "Mozilla/5.0 (compatible; DoubleVerifyBot/1.0; +https://doubleverify.com/bot)", "Verifies that ads rendered on a brand-safe page; its verdict decides whether an impression is billable"),
  fetcher("adv-ias", "Integral Ad Science", "ad-verification", "Mozilla/5.0 (compatible; IAS crawler; +https://integralads.com/site-indexing-policy/)", "Brand-safety classification of pages carrying advertising"),
  fetcher("adv-moat", "Oracle Moat", "ad-verification", "Mozilla/5.0 (compatible; MoatBot/1.0; +https://moat.com/bot)", "Viewability and attention measurement"),
  fetcher("adv-comscore", "Comscore", "ad-verification", "Mozilla/5.0 (compatible; proximic; +https://www.comscore.com/Web-Crawler)", "Contextual classification for audience measurement; the crawler still uses its acquired Proximic name"),
  fetcher("adv-grapeshot", "Grapeshot", "ad-verification", "Mozilla/5.0 (compatible; GrapeshotCrawler/2.0; +http://www.grapeshot.co.uk/crawler.php)", "Contextual keyword classification, now part of Oracle"),
  fetcher("adv-peer39", "Peer39", "ad-verification", "Mozilla/5.0 (compatible; Peer39Bot/1.0; +https://www.peer39.com/bot)", "Page-level contextual categorisation for advertisers"),
  fetcher("adv-adbeat", "Adbeat", "ad-verification", "Mozilla/5.0 (compatible; Adbeat_Bot; +https://www.adbeat.com/operation_policy)", "Competitive advertising intelligence", { audience: "unwanted-bot" }),
  fetcher("adv-adsbot-landing", "AdsBot checking a landing page", "ad-verification", "AdsBot-Google-Mobile (+http://www.google.com/mobile/adsbot.html)", "Google's mobile landing-page quality checker; blocking it lowers ad quality scores directly"),
  fetcher("adv-bing-ads", "Microsoft Advertising landing check", "ad-verification", "Mozilla/5.0 (compatible; adidxbot/2.0; +http://www.bing.com/bingbot.htm)", "The equivalent for Microsoft Advertising"),
  fetcher("adv-criteo", "Criteo", "ad-verification", "Mozilla/5.0 (compatible; CriteoBot/0.1; +https://www.criteo.com/criteo-crawler/)", "Retargeting; crawls product pages to build creatives"),
  fetcher("adv-taboola", "Taboola", "ad-verification", "Mozilla/5.0 (compatible; TaboolaBot/1.0; +https://www.taboola.com/bot)", "Content recommendation crawling"),
  fetcher("adv-outbrain", "Outbrain", "ad-verification", "Mozilla/5.0 (compatible; OutbrainBot/1.0; +https://www.outbrain.com/bot)", "Content recommendation crawling"),
  fetcher("adv-pubmatic", "PubMatic", "ad-verification", "Mozilla/5.0 (compatible; PubMaticBot/1.0; +https://pubmatic.com/bot)", "Supply-side platform verifying inventory"),
  fetcher("adv-ttd", "The Trade Desk", "ad-verification", "Mozilla/5.0 (compatible; TTD-Content/1.0; +https://www.thetradedesk.com/general/crawler)", "Demand-side contextual crawling"),

  // ---------------------------------------------------------------------------
  // Email link protection. Fires before a person clicks, sometimes long before.
  // ---------------------------------------------------------------------------
  bot({
    id: "email-microsoft-safelinks",
    title: "Microsoft Defender Safe Links",
    audience: "benign-bot",
    category: "email-link-scanner",
    provenance: "Microsoft 365 rewrites every link in inbound mail and fetches it at delivery time and again at click time",
    notes:
      "Almost every corporate recipient sits behind this. If a marketing email goes to ten thousand Microsoft 365 mailboxes, your server sees ten thousand fetches from Microsoft before a single person clicks — and blocking them can mark the link unsafe, so nobody ever arrives.",
    requests: [crawler("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 BingPreview/1.0b")],
    expect: { verdict: "confirmed-bot", certain: true, identity: "bingbot" },
  }),
  fetcher("email-proofpoint", "Proofpoint URL Defense", "email-link-scanner", "Mozilla/5.0 (compatible; ProofpointURLDefenseBot/1.0; +https://www.proofpoint.com/us/threat-reference/url-defense)", "Rewrites and pre-fetches links in enterprise mail"),
  fetcher("email-mimecast", "Mimecast URL Protect", "email-link-scanner", "Mozilla/5.0 (compatible; MimecastURLProtectBot/1.0; +https://www.mimecast.com/products/url-protect/)", "The same mechanism, very common in the UK and Australia"),
  fetcher("email-barracuda", "Barracuda Link Protection", "email-link-scanner", "Mozilla/5.0 (compatible; BarracudaLinkProtectBot/1.0; +https://www.barracuda.com/link-protection)", "Mail-gateway link scanning"),
  fetcher("email-cisco-esa", "Cisco Secure Email", "email-link-scanner", "Mozilla/5.0 (compatible; CiscoSecureEmailBot/1.0; +https://www.cisco.com/go/emailsecurity)", "Outbreak filters fetch URLs before delivery"),
  fetcher("email-google-safe", "Gmail link scanning", "email-link-scanner", "Mozilla/5.0 (compatible; Google-Safety; +http://www.google.com/bot.html)", "Gmail checks links against Safe Browsing before showing them"),
  fetcher("email-slack-unfurl", "Slack unfurling a link posted in a channel", "email-link-scanner", "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)", "Fires the instant somebody pastes a URL, before anyone opens it"),
  fetcher("email-teams-unfurl", "Microsoft Teams unfurling a link", "email-link-scanner", "Mozilla/5.0 (compatible; MicrosoftPreview/2.0; +https://aka.ms/MicrosoftPreview)", "Teams renders its own preview cards"),
  fetcher("email-zoom-preview", "Zoom chat link preview", "email-link-scanner", "Mozilla/5.0 (compatible; ZoomBot/1.0; +https://zoom.us/bot)", "Chat clients preview links the same way mail gateways scan them"),
  bot({
    id: "email-newsletter-open-tracker",
    title: "An email client fetching a tracking pixel",
    audience: "infrastructure",
    category: "email-link-scanner",
    provenance: "Apple Mail Privacy Protection pre-fetches every remote image in every message, from Apple's own infrastructure, whether or not the message is opened",
    notes:
      "Why open rates stopped meaning anything. From a server's point of view this is a fetch with no person attached, at a time nobody chose, from an address that belongs to neither party.",
    requests: [plain("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)", [["Accept", "image/avif,image/webp,image/apng,image/*,*/*;q=0.8"], ["Accept-Encoding", "gzip, deflate, br"], ["Accept-Language", "en-GB,en;q=0.9"]])],
    expect: { certain: false, neverAction: ["drop"] },
  }),

  // ---------------------------------------------------------------------------
  // Chat and messaging previews, which behave like both of the above.
  // ---------------------------------------------------------------------------
  fetcher("preview-signal", "Signal link preview", "link-unfurler", "Mozilla/5.0 (compatible; SignalBot/1.0; +https://signal.org/bot)", "Signal generates previews on the sender's device before the message is sent"),
  fetcher("preview-imessage", "iMessage rich link", "link-unfurler", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)", "iMessage builds Rich Links using Applebot"),
  fetcher("preview-matrix", "A Matrix homeserver preview", "link-unfurler", "Mozilla/5.0 (compatible; Synapse/1.121.0; +https://matrix.org/docs/spec/)", "Every Matrix homeserver generates its own previews, so one link fetches from many servers"),
  fetcher("preview-bluesky", "Bluesky link card", "link-unfurler", "Mozilla/5.0 (compatible; BlueskyBot/1.0; +https://bsky.app/about/bot)", "Builds the link card shown in a post"),
  fetcher("preview-threads", "Threads link preview", "link-unfurler", "meta-externalfetcher/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)", "Meta's fetch-on-behalf-of-a-user crawler, shared across its products"),
];
