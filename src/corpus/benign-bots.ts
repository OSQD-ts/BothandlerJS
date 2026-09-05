import { plain } from "./headers.js";
import { bot } from "./schema.js";
import { BINGBOT_IP, BINGBOT_PTR, GOOGLEBOT_IP, GOOGLEBOT_PTR, IN_RANGE } from "./ranges.js";
import type { CaseRequest, Expectation, TrafficCase } from "./schema.js";

/**
 * Automation almost every site wants to keep serving.
 *
 * Search crawlers bring the traffic. Link unfurlers render the share cards. Monitors
 * tell you the site is up. Feed readers are how a chunk of your audience actually
 * reads you. Getting any of these wrong is not a security incident — it is a slow,
 * quiet loss that shows up weeks later as a ranking drop or a dead preview, with
 * nothing in the logs pointing at the cause.
 *
 * Most declare themselves honestly, which is why `self-identified` reaches `certain`
 * on them: believing a client's own statement about itself cannot misclassify an
 * honest one. Only a handful publish a *verifiable* identity, and those are the only
 * ones that can reach `verified-bot`.
 */

/** A crawler that names itself and can be taken at its word, but not confirmed. */
function declared(id: string, title: string, category: string, userAgent: string, provenance: string, identity: string, extra?: Partial<TrafficCase>): TrafficCase {
  return bot({
    id,
    title,
    audience: "benign-bot",
    category,
    provenance,
    requests: [plain(userAgent)],
    expect: { verdict: "confirmed-bot", certain: true, identity, detectors: ["self-identified"] },
    ...extra,
  });
}

const CRAWLER_HEADERS: CaseRequest["headers"] = [
  ["Host", "shop.example"],
  ["Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"],
  ["Accept-Encoding", "gzip, deflate, br"],
  ["From", "googlebot(at)googlebot.com"],
];

const VERIFIED: Expectation = { verdict: "verified-bot", certain: true, detectors: ["crawler-verification"] };

export const BENIGN_BOT_CASES: TrafficCase[] = [
  // ---------------------------------------------------------------------------
  // Search crawlers whose identity can actually be confirmed. These are the cases
  // that must reach `verified-bot`, because a policy that allows verified crawlers
  // is worthless if verification never succeeds.
  // ---------------------------------------------------------------------------
  bot({
    id: "googlebot-verified",
    title: "Googlebot, confirmed by forward-confirmed reverse DNS",
    audience: "benign-bot",
    category: "search-crawler",
    provenance: "Google documents FCrDNS under googlebot.com as the verification method",
    requests: [{ headers: [["User-Agent", "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"], ...CRAWLER_HEADERS], ip: GOOGLEBOT_IP, protocol: "https", httpVersion: "1.1" }],
    dns: { reverse: { [GOOGLEBOT_IP]: [GOOGLEBOT_PTR] }, forward: { [GOOGLEBOT_PTR]: [GOOGLEBOT_IP] } },
    expect: { ...VERIFIED, identity: "googlebot" },
    tags: ["verification"],
  }),
  bot({
    id: "googlebot-smartphone-verified",
    title: "Googlebot Smartphone, confirmed by DNS",
    audience: "benign-bot",
    category: "search-crawler",
    provenance: "Google crawls mobile-first; the UA embeds a full Android Chrome string",
    requests: [
      {
        headers: [["User-Agent", "Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/W.X.Y.Z Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"], ...CRAWLER_HEADERS],
        ip: GOOGLEBOT_IP,
        protocol: "https",
        httpVersion: "1.1",
      },
    ],
    dns: { reverse: { [GOOGLEBOT_IP]: [GOOGLEBOT_PTR] }, forward: { [GOOGLEBOT_PTR]: [GOOGLEBOT_IP] } },
    expect: { ...VERIFIED, identity: "googlebot" },
    notes: "The UA embeds a complete Chrome string. Nothing may read that half and conclude the client is a browser.",
    tags: ["verification"],
  }),
  bot({
    id: "bingbot-verified",
    title: "Bingbot, confirmed by DNS under search.msn.com",
    audience: "benign-bot",
    category: "search-crawler",
    provenance: "Microsoft documents FCrDNS under search.msn.com",
    requests: [{ headers: [["User-Agent", "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)"], ...CRAWLER_HEADERS], ip: BINGBOT_IP, protocol: "https", httpVersion: "1.1" }],
    dns: { reverse: { [BINGBOT_IP]: [BINGBOT_PTR] }, forward: { [BINGBOT_PTR]: [BINGBOT_IP] } },
    expect: { ...VERIFIED, identity: "bingbot" },
    tags: ["verification"],
  }),
  bot({
    id: "googlebot-dns-unavailable",
    title: "Googlebot when the resolver is not answering",
    audience: "benign-bot",
    category: "search-crawler",
    provenance: "A DNS outage must not turn every crawler into an accused forgery",
    notes:
      "The single most important negative case in the corpus. Silence is not disproof: the verdict falls back to the honest self-declaration, and the crawler is never accused of impersonation.",
    // A different address from the verified case on purpose: DNS answers are cached
    // by address, so reusing it would resolve from the cache and never exercise the
    // unavailable path at all.
    requests: [{ headers: [["User-Agent", "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"], ...CRAWLER_HEADERS], ip: "66.249.66.99", protocol: "https", httpVersion: "1.1" }],
    dns: { unavailable: true },
    expect: { verdict: "confirmed-bot", botClass: "declared-bot", certain: true, identity: "googlebot", notDetectors: ["crawler-verification"] },
    tags: ["verification", "regression"],
  }),
  bot({
    id: "duckduckbot-in-range",
    requires: ["crawler-ranges"],
    title: "DuckDuckBot from its published range",
    audience: "benign-bot",
    category: "search-crawler",
    provenance: "DuckDuckGo publishes an address list rather than PTR records",
    requests: [{ ...plain("Mozilla/5.0 (compatible; DuckDuckBot-Https/1.1; https://duckduckgo.com/duckduckbot)"), ip: IN_RANGE["duckduckbot"]! }],
    expect: { ...VERIFIED, identity: "duckduckbot" },
    tags: ["verification"],
  }),

  // ---------------------------------------------------------------------------
  // Search crawlers taken at their word.
  // ---------------------------------------------------------------------------
  declared("yandexbot", "YandexBot", "search-crawler", "Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)", "Yandex publishes FCrDNS under yandex.ru/net/com", "yandexbot"),
  declared("baiduspider", "Baiduspider", "search-crawler", "Mozilla/5.0 (compatible; Baiduspider/2.0; +http://www.baidu.com/search/spider.html)", "Baidu publishes FCrDNS under baidu.com", "baiduspider"),
  declared("applebot", "Applebot", "search-crawler", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)", "Powers Siri and Spotlight suggestions", "applebot"),
  declared("seznambot", "SeznamBot", "search-crawler", "Mozilla/5.0 (compatible; SeznamBot/4.0; +http://napoveda.seznam.cz/seznambot-intro/)", "The dominant search engine in Czechia", "seznambot"),
  declared("naver-yeti", "Naver Yeti", "search-crawler", "Mozilla/5.0 (compatible; Yeti/1.1; +http://naver.me/spd)", "The dominant search engine in South Korea", "naver-yeti"),
  declared("petalbot", "PetalBot", "search-crawler", "Mozilla/5.0 (Linux; Android 7.0;) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 (compatible; PetalBot;+https://webmaster.petalsearch.com/site/petalbot)", "Huawei's search crawler", "petalbot"),
  declared("qwantbot", "Qwantbot", "search-crawler", "Mozilla/5.0 (compatible; Qwantbot/1.0; +https://help.qwant.com/bot/)", "A privacy-focused European search engine", "qwantbot"),
  declared("mojeekbot", "MojeekBot", "search-crawler", "Mozilla/5.0 (compatible; MojeekBot/0.11; +https://www.mojeek.com/bot.html)", "An independent index — the kind of crawler a blanket block quietly kills", "mojeek"),
  declared("marginalia", "Marginalia Search", "search-crawler", "Mozilla/5.0 (compatible; Mozilla/5.0; +https://search.marginalia.nu/)", "A small independent index", "marginalia"),
  declared("sogou", "Sogou Spider", "search-crawler", "Sogou web spider/4.0(+http://www.sogou.com/docs/help/webmasters.htm#07)", "A major Chinese search engine", "sogou"),

  // Google's specialist fleet. Blocking these breaks Search Console, Ads and
  // Merchant Center in ways that are hard to trace back to a bot rule.
  declared("google-inspectiontool", "Google-InspectionTool", "search-crawler", "Mozilla/5.0 (compatible; Google-InspectionTool/1.0;)", "What Search Console's URL Inspection uses; blocking it breaks your own diagnostics", "googlebot"),
  declared("storebot-google", "Storebot-Google", "search-crawler", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 (compatible; Storebot-Google/1.0; +http://www.google.com/bot.html)", "Crawls product pages for Google Shopping and Merchant Center listings", "googlebot"),
  declared("googleother", "GoogleOther", "search-crawler", "Mozilla/5.0 (compatible; GoogleOther)", "Google's internal one-off crawls, separated from Search", "googlebot"),
  declared("adsbot-google", "AdsBot-Google", "advertising", "AdsBot-Google (+http://www.google.com/adsbot.html)", "Checks landing-page quality; blocking it degrades ad quality scores", "adsbot-google"),
  declared("mediapartners-google", "Mediapartners-Google", "advertising", "Mediapartners-Google", "Crawls pages carrying AdSense units to choose relevant ads", "adsbot-google"),
  declared("feedfetcher-google", "Feedfetcher-Google", "feed-reader", "FeedFetcher-Google; (+http://www.google.com/feedfetcher.html)", "Fetches feeds for Google products", "feedfetcher"),

  // ---------------------------------------------------------------------------
  // Link unfurlers. Every one of these renders a share card somewhere; blocking
  // them turns every shared link into a bare URL.
  // ---------------------------------------------------------------------------
  bot({
    id: "facebook-external-hit-in-range",
    requires: ["crawler-ranges"],
    title: "facebookexternalhit from Meta's published range",
    audience: "benign-bot",
    category: "link-unfurler",
    provenance: "Meta publishes its crawler ranges; no usable PTR records",
    requests: [{ ...plain("facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)"), ip: IN_RANGE["facebook-external"]! }],
    expect: { ...VERIFIED, identity: "facebook-external" },
    tags: ["verification"],
  }),
  declared("twitterbot", "Twitterbot", "link-unfurler", "Twitterbot/1.0", "Renders X/Twitter card previews", "twitterbot"),
  declared("linkedinbot", "LinkedInBot", "link-unfurler", "LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)", "Renders LinkedIn share previews. Note it also names Apache-HttpClient — a client that is honest about being built on a library.", "linkedinbot"),
  declared("slackbot-linkexpanding", "Slackbot-LinkExpanding", "link-unfurler", "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)", "Unfurls links pasted into Slack channels", "slackbot"),
  declared("slackbot-imgproxy", "Slack image proxy", "link-unfurler", "Slack-ImgProxy (+https://api.slack.com/robots)", "Fetches images for Slack previews", "slackbot"),
  declared("discordbot", "Discordbot", "link-unfurler", "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)", "Renders Discord embeds", "discordbot"),
  declared("telegrambot", "TelegramBot", "link-unfurler", "TelegramBot (like TwitterBot)", "Renders Telegram link previews", "telegrambot"),
  declared("whatsapp-preview", "WhatsApp link preview", "link-unfurler", "WhatsApp/2.24.17.79 A", "Fetches Open Graph tags when a link is shared in a chat", "whatsapp"),
  declared("redditbot", "Redditbot", "link-unfurler", "Mozilla/5.0 (compatible; redditbot/1.0; +http://www.reddit.com/feedback)", "Renders Reddit link previews", "redditbot"),
  declared("pinterestbot", "Pinterestbot", "link-unfurler", "Mozilla/5.0 (compatible; Pinterestbot/1.0; +http://www.pinterest.com/bot.html)", "Powers Pin previews and rich pins", "pinterestbot"),
  declared("mastodon-preview", "Mastodon link preview", "link-unfurler", "http.rb/5.1.1 (Mastodon/4.3.1; +https://mastodon.social/)", "Fediverse servers fetch previews individually, so one shared link can arrive from hundreds of hosts at once", "mastodon"),
  declared("embedly", "Embedly", "link-unfurler", "Mozilla/5.0 (compatible; Embedly/0.2; +http://support.embed.ly/)", "Powers previews for many products that do not fetch links themselves", "embedly"),

  // ---------------------------------------------------------------------------
  // Monitoring. Usually yours. If any of these is blocked you find out during an
  // incident, from a monitor that was reporting a false green.
  // ---------------------------------------------------------------------------
  bot({
    id: "uptimerobot-in-range",
    requires: ["crawler-ranges"],
    title: "UptimeRobot from its published range",
    audience: "benign-bot",
    category: "monitoring",
    provenance: "UptimeRobot publishes its checking addresses",
    requests: [{ ...plain("Mozilla/5.0+(compatible; UptimeRobot/2.0; http://www.uptimerobot.com/)"), ip: IN_RANGE["uptimerobot"]! }],
    expect: { ...VERIFIED, identity: "uptimerobot" },
    tags: ["verification"],
  }),
  declared("pingdom", "Pingdom", "monitoring", "Mozilla/5.0 (compatible; Pingdom.com_bot_version_1.4_(http://www.pingdom.com/))", "Synthetic uptime checks", "pingdom"),
  declared("statuscake", "StatusCake", "monitoring", "Mozilla/5.0 (compatible; StatusCake)", "Synthetic uptime checks from a distributed pool", "statuscake"),
  declared("better-uptime", "Better Stack", "monitoring", "Better Uptime Bot Mozilla/5.0 (compatible; BetterStack/1.0; +https://betterstack.com)", "Synthetic uptime checks, formerly Better Uptime", "betteruptime"),
  declared("site24x7", "Site24x7", "monitoring", "Mozilla/5.0 (compatible; Site24x7/1.0; +https://www.site24x7.com)", "Synthetic uptime and transaction monitoring", "site24x7"),
  declared("lighthouse", "Chrome Lighthouse", "monitoring", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36 Chrome-Lighthouse", "Performance auditing, often run by your own CI", "google-pagespeed"),
  declared("gtmetrix", "GTmetrix", "monitoring", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 GTmetrix", "Performance testing on request", "gtmetrix"),
  declared("datadog-synthetics", "Datadog Synthetics", "monitoring", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Datadog/Synthetics", "Synthetic API and browser checks", "datadog"),

  // ---------------------------------------------------------------------------
  // Feeds and podcasts. A real slice of a publisher's audience arrives this way,
  // and none of it runs JavaScript.
  // ---------------------------------------------------------------------------
  declared("feedly", "Feedly", "feed-reader", "Feedly/1.0 (+http://www.feedly.com/fetcher.html; 870 subscribers; like FeedFetcher-Google)", "Podnews RSS user-agent list; the subscriber count is real information a publisher wants", "feedly"),
  declared("inoreader", "Inoreader", "feed-reader", "Inoreader/1.0 (+http://www.inoreader.com/feed-fetcher; 195 subscribers; )", "Podnews RSS user-agent list", "inoreader"),
  declared("freshrss", "FreshRSS", "feed-reader", "FreshRSS/1.29.1 (Linux; https://freshrss.org)", "Podnews RSS user-agent list; self-hosted, so it arrives from a subscriber's own server", "freshrss"),
  declared("netnewswire", "NetNewsWire", "feed-reader", "NetNewsWire (RSS Reader; https://netnewswire.com/)", "Podnews RSS user-agent list", "netnewswire"),
  declared("miniflux", "Miniflux", "feed-reader", "Mozilla/5.0 (compatible; Miniflux/2.2.3; +https://miniflux.app)", "Self-hosted feed reader; arrives from a subscriber's own server rather than a vendor's", "rss-reader"),
  declared("overcast", "Overcast", "podcast-client", "Overcast/1.0 Podcast Sync (210 subscribers; feed-id=735461; +http://overcast.fm/)", "Podnews RSS user-agent list", "overcast", { audience: "benign-bot" }),
  declared("pocketcasts", "Pocket Casts", "podcast-client", "PocketCasts/1.0 (Pocket Casts Feed Parser; +http://pocketcasts.com/)", "Podnews RSS user-agent list", "pocketcasts"),
  declared("antennapod", "AntennaPod", "podcast-client", "AntennaPod/3.12.0", "Podnews RSS user-agent list", "antennapod"),
  declared("podcastaddict", "Podcast Addict", "podcast-client", "PodcastAddict/v5 (+https://podcastaddict.com/; Android podcast app)", "Podnews RSS user-agent list", "podcastaddict"),

  bot({
    id: "spotify-podcast-fetch",
    title: "Spotify fetching a podcast feed",
    audience: "benign-bot",
    category: "podcast-client",
    provenance: "Podnews RSS user-agent list records Spotify's fetcher as the bare token 'Spotify/1.0'",
    notes:
      "A two-token User-Agent with no contact URL and no recognisable product. It is honest automation from a major platform that nonetheless looks like a hand-rolled script — which is exactly why an unrecognised bare token is `strong` rather than `certain`.",
    requests: [plain("Spotify/1.0")],
    expect: { verdict: "suspected-bot", botClass: "http-client", certain: false, neverAction: ["drop"] },
  }),
  bot({
    id: "apple-podcasts-fetch",
    title: "Apple Podcasts fetching a feed",
    audience: "benign-bot",
    category: "podcast-client",
    provenance: "Podnews records Apple Podcasts as 'iTMS'",
    notes: "Four characters, no version, no contact. Legible only because the database has an entry for it — and a reminder that honest automation is under no obligation to be legible.",
    requests: [plain("iTMS")],
    expect: { verdict: "confirmed-bot", certain: true, identity: "apple-podcasts", neverAction: ["drop"] },
  }),

  // ---------------------------------------------------------------------------
  // Archives.
  // ---------------------------------------------------------------------------
  declared("internet-archive", "Internet Archive", "archive", "Mozilla/5.0 (compatible; archive.org_bot +http://archive.org/details/archive.org_bot)", "The Wayback Machine, which preserves pages long after the site that served them", "ia-archiver"),
  declared("heritrix", "Heritrix", "archive", "Mozilla/5.0 (compatible; heritrix/3.4.0 +https://webrecorder.net)", "The crawler behind many institutional web archives", "heritrix"),
];
