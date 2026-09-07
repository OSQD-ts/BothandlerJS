import { MultiPatternMatcher } from "../internal/matcher.js";

/**
 * The known-bot signature database.
 *
 * Two things live here, and it is worth being precise about the difference.
 *
 * A **signature** matches a literal token in a User-Agent. That is a *claim* the
 * client makes about itself, nothing more — anyone can send `Googlebot/2.1`. A claim
 * is useful for two opposite reasons: an honest bot's claim tells us what it is, and
 * a dishonest one gives us something to disprove.
 *
 * A **verification** is how that claim gets checked against an authority outside the
 * request. Only the pairing of the two produces a `certain` verdict — either
 * `verified-bot` (claim confirmed) or `impersonator` (claim disproved). A signature
 * with no verification can never do better than `declared-bot`.
 */

export type BotCategory =
  | "search"
  | "ai"
  | "seo"
  | "social"
  | "monitoring"
  | "archive"
  | "feed"
  | "security"
  | "advertising"
  | "library"
  | "headless"
  /** A real browser engine embedded in a desktop application, with a person driving it. */
  | "embedded"
  /**
   * Price, stock and catalogue collection: comparison shopping, marketplace feeds,
   * repricing tools.
   *
   * Its own category because it is the one kind of crawling a shop has a commercial
   * opinion about rather than a technical one. It is not `seo` — nothing here is
   * auditing your site for you — and it is not `scraper`, which is a *behavioural*
   * verdict this library reaches on its own. This is a client that says what it is.
   */
  | "commerce"
  /**
   * Accessibility auditing: contrast, landmarks, ARIA, WCAG conformance.
   *
   * Separated from `monitoring` because the answer is almost always different. A site
   * owner who blocks uptime probes still wants the tool their accessibility team runs
   * to reach the page, and frequently does not know it is arriving as a bot at all.
   */
  | "accessibility"
  /**
   * A mail or messaging gateway checking a link on somebody's behalf.
   *
   * Its own category because of who pays when it is blocked. A social preview that fails
   * costs a card; one of these failing tells a real person, in their inbox, that the link
   * they were sent could not be verified — and they were never the one crawling. They also
   * arrive with none of a browser's marks: from a datacentre, once, with no cookie and no
   * referer, moments after a message was delivered, which is a shape that reads as
   * automation because it *is* automation, acting for a human.
   */
  | "email-security"
  /**
   * Research and measurement: universities, internet-measurement projects, plagiarism
   * and citation indexes.
   *
   * Distinct from `ai` on purpose. Both read the whole page and neither sends a person,
   * but the decision differs: an operator refusing to feed a commercial model may be
   * perfectly happy to appear in a citation index, and folding the two together forces
   * one answer onto two questions.
   */
  | "academic"
  | "other";

/** Every category, for anything that has to enumerate them — a rule editor, a report. */
export const BOT_CATEGORIES: readonly BotCategory[] = [
  "search",
  "ai",
  "seo",
  "social",
  "monitoring",
  "archive",
  "feed",
  "security",
  "advertising",
  "library",
  "headless",
  "embedded",
  "commerce",
  "accessibility",
  "academic",
  "email-security",
  "other",
];

/**
 * How a claimed identity is checked.
 *
 * - `fcrdns` — forward-confirmed reverse DNS. Reverse-resolve the client IP, require
 *   the name to sit under one of `domains`, then forward-resolve that name and
 *   require the original IP back. Forging this requires control of the operator's
 *   DNS, which is the property that makes it `certain` in both directions.
 * - `ip-ranges` — the operator publishes IP ranges but sets no usable PTR records.
 *   Verifiable only if you supply the ranges (see `crawlerRanges` in the config);
 *   the library will not fetch them for you, because a detector that makes an
 *   outbound HTTP request on a schedule is a dependency you should opt into
 *   knowingly.
 * - `none` — no published mechanism. The claim is unfalsifiable, so we neither
 *   confirm nor accuse.
 */
export type Verification =
  | { kind: "fcrdns"; domains: readonly string[] }
  | { kind: "ip-ranges"; publishedAt?: string }
  /**
   * The operator publishes a proof this library cannot check by itself, and you can.
   *
   * A signed request under [Web Bot Auth](https://www.rfc-editor.org/rfc/rfc9421), a
   * CDN that has already verified the crawler and says so in a header it adds, an ASN
   * lookup against data you hold — all of them are conclusive, and none of them are
   * something a detection library should be doing on its own: two need a network
   * dependency and the third needs a key it has no business fetching.
   *
   * So the claim is marked verifiable-by-you, and stays *unverified* until you supply a
   * verifier for it in `crawlerVerification.verifiers`. Marked and unsupplied behaves
   * exactly like `none`: neither confirmed nor accused.
   *
   * `via` names the mechanism, for the operator reading this table to know what they
   * would have to write.
   */
  | { kind: "proof"; via: string }
  | { kind: "none" };

export interface BotSignature {
  /** Stable id, used in rules, logs and metrics. */
  id: string;
  name: string;
  /** Lowercase literal tokens; a match on any one identifies this bot. */
  tokens: readonly string[];
  category: BotCategory;
  verification: Verification;
  /**
   * Whether this client is generally *benign* — something most sites want to keep
   * serving. Search and social preview crawlers are; scrapers and scanners are not.
   * Drives the default policy's allow path, never a block.
   */
  benign: boolean;
  /**
   * Whether matching this signature is *conclusive* evidence of automation. Default
   * true.
   *
   * Set it false when the token can legitimately appear on a request a person made.
   * The motivating case is Electron: the UA is emitted by VS Code's Simple Browser,
   * Slack, Discord and Postman, which are real Chromium instances with a human
   * driving them. A signature match is only allowed into the `certain` tier when the
   * claim "no honest client sends this" actually holds, and for embedded webviews it
   * plainly does not.
   */
  conclusive?: boolean;
  /** Why this signature is not conclusive. Surfaced in the evidence summary. */
  caveat?: string;
  /**
   * The product token to name in a `User-agent:` line in `robots.txt`.
   *
   * Defaults to the first match token. Worth setting where the canonical spelling
   * differs from the token we match on — `robots.txt` matching is case-insensitive,
   * so this is about a file a person will read, not about correctness.
   */
  robotsAgent?: string;
  docs?: string;
}

/** Search-engine crawlers with published, DNS-verifiable identities. */
const SEARCH: BotSignature[] = [
  { id: "googlebot", name: "Googlebot", tokens: ["googlebot", "google-inspectiontool", "storebot-google", "googleother", "google favicon", "google-read-aloud", "google-shopping-quality", "google-site-verification", "googleproducersearch", "google-safety"], category: "search", benign: true, robotsAgent: "Googlebot", verification: { kind: "fcrdns", domains: ["googlebot.com", "google.com", "googleusercontent.com"] }, docs: "https://developers.google.com/search/docs/crawling-indexing/verifying-googlebot" },
  { id: "bingbot", name: "Bingbot", tokens: ["bingbot", "adidxbot", "msnbot", "bingpreview"], category: "search", benign: true, robotsAgent: "bingbot", verification: { kind: "fcrdns", domains: ["search.msn.com"] }, docs: "https://www.bing.com/webmasters/help/how-to-verify-bingbot-3905dc26" },
  { id: "yandexbot", name: "YandexBot", tokens: ["yandexbot", "yandeximages", "yandexmobilebot", "yandexaccessibilitybot"], category: "search", benign: true, robotsAgent: "YandexBot", verification: { kind: "fcrdns", domains: ["yandex.ru", "yandex.net", "yandex.com"] } },
  { id: "baiduspider", name: "Baiduspider", tokens: ["baiduspider"], category: "search", benign: true, robotsAgent: "Baiduspider", verification: { kind: "fcrdns", domains: ["baidu.com", "baidu.jp"] } },
  { id: "applebot", name: "Applebot", tokens: ["applebot"], category: "search", benign: true, robotsAgent: "Applebot", verification: { kind: "fcrdns", domains: ["applebot.apple.com"] } },
  { id: "duckduckbot", name: "DuckDuckBot", tokens: ["duckduckbot", "duckassistbot"], category: "search", benign: true, robotsAgent: "DuckDuckBot", verification: { kind: "ip-ranges" } },
  { id: "sogou", name: "Sogou Spider", tokens: ["sogou web spider", "sogou inst spider"], category: "search", benign: true, verification: { kind: "fcrdns", domains: ["sogou.com"] } },
  { id: "seznambot", name: "SeznamBot", tokens: ["seznambot"], category: "search", benign: true, verification: { kind: "fcrdns", domains: ["seznam.cz"] } },
  { id: "naver-yeti", name: "Naver Yeti", tokens: ["yeti/", "yeti-mobile"], category: "search", benign: true, verification: { kind: "fcrdns", domains: ["naver.com"] } },
  { id: "petalbot", name: "PetalBot", tokens: ["petalbot", "aspiegel"], category: "search", benign: true, verification: { kind: "fcrdns", domains: ["petalsearch.com", "aspiegel.com"] } },
  { id: "qwantbot", name: "Qwantbot", tokens: ["qwantbot", "qwantify"], category: "search", benign: true, verification: { kind: "none" } },
  { id: "mojeek", name: "MojeekBot", tokens: ["mojeekbot"], category: "search", benign: true, verification: { kind: "none" } },
  { id: "marginalia", name: "Marginalia Search", tokens: ["search.marginalia.nu"], category: "search", benign: true, verification: { kind: "none" } },
  // Regional engines. Between them these are the default search for a very large
  // share of the world, and a policy that allows "search crawlers" while knowing only
  // the western ones quietly de-indexes a site across most of Asia.
  { id: "coccoc", name: "Coc Coc Bot", tokens: ["coccocbot"], category: "search", benign: true, robotsAgent: "coccocbot", verification: { kind: "fcrdns", domains: ["coccoc.com"] } },
  { id: "360spider", name: "360 Spider", tokens: ["360spider", "haosouspider"], category: "search", benign: true, robotsAgent: "360Spider", verification: { kind: "none" } },
  { id: "yisouspider", name: "Shenma (Yisou) Spider", tokens: ["yisouspider"], category: "search", benign: true, robotsAgent: "YisouSpider", verification: { kind: "none" } },
  { id: "yahoo-slurp", name: "Yahoo! Slurp", tokens: ["yahoo! slurp"], category: "search", benign: true, robotsAgent: "Slurp", verification: { kind: "fcrdns", domains: ["crawl.yahoo.net", "yahoo.com"] } },
  { id: "mail-ru", name: "Mail.Ru bot", tokens: ["mail.ru_bot"], category: "search", benign: true, verification: { kind: "none" } },
  { id: "brave-search", name: "Brave Search", tokens: ["bravesearchbot"], category: "search", benign: true, robotsAgent: "BraveSearchBot", verification: { kind: "none" } },
  { id: "ecosia", name: "Ecosia", tokens: ["ecosiabot"], category: "search", benign: true, verification: { kind: "none" } },
  { id: "startpage", name: "Startpage", tokens: ["startpagebot"], category: "search", benign: true, verification: { kind: "none" } },
  { id: "daum", name: "Daumoa", tokens: ["daumoa"], category: "search", benign: true, verification: { kind: "none" } },
  { id: "stract", name: "Stract", tokens: ["stractbot"], category: "search", benign: true, verification: { kind: "none" } },
  { id: "rightdao", name: "RightDao", tokens: ["rightdaobot"], category: "search", benign: true, verification: { kind: "none" } },
  { id: "gigablast", name: "Gigablast", tokens: ["gigablastopensource"], category: "search", benign: true, verification: { kind: "none" } },
  { id: "exabot", name: "Exabot (Exalead)", tokens: ["exabot"], category: "search", benign: true, verification: { kind: "none" } },
  { id: "kagibot", name: "Kagi", tokens: ["kagibot"], category: "search", benign: true, robotsAgent: "KagiBot", verification: { kind: "none" } },
];

/**
 * AI training and retrieval crawlers. Split out from `search` because the decision
 * about them is a *policy* decision, not a security one — many sites happily serve
 * search engines while declining to feed model training, and the two need separate
 * rules. All of them announce themselves honestly, which is the reason a rule
 * matching them works at all.
 */
const AI: BotSignature[] = [
  { id: "gptbot", name: "GPTBot", tokens: ["gptbot"], category: "ai", benign: true, robotsAgent: "GPTBot", verification: { kind: "ip-ranges" }, docs: "https://platform.openai.com/docs/bots" },
  { id: "oai-searchbot", name: "OAI-SearchBot", tokens: ["oai-searchbot"], category: "ai", benign: true, robotsAgent: "OAI-SearchBot", verification: { kind: "ip-ranges" } },
  { id: "chatgpt-user", name: "ChatGPT-User", tokens: ["chatgpt-user"], category: "ai", benign: true, robotsAgent: "ChatGPT-User", verification: { kind: "ip-ranges" } },
  { id: "claudebot", name: "ClaudeBot", tokens: ["claudebot", "claude-web", "anthropic-ai", "claude-user", "claude-searchbot"], category: "ai", benign: true, robotsAgent: "ClaudeBot", verification: { kind: "ip-ranges" }, docs: "https://support.anthropic.com/en/articles/8896518" },
  { id: "perplexitybot", name: "PerplexityBot", tokens: ["perplexitybot", "perplexity-user"], category: "ai", benign: true, robotsAgent: "PerplexityBot", verification: { kind: "ip-ranges" } },
  { id: "google-extended", name: "Google-Extended", tokens: ["google-extended"], category: "ai", benign: true, robotsAgent: "Google-Extended", verification: { kind: "fcrdns", domains: ["googlebot.com", "google.com"] } },
  { id: "applebot-extended", name: "Applebot-Extended", tokens: ["applebot-extended"], category: "ai", benign: true, robotsAgent: "Applebot-Extended", verification: { kind: "fcrdns", domains: ["applebot.apple.com"] } },
  { id: "ccbot", name: "CCBot (Common Crawl)", tokens: ["ccbot"], category: "ai", benign: true, robotsAgent: "CCBot", verification: { kind: "none" } },
  { id: "bytespider", name: "Bytespider", tokens: ["bytespider"], category: "ai", benign: false, robotsAgent: "Bytespider", verification: { kind: "none" } },
  { id: "amazonbot", name: "Amazonbot", tokens: ["amazonbot"], category: "ai", benign: true, robotsAgent: "Amazonbot", verification: { kind: "ip-ranges" } },
  { id: "meta-ai", name: "Meta AI crawlers", tokens: ["meta-externalagent", "facebookbot", "meta-externalfetcher"], category: "ai", benign: true, robotsAgent: "meta-externalagent", verification: { kind: "ip-ranges" } },
  { id: "cohere-ai", name: "Cohere", tokens: ["cohere-ai", "cohere-training-data-crawler"], category: "ai", benign: true, robotsAgent: "cohere-ai", verification: { kind: "none" } },
  { id: "diffbot", name: "Diffbot", tokens: ["diffbot"], category: "ai", benign: true, robotsAgent: "Diffbot", verification: { kind: "none" } },
  { id: "timpibot", name: "Timpibot", tokens: ["timpibot"], category: "ai", benign: true, robotsAgent: "Timpibot", verification: { kind: "none" } },
  { id: "youbot", name: "YouBot", tokens: ["youbot"], category: "ai", benign: true, robotsAgent: "YouBot", verification: { kind: "none" } },
  { id: "ai2bot", name: "AI2Bot", tokens: ["ai2bot"], category: "ai", benign: true, robotsAgent: "AI2Bot", verification: { kind: "none" } },
  { id: "mistral-ai", name: "Mistral AI", tokens: ["mistralai-user", "mistralai-crawler"], category: "ai", benign: true, robotsAgent: "MistralAI-User", verification: { kind: "none" } },
  { id: "google-vertex", name: "Google CloudVertexBot", tokens: ["google-cloudvertexbot"], category: "ai", benign: true, robotsAgent: "Google-CloudVertexBot", verification: { kind: "fcrdns", domains: ["googlebot.com", "google.com"] } },
  { id: "pangubot", name: "PanguBot (Huawei)", tokens: ["pangubot"], category: "ai", benign: true, robotsAgent: "PanguBot", verification: { kind: "none" } },
  { id: "kangaroo", name: "Kangaroo Bot", tokens: ["kangaroo bot"], category: "ai", benign: true, robotsAgent: "Kangaroo Bot", verification: { kind: "none" } },
  { id: "semanticscholar", name: "Semantic Scholar", tokens: ["semanticscholarbot"], category: "ai", benign: true, robotsAgent: "SemanticScholarBot", verification: { kind: "none" } },
  // Bulk dataset collection. Honest about what it is, and rarely something a
  // publisher chose — hence not benign, so the default allow path leaves it out.
  { id: "omgili", name: "Webz.io / Omgili", tokens: ["omgili", "omgilibot", "webzio-extended"], category: "ai", benign: false, robotsAgent: "omgili", verification: { kind: "none" } },
  { id: "img2dataset", name: "img2dataset", tokens: ["img2dataset"], category: "ai", benign: false, robotsAgent: "img2dataset", verification: { kind: "none" } },
  { id: "tiktokspider", name: "TikTokSpider", tokens: ["tiktokspider"], category: "ai", benign: false, robotsAgent: "TikTokSpider", verification: { kind: "none" } },
];

/** SEO and market-intelligence crawlers. Legitimate businesses; frequently unwanted load. */
const SEO: BotSignature[] = [
  { id: "ahrefsbot", name: "AhrefsBot", tokens: ["ahrefsbot", "ahrefssiteaudit"], category: "seo", benign: false, robotsAgent: "AhrefsBot", verification: { kind: "fcrdns", domains: ["ahrefs.com", "ahrefs.net"] } },
  { id: "semrushbot", name: "SemrushBot", tokens: ["semrushbot", "siteauditbot"], category: "seo", benign: false, robotsAgent: "SemrushBot", verification: { kind: "none" } },
  { id: "mj12bot", name: "MJ12bot (Majestic)", tokens: ["mj12bot"], category: "seo", benign: false, robotsAgent: "MJ12bot", verification: { kind: "none" } },
  { id: "dotbot", name: "DotBot (Moz)", tokens: ["dotbot", "rogerbot"], category: "seo", benign: false, robotsAgent: "dotbot", verification: { kind: "none" } },
  { id: "blexbot", name: "BLEXBot", tokens: ["blexbot"], category: "seo", benign: false, robotsAgent: "BLEXBot", verification: { kind: "none" } },
  { id: "dataforseo", name: "DataForSeoBot", tokens: ["dataforseobot"], category: "seo", benign: false, robotsAgent: "DataForSeoBot", verification: { kind: "none" } },
  { id: "serpstatbot", name: "Serpstatbot", tokens: ["serpstatbot"], category: "seo", benign: false, robotsAgent: "serpstatbot", verification: { kind: "none" } },
  { id: "barkrowler", name: "Barkrowler", tokens: ["barkrowler"], category: "seo", benign: false, robotsAgent: "Barkrowler", verification: { kind: "none" } },
  { id: "zoominfobot", name: "ZoominfoBot", tokens: ["zoominfobot"], category: "seo", benign: false, robotsAgent: "ZoominfoBot", verification: { kind: "none" } },
  // Desktop auditing tools. Almost always the site's own team, running from a laptop
  // on a residential address, which is why they are marked benign despite the category.
  { id: "screaming-frog", name: "Screaming Frog SEO Spider", tokens: ["screaming frog seo spider"], category: "seo", benign: true, verification: { kind: "none" }, docs: "https://www.screamingfrog.co.uk/seo-spider/user-guide/" },
  { id: "sitebulb", name: "Sitebulb", tokens: ["sitebulb"], category: "seo", benign: true, verification: { kind: "none" } },
  { id: "lumar", name: "Lumar (DeepCrawl)", tokens: ["deepcrawl", "lumar"], category: "seo", benign: false, verification: { kind: "none" } },
  { id: "oncrawl", name: "OnCrawl", tokens: ["oncrawl"], category: "seo", benign: false, verification: { kind: "none" } },
  { id: "sistrix", name: "SISTRIX Crawler", tokens: ["sistrix"], category: "seo", benign: false, robotsAgent: "SISTRIX", verification: { kind: "none" } },
  { id: "seokicks", name: "SEOkicks", tokens: ["seokicks"], category: "seo", benign: false, verification: { kind: "none" } },
  { id: "linkdex", name: "Linkdex", tokens: ["linkdexbot"], category: "seo", benign: false, verification: { kind: "none" } },
  { id: "seobility", name: "Seobility", tokens: ["seobility"], category: "seo", benign: false, verification: { kind: "none" } },
  { id: "sitechecker", name: "Sitechecker", tokens: ["sitecheckerbotcrawler"], category: "seo", benign: false, verification: { kind: "none" } },
  { id: "cocolyze", name: "Cocolyze", tokens: ["cocolyzebot"], category: "seo", benign: false, verification: { kind: "none" } },
  // Media and brand monitoring: the same shape as SEO crawling, a different customer.
  { id: "magpie", name: "Brandwatch (magpie-crawler)", tokens: ["magpie-crawler"], category: "seo", benign: false, verification: { kind: "none" } },
  { id: "trendiction", name: "Trendiction", tokens: ["trendictionbot"], category: "seo", benign: false, verification: { kind: "none" } },
  { id: "awario", name: "Awario", tokens: ["awariobot", "awariorssbot", "awariosmartbot"], category: "seo", benign: false, verification: { kind: "none" } },
];

/** Link-unfurling and preview fetchers. Almost always wanted: they render your share cards. */
const SOCIAL: BotSignature[] = [
  { id: "facebook-external", name: "Facebook external hit", tokens: ["facebookexternalhit", "facebookcatalog"], category: "social", benign: true, verification: { kind: "ip-ranges" } },
  { id: "twitterbot", name: "Twitterbot", tokens: ["twitterbot"], category: "social", benign: true, verification: { kind: "none" } },
  { id: "linkedinbot", name: "LinkedInBot", tokens: ["linkedinbot"], category: "social", benign: true, verification: { kind: "none" } },
  { id: "slackbot", name: "Slackbot", tokens: ["slackbot", "slack-imgproxy"], category: "social", benign: true, verification: { kind: "none" } },
  { id: "discordbot", name: "Discordbot", tokens: ["discordbot"], category: "social", benign: true, verification: { kind: "none" } },
  { id: "telegrambot", name: "TelegramBot", tokens: ["telegrambot"], category: "social", benign: true, verification: { kind: "none" } },
  { id: "whatsapp", name: "WhatsApp preview", tokens: ["whatsapp/"], category: "social", benign: true, verification: { kind: "none" } },
  { id: "redditbot", name: "Redditbot", tokens: ["redditbot"], category: "social", benign: true, verification: { kind: "none" } },
  { id: "pinterestbot", name: "Pinterestbot", tokens: ["pinterest/", "pinterestbot"], category: "social", benign: true, verification: { kind: "fcrdns", domains: ["pinterest.com"] } },
  { id: "mastodon", name: "Mastodon / Fediverse", tokens: ["mastodon/", "pleroma", "misskey/", "akkoma"], category: "social", benign: true, verification: { kind: "none" } },
  { id: "embedly", name: "Embedly", tokens: ["embedly"], category: "social", benign: true, verification: { kind: "none" } },
  { id: "bluesky", name: "Bluesky card fetcher", tokens: ["bluesky cardyb", "cardyb/", "blueskybot"], category: "social", benign: true, verification: { kind: "none" } },
  { id: "iframely", name: "Iframely", tokens: ["iframely"], category: "social", benign: true, verification: { kind: "none" } },
  { id: "skype-preview", name: "Skype URI preview", tokens: ["skypeuripreview"], category: "social", benign: true, verification: { kind: "none" } },
  { id: "vk-share", name: "VK / Odnoklassniki preview", tokens: ["vkshare", "odklbot"], category: "social", benign: true, verification: { kind: "none" } },
  { id: "discourse-onebox", name: "Discourse Onebox", tokens: ["discourse forum onebox"], category: "social", benign: true, verification: { kind: "none" } },
  { id: "microsoft-preview", name: "Microsoft Teams preview", tokens: ["microsoftpreview"], category: "social", benign: true, verification: { kind: "none" } },
  { id: "zoom-preview", name: "Zoom link preview", tokens: ["zoombot"], category: "social", benign: true, verification: { kind: "none" } },
  { id: "signal-preview", name: "Signal link preview", tokens: ["signalbot"], category: "social", benign: true, verification: { kind: "none" } },
  { id: "matrix-synapse", name: "Matrix (Synapse) preview", tokens: ["synapse/"], category: "social", benign: true, verification: { kind: "none" } },
  { id: "yahoo-preview", name: "Yahoo Link Preview", tokens: ["yahoo link preview"], category: "social", benign: true, verification: { kind: "none" } },
];

/** Uptime, synthetic and accessibility monitoring. Usually yours — allowlist them by IP. */
const MONITORING: BotSignature[] = [
  { id: "uptimerobot", name: "UptimeRobot", tokens: ["uptimerobot"], category: "monitoring", benign: true, verification: { kind: "ip-ranges" } },
  { id: "pingdom", name: "Pingdom", tokens: ["pingdom"], category: "monitoring", benign: true, verification: { kind: "ip-ranges" } },
  { id: "statuscake", name: "StatusCake", tokens: ["statuscake"], category: "monitoring", benign: true, verification: { kind: "none" } },
  { id: "datadog", name: "Datadog Synthetics", tokens: ["datadog", "synthetics"], category: "monitoring", benign: true, verification: { kind: "none" } },
  { id: "betteruptime", name: "Better Uptime", tokens: ["betteruptime", "betterstack"], category: "monitoring", benign: true, verification: { kind: "none" } },
  { id: "site24x7", name: "Site24x7", tokens: ["site24x7"], category: "monitoring", benign: true, verification: { kind: "none" } },
  { id: "google-pagespeed", name: "Google PageSpeed / Lighthouse", tokens: ["chrome-lighthouse", "google page speed insights"], category: "monitoring", benign: true, verification: { kind: "none" } },
  { id: "gtmetrix", name: "GTmetrix", tokens: ["gtmetrix"], category: "monitoring", benign: true, verification: { kind: "none" } },
  { id: "w3c-validator", name: "W3C Validator", tokens: ["w3c_validator", "w3c-checklink", "w3c-mobileok"], category: "monitoring", benign: true, verification: { kind: "none" } },
  { id: "ssllabs", name: "Qualys SSL Labs", tokens: ["ssl labs"], category: "monitoring", benign: true, verification: { kind: "none" } },
  { id: "checkly", name: "Checkly", tokens: ["checkly"], category: "monitoring", benign: true, verification: { kind: "none" } },
  { id: "updown", name: "updown.io", tokens: ["updown.io"], category: "monitoring", benign: true, verification: { kind: "none" } },
  { id: "hetrixtools", name: "HetrixTools", tokens: ["hetrixtools"], category: "monitoring", benign: true, verification: { kind: "none" } },
  { id: "uptime-kuma", name: "Uptime Kuma", tokens: ["uptime-kuma"], category: "monitoring", benign: true, verification: { kind: "none" } },
  { id: "freshping", name: "Freshping", tokens: ["freshping"], category: "monitoring", benign: true, verification: { kind: "none" } },
  { id: "newrelic", name: "New Relic Synthetics", tokens: ["newrelicsyntheticsmonitor", "newrelicpinger"], category: "monitoring", benign: true, verification: { kind: "none" } },
  { id: "webpagetest", name: "WebPageTest", tokens: ["webpagetest"], category: "monitoring", benign: true, verification: { kind: "none" } },
  // Platform health probes. Naming these matters more than it looks: an unrecognised
  // `kube-probe/1.31` is a bare product token, which reads as an anonymous HTTP client
  // and lands in whatever bucket the policy keeps for those — for a request your own
  // orchestrator made to decide whether to restart the process.
  { id: "platform-probes", name: "Platform health probes", tokens: ["kube-probe", "elb-healthchecker", "googlehc", "amazon-route53-health-check", "azure-traffic-manager"], category: "monitoring", benign: true, verification: { kind: "none" } },
  { id: "exporters", name: "Metrics and availability exporters", tokens: ["blackbox_exporter", "prometheus/", "zabbix", "check_http", "nagios", "icinga"], category: "monitoring", benign: true, verification: { kind: "none" } },
];

const ARCHIVE: BotSignature[] = [
  { id: "archive-today", name: "archive.today", tokens: ["archive.today"], category: "archive", benign: true, verification: { kind: "none" } },
  { id: "perma-cc", name: "Perma.cc", tokens: ["perma.cc"], category: "archive", benign: true, verification: { kind: "none" } },
  { id: "webrecorder", name: "Webrecorder", tokens: ["webrecorder"], category: "archive", benign: true, verification: { kind: "none" } },
  { id: "ia-archiver", name: "Internet Archive", tokens: ["ia_archiver", "archive.org_bot", "wayback"], category: "archive", benign: true, verification: { kind: "none" } },
  { id: "heritrix", name: "Heritrix", tokens: ["heritrix"], category: "archive", benign: true, verification: { kind: "none" } },
];

/**
 * Feed and podcast clients.
 *
 * A large and easily-forgotten slice of a publisher's audience arrives this way, and
 * none of it runs JavaScript — so a challenge does not inconvenience these clients,
 * it removes them.
 *
 * `Spotify/` is deliberately **not** a token here. Spotify's podcast fetcher sends
 * `Spotify/1.0`, but Spotify's desktop application is an Electron client sending
 * `Spotify/1.2.x …` with a person listening behind it. One token, two populations, and
 * no way to tell them apart — so the fetcher is left to the generic bare-token rule
 * rather than risking a signature that names a listener as a bot.
 */
const FEED: BotSignature[] = [
  { id: "newsblur", name: "NewsBlur", tokens: ["newsblur"], category: "feed", benign: true, verification: { kind: "none" } },
  { id: "smartnews", name: "SmartNews", tokens: ["smartnewsbot"], category: "feed", benign: true, verification: { kind: "none" } },
  { id: "flipboard", name: "Flipboard", tokens: ["flipboardproxy"], category: "feed", benign: true, verification: { kind: "none" } },
  { id: "podcast-index", name: "Podcast Index", tokens: ["podcastindexbot"], category: "feed", benign: true, verification: { kind: "none" } },
  // Spotify's podcast fetcher sends `Spotify/1.0` — and so does the Spotify desktop app,
  // with a person driving it. There is no token that separates them, so this one is left
  // unnamed rather than named wrongly: the corpus proved the point immediately by blocking
  // a human under `protect-auth`, `indexers-only` and `under-attack` at once.
  { id: "freshrss", name: "FreshRSS", tokens: ["freshrss"], category: "feed", benign: true, verification: { kind: "none" } },
  { id: "netnewswire", name: "NetNewsWire", tokens: ["netnewswire"], category: "feed", benign: true, verification: { kind: "none" } },
  { id: "overcast", name: "Overcast", tokens: ["overcast/"], category: "feed", benign: true, verification: { kind: "none" } },
  { id: "pocketcasts", name: "Pocket Casts", tokens: ["pocketcasts"], category: "feed", benign: true, verification: { kind: "none" } },
  { id: "antennapod", name: "AntennaPod", tokens: ["antennapod"], category: "feed", benign: true, verification: { kind: "none" } },
  { id: "podcastaddict", name: "Podcast Addict", tokens: ["podcastaddict"], category: "feed", benign: true, verification: { kind: "none" } },
  { id: "gpodder", name: "gPodder", tokens: ["gpodder"], category: "feed", benign: true, verification: { kind: "none" } },
  { id: "castro", name: "Castro", tokens: ["tentacles"], category: "feed", benign: true, verification: { kind: "none" } },
  { id: "amazon-music-podcast", name: "Amazon Music Podcast", tokens: ["amazon music podcast"], category: "feed", benign: true, verification: { kind: "none" } },
  {
    id: "apple-podcasts",
    name: "Apple Podcasts",
    tokens: ["itms"],
    category: "feed",
    benign: true,
    verification: { kind: "none" },
    docs: "https://podnews.net/about/rss-stats",
  },

  { id: "feedly", name: "Feedly", tokens: ["feedly"], category: "feed", benign: true, verification: { kind: "none" } },
  { id: "inoreader", name: "Inoreader", tokens: ["inoreader"], category: "feed", benign: true, verification: { kind: "none" } },
  { id: "feedfetcher", name: "Feedfetcher-Google", tokens: ["feedfetcher-google"], category: "feed", benign: true, verification: { kind: "fcrdns", domains: ["google.com", "googlebot.com"] } },
  { id: "rss-reader", name: "Generic feed reader", tokens: ["newsblur", "tiny tiny rss", "miniflux", "netvibes", "rssbot", "feedbin", "theoldreader", "bazqux", "rssowl", "selfoss", "commafeed"], category: "feed", benign: true, verification: { kind: "none" } },
  { id: "feedburner", name: "FeedBurner / Superfeedr", tokens: ["feedburner", "superfeedr"], category: "feed", benign: true, verification: { kind: "none" } },
  { id: "podverse", name: "Podverse", tokens: ["podverse"], category: "feed", benign: true, verification: { kind: "none" } },
];

/**
 * Security scanners and exploitation tooling. A hit is not proof of malice — you may
 * be scanning yourself — but it is proof of automation, which is all this library
 * claims. Point these at your allowlist if they are your own.
 */
const SECURITY: BotSignature[] = [
  { id: "sqlmap", name: "sqlmap", tokens: ["sqlmap"], category: "security", benign: false, verification: { kind: "none" } },
  { id: "nikto", name: "Nikto", tokens: ["nikto"], category: "security", benign: false, verification: { kind: "none" } },
  { id: "nmap", name: "Nmap / masscan / zgrab", tokens: ["nmap scripting engine", "masscan", "zgrab", "zmap"], category: "security", benign: false, verification: { kind: "none" } },
  { id: "dirbusters", name: "Directory brute-forcers", tokens: ["dirbuster", "gobuster", "feroxbuster", "ffuf", "wfuzz", "dirsearch"], category: "security", benign: false, verification: { kind: "none" } },
  { id: "nuclei", name: "Nuclei", tokens: ["nuclei"], category: "security", benign: false, verification: { kind: "none" } },
  { id: "commercial-scanners", name: "Commercial scanners", tokens: ["acunetix", "nessus", "openvas", "qualys", "arachni", "w3af", "netsparker", "invicti", "detectify"], category: "security", benign: false, verification: { kind: "none" } },
  { id: "exploitation", name: "Exploitation frameworks", tokens: ["metasploit", "hydra", "havij", "burpsuite", "burp collaborator", "xsser", "commix"], category: "security", benign: false, verification: { kind: "none" } },
  { id: "internet-scanners", name: "Internet-wide scanners", tokens: ["censysinspect", "shodan", "internetmeasurement", "expanse", "leakix", "netsystemsresearch", "paloaltonetworks.com/", "odin.com", "binaryedge", "stretchoid", "netcraftsurveyagent", "l9explore", "l9tcpid"], category: "security", benign: false, verification: { kind: "none" } },
  { id: "app-scanners", name: "Application scanners", tokens: ["whatweb", "wpscan", "joomscan", "droopescan", "skipfish", "cmsmap", "vega/", "grabber"], category: "security", benign: false, verification: { kind: "none" } },
  { id: "injection-tools", name: "Injection and fuzzing tools", tokens: ["dalfox", "xsstrike", "sqlninja", "jaeles", "nosqlmap"], category: "security", benign: false, verification: { kind: "none" } },
  { id: "attack-crawlers", name: "Reconnaissance crawlers", tokens: ["katana", "hakrawler", "gospider", "photon", "crawlergo"], category: "security", benign: false, verification: { kind: "none" } },
  // A forged Mozilla with a typo, shipped in a botnet toolkit and unchanged for years.
  // It is the closest thing to a signature a hostile client hands you voluntarily.
  // `Mozlila` — a misspelling of Mozilla shipped in a botnet toolkit and unchanged for
  // years. It is the closest thing to a signature a hostile client hands over
  // voluntarily. The genuine IE6-on-XP string it is imitating is deliberately *not*
  // listed beside it: that string names a real, if nearly extinct, browser, and a
  // conclusive signature on it would deny service to whoever is still running one.
  { id: "forged-mozilla", name: "Known forged Mozilla string", tokens: ["mozlila/"], category: "security", benign: false, verification: { kind: "none" } },
];

/**
 * Bare HTTP clients and scripting libraries.
 *
 * A default library UA is one of the very few `certain` signals available from the
 * User-Agent alone, and the reason is worth stating: no browser ever sends
 * `python-requests/2.31.0`. The string is not evidence that the operator is hostile
 * — it is evidence that no human is looking at the response, which is a different
 * and much safer claim. Plenty of these are your own integrations; allowlist them.
 */
const LIBRARY: BotSignature[] = [
  { id: "curl", name: "curl", tokens: ["curl/"], category: "library", benign: false, verification: { kind: "none" } },
  { id: "wget", name: "Wget", tokens: ["wget/", "wget2/"], category: "library", benign: false, verification: { kind: "none" } },
  { id: "python", name: "Python HTTP clients", tokens: ["python-requests", "python-urllib", "python-httpx", "aiohttp/", "httpx/", "urllib3/", "scrapy/", "mechanize", "httplib2", "pycurl", "tornado/", "twisted", "grab/"], category: "library", benign: false, verification: { kind: "none" } },
  { id: "node", name: "Node, Deno and Bun HTTP clients", tokens: ["node-fetch", "axios/", "got (", "got/", "undici", "superagent", "bun/", "deno/", "crawlee", "cheerio"], category: "library", benign: false, verification: { kind: "none" } },
  { id: "go", name: "Go HTTP client", tokens: ["go-http-client", "go-resty", "colly", "fasthttp", "gocolly"], category: "library", benign: false, verification: { kind: "none" } },
  { id: "java", name: "JVM HTTP clients", tokens: ["java/", "java-http-client", "apache-httpclient", "okhttp", "jakarta commons-httpclient", "jsoup", "unirest", "ktor-client", "jetty/"], category: "library", benign: false, verification: { kind: "none" } },
  { id: "php", name: "PHP HTTP clients", tokens: ["guzzlehttp", "php/", "wordpress/", "drupal/", "symfony httpclient", "phpcrawl", "snoopy"], category: "library", benign: false, verification: { kind: "none" } },
  { id: "ruby", name: "Ruby HTTP clients", tokens: ["ruby/", "faraday", "typhoeus", "rest-client"], category: "library", benign: false, verification: { kind: "none" } },
  { id: "dotnet", name: ".NET HTTP clients", tokens: [".net clr", "restsharp", "httpclient/"], category: "library", benign: false, verification: { kind: "none" } },
  { id: "perl", name: "Perl", tokens: ["libwww-perl", "lwp::simple"], category: "library", benign: false, verification: { kind: "none" } },
  { id: "misc-cli", name: "Other CLI clients", tokens: ["httpie", "postmanruntime", "insomnia", "resty/", "aria2", "libcurl", "bruno/", "thunder client", "paw/", "lftp", "axel/"], category: "library", benign: false, verification: { kind: "none" } },
  // Rust was missing entirely, which mattered more than a gap in a list: a Rust
  // scraper reached the bare-product-token rule and was reported as an unrecognised
  // client rather than as the HTTP library it is.
  { id: "rust", name: "Rust HTTP clients", tokens: ["reqwest", "hyper/", "isahc/", "ureq/", "curl-rust"], category: "library", benign: false, verification: { kind: "none" } },
  // A load generator sits in `library` rather than in `monitoring`, and the placement
  // is a security decision rather than a taxonomic one: `monitoring` is a benign
  // category, and a benign category is on the default allow path. Usually k6 is your
  // own test — and when it is not, it is a flood, which is the one thing that must not
  // arrive pre-allowed.
  { id: "k6", name: "Grafana k6", tokens: ["k6/"], category: "library", benign: false, verification: { kind: "none" }, docs: "https://k6.io" },
  { id: "shell", name: "Shell and Windows HTTP clients", tokens: ["powershell", "winhttp", "wininet", "microsoft-cryptoapi", "microsoft url control"], category: "library", benign: false, verification: { kind: "none" } },
  { id: "site-mirrors", name: "Site mirroring tools", tokens: ["httrack", "sitesucker", "webcopier", "teleport pro", "offline explorer", "webzip", "wpull", "grab-site"], category: "library", benign: false, verification: { kind: "none" } },
  { id: "media-fetchers", name: "Media download tools", tokens: ["yt-dlp", "youtube-dl", "gallery-dl"], category: "library", benign: false, verification: { kind: "none" } },
];

/**
 * Automation-driven browser engines.
 *
 * These strings appear when the operator has not bothered to hide, which is common
 * and worth catching cheaply. A framework that *does* hide leaves this database
 * untouched — that is what the consistency and behavioural detectors are for.
 */
const HEADLESS: BotSignature[] = [
  { id: "headless-chrome", name: "Headless Chrome", tokens: ["headlesschrome", "headless_chrome"], category: "headless", benign: false, verification: { kind: "none" } },
  { id: "phantomjs", name: "PhantomJS", tokens: ["phantomjs"], category: "headless", benign: false, verification: { kind: "none" } },
  { id: "selenium", name: "Selenium", tokens: ["selenium", "webdriver"], category: "headless", benign: false, verification: { kind: "none" } },
  { id: "playwright", name: "Playwright", tokens: ["playwright"], category: "headless", benign: false, verification: { kind: "none" } },
  { id: "puppeteer", name: "Puppeteer", tokens: ["puppeteer"], category: "headless", benign: false, verification: { kind: "none" } },

  { id: "splash", name: "Splash / htmlunit", tokens: ["splash/", "htmlunit"], category: "headless", benign: false, verification: { kind: "none" } },
  { id: "driver-frameworks", name: "Browser automation frameworks", tokens: ["chromedp", "rod/", "cypress", "webdriverio", "nightmare", "zombie.js", "chromeless"], category: "headless", benign: false, verification: { kind: "none" } },
  // Scraping platforms: someone else's browser farm, rented by the request. Most of
  // their traffic wears a copied Chrome string and this signature never sees it — but
  // the default configurations do announce themselves, and the ones that do are worth
  // naming rather than leaving to the behavioural detectors.
  { id: "scraping-platforms", name: "Managed scraping platforms", tokens: ["apify", "scrapingbee", "scraperapi", "bright data", "brightdata", "zyte", "crawlera", "browserless", "browserbase", "hyperbrowser", "firecrawl", "diffbot-render"], category: "headless", benign: false, verification: { kind: "none" } },
];

/**
 * Real browser engines embedded in desktop applications.
 *
 * These are emphatically **not** automation, and the distinction cost this library a
 * bug: `Electron/` sat in the headless set, so opening the demo in VS Code's Simple
 * Browser produced a *proven* automation verdict for a person reading a page.
 *
 * The token is still worth recording — scrapers are occasionally built on Electron —
 * but only as a weak, non-conclusive observation that can never reach a blocking
 * action on its own.
 */
const EMBEDDED: BotSignature[] = [
  {
    id: "electron",
    name: "an Electron application",
    tokens: ["electron/"],
    category: "embedded",
    benign: true,
    conclusive: false,
    caveat: "Electron is an application framework, not an automation one. VS Code, Slack, Discord, Postman and Notion all embed a real Chromium that a person drives.",
    verification: { kind: "none" },
  },
  // Media playback stacks. The same argument as Electron, and a larger population:
  // `AppleCoreMedia` is what an iPhone sends while somebody listens to a podcast or
  // watches a video, and `CFNetwork/Darwin` is what most iOS applications send when a
  // person taps something inside them. Both are bare product tokens with no browser
  // preamble, so before this entry they reached the "unrecognised client" rule and
  // were reported as an HTTP library — which they are, with a person on the other end.
  {
    id: "apple-networking",
    name: "an Apple media or application HTTP stack",
    tokens: ["applecoremedia", "cfnetwork/"],
    category: "embedded",
    benign: true,
    conclusive: false,
    caveat: "AppleCoreMedia streams audio and video to a person's device, and CFNetwork is the networking layer under most iOS applications. Neither says anything about whether a person is driving.",
    verification: { kind: "none" },
  },
  {
    id: "media-players",
    name: "a desktop media player",
    tokens: ["vlc/", "libvlc", "mpv/", "gstreamer", "lavf/", "libavformat", "windows-media-player", "foobar2000", "kodi", "plex"],
    category: "embedded",
    benign: true,
    conclusive: false,
    caveat: "A media player fetching a stream has a person watching or listening. Refusing it does not stop a scraper; it stops playback.",
    verification: { kind: "none" },
  },
];

const ADVERTISING: BotSignature[] = [
  { id: "adsbot-google", name: "AdsBot-Google", tokens: ["adsbot-google", "mediapartners-google", "adsbot"], category: "advertising", benign: true, verification: { kind: "fcrdns", domains: ["googlebot.com", "google.com"] } },
  { id: "criteo", name: "Criteo", tokens: ["criteobot"], category: "advertising", benign: true, verification: { kind: "none" } },
  // Verification and contextual classification: they read a page to decide whether an ad
  // may appear beside it, or what the page is about. A publisher usually wants these and a
  // site with no advertising has no reason to.
  { id: "doubleverify", name: "DoubleVerify", tokens: ["doubleverifybot"], category: "advertising", benign: true, verification: { kind: "none" } },
  { id: "ias", name: "Integral Ad Science", tokens: ["ias crawler"], category: "advertising", benign: true, verification: { kind: "none" } },
  { id: "moat", name: "Moat", tokens: ["moatbot"], category: "advertising", benign: true, verification: { kind: "none" } },
  { id: "comscore", name: "comScore (Proximic)", tokens: ["proximic"], category: "advertising", benign: true, verification: { kind: "none" } },
  { id: "grapeshot", name: "Grapeshot", tokens: ["grapeshotcrawler"], category: "advertising", benign: true, verification: { kind: "none" } },
  { id: "peer39", name: "Peer39", tokens: ["peer39bot"], category: "advertising", benign: true, verification: { kind: "none" } },
  { id: "taboola", name: "Taboola", tokens: ["taboolabot"], category: "advertising", benign: true, verification: { kind: "none" } },
  { id: "outbrain", name: "Outbrain", tokens: ["outbrainbot"], category: "advertising", benign: true, verification: { kind: "none" } },
  { id: "pubmatic", name: "PubMatic", tokens: ["pubmaticbot"], category: "advertising", benign: true, verification: { kind: "none" } },
  { id: "thetradedesk", name: "The Trade Desk", tokens: ["ttd-content"], category: "advertising", benign: true, verification: { kind: "none" } },
  // Competitive ad intelligence rather than verification: it collects what everyone else
  // is running. Named, and left for the operator to decide about.
  { id: "adbeat", name: "Adbeat", tokens: ["adbeat_bot"], category: "advertising", benign: false, verification: { kind: "none" } },
];


/**
 * Listing and price collection: comparison shopping, marketplaces, and the metasearch
 * sites that aggregate travel and jobs.
 *
 * None of these is marked benign, and that is the point rather than an omission. The same
 * crawler is a distribution channel to one retailer and a competitor's research tool to
 * the next, so this library names it accurately and leaves the commercial question where
 * it belongs. A rule saying `category: ["commerce"]` is now possible to write, in either
 * direction.
 */
const COMMERCE: BotSignature[] = [
  { id: "idealo", name: "idealo", tokens: ["idealo-bot"], category: "commerce", benign: false, verification: { kind: "none" } },
  { id: "kelkoo", name: "Kelkoo", tokens: ["kelkoobot"], category: "commerce", benign: false, verification: { kind: "none" } },
  { id: "pricerunner", name: "PriceRunner", tokens: ["pricerunnerbot"], category: "commerce", benign: false, verification: { kind: "none" } },
  { id: "trivago", name: "Trivago", tokens: ["trivagobot"], category: "commerce", benign: false, verification: { kind: "none" } },
  { id: "skyscanner", name: "Skyscanner", tokens: ["skyscannerbot"], category: "commerce", benign: false, verification: { kind: "none" } },
  { id: "indeedbot", name: "Indeedbot", tokens: ["indeedbot"], category: "commerce", benign: true, robotsAgent: "Indeedbot", verification: { kind: "none" }, docs: "http://www.indeed.com/indeedbot.html" },
  { id: "adzuna", name: "Adzuna", tokens: ["adzunabot"], category: "commerce", benign: true, verification: { kind: "none" } },
];

/**
 * Research and measurement: citation indexes, scholarly catalogues, university web
 * science.
 *
 * Separate from `ai` deliberately. Both read the whole page and neither sends a person,
 * but an operator refusing to feed a commercial model may be perfectly happy to appear in
 * a citation index, and one category for both forces one answer onto two questions.
 * Research crawls are also, in practice, run by people who stop when asked.
 */
const ACADEMIC: BotSignature[] = [
  { id: "crossref", name: "Crossref", tokens: ["crossrefbot"], category: "academic", benign: true, verification: { kind: "none" } },
  { id: "openalex", name: "OpenAlex", tokens: ["openalexbot"], category: "academic", benign: true, verification: { kind: "none" } },
  { id: "webis", name: "Webis research crawler", tokens: ["webisbot"], category: "academic", benign: true, verification: { kind: "none" } },
];

/**
 * Link protection: a mail or messaging gateway fetching a URL a person was sent, before
 * that person is allowed to click it.
 *
 * All benign, and the reason is worth stating: blocking one of these does not inconvenience
 * a crawler, it tells somebody their mail contained a link that could not be checked. The
 * request is automation acting on a human's behalf, and it looks like automation because it
 * is — no cookie, no referer, once, from a datacentre.
 */
const EMAIL_SECURITY: BotSignature[] = [
  { id: "proofpoint", name: "Proofpoint URL Defense", tokens: ["proofpointurldefensebot"], category: "email-security", benign: true, verification: { kind: "none" } },
  { id: "mimecast", name: "Mimecast URL Protect", tokens: ["mimecasturlprotectbot"], category: "email-security", benign: true, verification: { kind: "none" } },
  { id: "barracuda", name: "Barracuda Link Protect", tokens: ["barracudalinkprotectbot"], category: "email-security", benign: true, verification: { kind: "none" } },
  { id: "cisco-esa", name: "Cisco Secure Email", tokens: ["ciscosecureemailbot"], category: "email-security", benign: true, verification: { kind: "none" } },
];

/**
 * Accessibility auditing.
 *
 * Almost always commissioned by the site's own owner and then forgotten about, which is
 * why it is not filed under `monitoring`: blocking it does not reduce load, it makes an
 * accessibility report look clean by removing the evidence.
 */
const ACCESSIBILITY: BotSignature[] = [
  { id: "siteimprove", name: "Siteimprove", tokens: ["siteimprovebot"], category: "accessibility", benign: true, robotsAgent: "SiteimproveBot", verification: { kind: "none" } },
];

/** Every built-in signature, in one array. Extend it via `extraSignatures` rather than editing. */
export const BOT_SIGNATURES: readonly BotSignature[] = Object.freeze([
  ...SEARCH,
  ...AI,
  ...SEO,
  ...SOCIAL,
  ...MONITORING,
  ...ARCHIVE,
  ...FEED,
  ...SECURITY,
  ...ADVERTISING,
  ...LIBRARY,
  ...HEADLESS,
  ...EMBEDDED,
  ...COMMERCE,
  ...ACADEMIC,
  ...ACCESSIBILITY,
  ...EMAIL_SECURITY,
]);

/**
 * Compiles signatures into a single-pass matcher. Build this once per engine, never
 * per request — construction is O(total pattern length) and matching is O(input).
 */
export function compileSignatures(signatures: readonly BotSignature[] = BOT_SIGNATURES): MultiPatternMatcher<BotSignature> {
  const entries: Array<[string, BotSignature]> = [];
  for (const signature of signatures) {
    for (const token of signature.tokens) entries.push([token.toLowerCase(), signature]);
  }
  return new MultiPatternMatcher(entries);
}

/** Index by id, so rules can name a bot (`"googlebot"`) and get its metadata back. */
export function indexSignatures(signatures: readonly BotSignature[] = BOT_SIGNATURES): ReadonlyMap<string, BotSignature> {
  return new Map(signatures.map((signature) => [signature.id, signature]));
}

/** Categories whose members are, by default, worth serving. Used by `allowBenignBots`. */
export const BENIGN_CATEGORIES: ReadonlySet<BotCategory> = new Set<BotCategory>(["search", "social", "monitoring", "feed", "archive", "advertising"]);
