import { crawler } from "./headers.js";
import { bot } from "./schema.js";
import type { TrafficCase } from "./schema.js";

/**
 * Crawlers with a job other than general search.
 *
 * Price comparison, job aggregation, travel metasearch, academic indexing, news
 * syndication, brand protection, accessibility auditing. Most sites want some of
 * these and not others, and which is which is a commercial question rather than a
 * technical one — a price comparator is a distribution channel to one retailer and a
 * competitor's research tool to another.
 *
 * The library's job here is only to name them accurately enough that a rule can pick
 * sides. Every case therefore asserts identification, and none asserts an action.
 */

function vertical(
  id: string,
  title: string,
  category: string,
  userAgent: string,
  provenance: string,
  options: { audience?: TrafficCase["audience"]; identity?: string; notes?: string; accept?: string } = {},
): TrafficCase {
  return bot({
    id,
    title,
    audience: options.audience ?? "declared-bot",
    category,
    provenance,
    ...(options.notes !== undefined ? { notes: options.notes } : {}),
    requests: [crawler(userAgent, options.accept !== undefined ? { accept: options.accept } : {})],
    expect: {
      verdict: "confirmed-bot",
      certain: true,
      detectors: ["self-identified"],
      ...(options.identity !== undefined ? { identity: options.identity } : {}),
    },
  });
}

export const VERTICAL_CRAWLER_CASES: TrafficCase[] = [
  // ---- Shopping and price comparison ----
  vertical("vc-google-merchant", "Google Merchant Center feed fetch", "commerce-crawler", "Mozilla/5.0 (compatible; Google-Shopping-Quality; +http://www.google.com/bot.html)", "Validates product feeds and landing pages for Shopping listings; blocking it suspends your listings", { identity: "googlebot", audience: "benign-bot" }),
  vertical("vc-idealo", "Idealo price comparison", "commerce-crawler", "Mozilla/5.0 (compatible; idealo-bot/1.0; +https://www.idealo.de/robots)", "The largest price comparison site in Germany; a distribution channel for many retailers", {}),
  vertical("vc-kelkoo", "Kelkoo", "commerce-crawler", "Mozilla/5.0 (compatible; KelkooBot/1.0; +https://www.kelkoo.com/bot)", "European shopping comparison", {}),
  vertical("vc-pricerunner", "PriceRunner", "commerce-crawler", "Mozilla/5.0 (compatible; PriceRunnerBot/1.0; +https://www.pricerunner.com/robot)", "Nordic and UK price comparison", {}),
  vertical("vc-shopping-feed", "A shopping feed aggregator", "commerce-crawler", "Mozilla/5.0 (compatible; ShoppingFeedBot/2.1; +https://feeds.example/crawler)", "Feed aggregators fetch a product XML on a schedule and then verify the landing pages", {}),
  vertical("vc-honey-coupon", "A coupon extension's backend", "commerce-crawler", "Mozilla/5.0 (compatible; CouponFinderBot/1.4; +https://coupons.example/bot)", "Browser coupon extensions test discount codes at checkout from their own servers", { audience: "unwanted-bot", notes: "Runs on behalf of a real shopper, from a server, against your checkout. Neither clearly wanted nor clearly hostile — exactly the kind of case a policy has to decide about deliberately." }),
  vertical("vc-stock-tracker", "An availability tracker", "commerce-crawler", "Mozilla/5.0 (compatible; StockAlertBot/3.0; +https://stockalert.example/about-our-bot)", "Restock trackers poll product pages continuously on behalf of subscribers", { audience: "unwanted-bot" }),

  // ---- Jobs, property and travel ----
  vertical("vc-indeed", "Indeed's job crawler", "vertical-crawler", "Mozilla/5.0 (compatible; Indeedbot/1.1; +http://www.indeed.com/indeedbot.html)", "Aggregates job postings; for a recruiter it is free distribution", { audience: "benign-bot" }),
  vertical("vc-adzuna", "Adzuna", "vertical-crawler", "Mozilla/5.0 (compatible; AdzunaBot/1.0; +https://www.adzuna.co.uk/bot)", "Job aggregation across Europe", { audience: "benign-bot" }),
  vertical("vc-trivago", "Trivago's rate crawler", "vertical-crawler", "Mozilla/5.0 (compatible; TrivagoBot/1.0; +https://www.trivago.com/bot)", "Hotel metasearch fetching live rates", {}),
  vertical("vc-skyscanner", "Skyscanner", "vertical-crawler", "Mozilla/5.0 (compatible; SkyscannerBot/1.0; +https://www.skyscanner.net/bot)", "Flight metasearch fetching live fares from airline and agency sites", {}),
  vertical("vc-property-portal", "A property portal's listing crawler", "vertical-crawler", "Mozilla/5.0 (compatible; PropertyIndexBot/2.3; +https://property.example/crawler)", "Property portals crawl agent sites to keep listings in sync", {}),

  // ---- News and syndication ----
  vertical("vc-newsblur", "NewsBlur", "feed-reader", "NewsBlur Feed Fetcher - 412 subscribers - https://www.newsblur.com/site/9124/shop-example (Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7))", "NewsBlur names the subscriber count and the exact feed page, which is genuinely useful information", { audience: "benign-bot", notes: "Note the nested Mozilla string inside the parentheses. Publishers can and do use the subscriber count to decide how much a feed reader is worth serving." }),
  vertical("vc-google-news", "Google News publisher crawl", "news-crawler", "Mozilla/5.0 (compatible; Googlebot-News; +http://www.google.com/bot.html)", "News indexing runs on a separate crawl budget from web search", { identity: "googlebot", audience: "benign-bot" }),
  vertical("vc-apple-news", "Apple News", "news-crawler", "Mozilla/5.0 (compatible; AppleNewsBot/1.0; +http://www.apple.com/go/applebot)", "Fetches articles for the Apple News channel", { identity: "applebot", audience: "benign-bot" }),
  vertical("vc-smartnews", "SmartNews", "news-crawler", "Mozilla/5.0 (compatible; SmartNewsBot/1.0; +https://www.smartnews.com/bot)", "A very large news aggregator in Japan and the United States", { audience: "benign-bot" }),
  vertical("vc-flipboard", "Flipboard", "news-crawler", "Mozilla/5.0 (compatible; FlipboardProxy/1.1; +http://flipboard.com/browserproxy)", "Fetches and re-renders articles for Flipboard's reader", { audience: "benign-bot" }),
  vertical("vc-podcast-index", "Podcast Index", "feed-reader", "Mozilla/5.0 (compatible; PodcastIndexBot/1.0; +https://podcastindex.org/bot)", "An open podcast directory crawling feeds", { audience: "benign-bot" }),

  // ---- Academic and research ----
  vertical("vc-semantic-scholar", "Semantic Scholar", "research-crawler", "Mozilla/5.0 (compatible; SemanticScholarBot/1.0; +https://www.semanticscholar.org/crawler)", "The Allen Institute's academic index", { audience: "benign-bot" }),
  vertical("vc-crossref", "Crossref", "research-crawler", "Mozilla/5.0 (compatible; CrossrefBot/1.0; mailto:labs@crossref.org)", "DOI registration and metadata; note the mailto contact rather than a URL", { audience: "benign-bot" }),
  vertical("vc-openalex", "OpenAlex", "research-crawler", "Mozilla/5.0 (compatible; OpenAlexBot/1.0; +https://openalex.org/bot; mailto:support@openalex.org)", "An open catalogue of scholarly works", { audience: "benign-bot" }),
  vertical("vc-webis", "A university research crawl", "research-crawler", "Mozilla/5.0 (compatible; WebisBot/1.0; +https://webis.de/crawler.html; research crawl, please contact us for exclusion)", "Academic web-science groups crawl at scale and generally honour exclusion requests promptly", { audience: "benign-bot", notes: "Research crawls are usually run by people who will stop if you ask. An email is often faster and cheaper than a block rule." }),
  vertical("vc-common-crawl-news", "Common Crawl's news crawl", "research-crawler", "CCBot/2.0 (https://commoncrawl.org/faq/)", "The news subset of Common Crawl, refreshed continuously", { identity: "ccbot" }),

  // ---- Accessibility, compliance and quality ----
  vertical("vc-axe-monitor", "An accessibility auditing crawler", "compliance-crawler", "Mozilla/5.0 (compatible; AccessibilityMonitorBot/4.0; +https://a11y-monitor.example/bot)", "Automated WCAG auditing, often run under a legal compliance programme", { audience: "benign-bot", notes: "Frequently commissioned by the site owner and then forgotten about. Blocking it makes an accessibility report look clean by removing the evidence." }),
  vertical("vc-siteimprove", "Siteimprove", "compliance-crawler", "Mozilla/5.0 (compatible; SiteimproveBot/2.0; +https://siteimprove.com/bot)", "Quality and accessibility auditing for large organisations", { audience: "benign-bot" }),
  vertical("vc-w3c-validator", "The W3C validator", "compliance-crawler", "W3C_Validator/1.3 http://validator.w3.org/services", "Somebody clicked Validate on your page", { audience: "benign-bot" }),
  vertical("vc-ssl-labs", "SSL Labs", "compliance-crawler", "Mozilla/5.0 (compatible; SSL Labs/1.0; +https://www.ssllabs.com/about/assessment.html)", "TLS configuration assessment, usually run by the site's own operator", { audience: "benign-bot" }),

  // ---- Brand protection and enforcement ----
  vertical("vc-brand-protection", "A brand-protection crawler", "enforcement-crawler", "Mozilla/5.0 (compatible; BrandProtectBot/2.0; +https://brandprotect.example/crawler)", "Looks for counterfeit listings and trademark misuse", {}),
  vertical("vc-copyright-scan", "A copyright enforcement crawler", "enforcement-crawler", "Mozilla/5.0 (compatible; CopyrightScanBot/1.2; +https://rights.example/bot)", "Rights-holder agents scan for infringing copies", {}),
  vertical("vc-domain-monitor", "A domain and certificate monitor", "enforcement-crawler", "Mozilla/5.0 (compatible; DomainWatchBot/1.0; +https://domainwatch.example/bot)", "Watches for lookalike domains and certificate issuance", {}),

  // ---- Archival and preservation ----
  vertical("vc-archive-today", "archive.today", "archive-crawler", "Mozilla/5.0 (compatible; archive.today; +http://archive.today/legal)", "On-demand page archiving triggered by a person pasting a URL", { audience: "benign-bot" }),
  vertical("vc-perma-cc", "Perma.cc", "archive-crawler", "Mozilla/5.0 (compatible; perma.cc; +https://perma.cc/about)", "Harvard's citation-preservation service, used heavily by courts and journals", { audience: "benign-bot" }),
  vertical("vc-national-library", "A national library web archive", "archive-crawler", "Mozilla/5.0 (compatible; heritrix/3.4.0 +https://www.bl.uk/collection-guides/uk-web-archive)", "Legal-deposit archiving; in several countries a library has a statutory right to crawl", { identity: "heritrix", audience: "benign-bot" }),
  vertical("vc-conifer", "Webrecorder", "archive-crawler", "Mozilla/5.0 (compatible; Webrecorder/2.0; +https://webrecorder.net/crawler)", "High-fidelity archiving of dynamic pages", { audience: "benign-bot" }),

  // ---- Security and reputation ----
  vertical("vc-safe-browsing", "Google Safe Browsing", "reputation-crawler", "Mozilla/5.0 (compatible; Google-Safety; +http://www.google.com/bot.html)", "Checks pages for malware and phishing; blocking it risks an unresolvable warning interstitial", { identity: "googlebot", audience: "benign-bot", notes: "One of the few crawlers where blocking has a direct, visible cost to your own visitors: a Safe Browsing warning is shown to every Chrome user." }),
  vertical("vc-virustotal", "VirusTotal URL scan", "reputation-crawler", "Mozilla/5.0 (compatible; VirusTotalCloud/1.0; +https://www.virustotal.com/bot)", "Somebody submitted your URL for scanning", { audience: "benign-bot" }),
  vertical("vc-urlscan", "urlscan.io", "reputation-crawler", "Mozilla/5.0 (compatible; urlscan.io/1.0; +https://urlscan.io/about/)", "Renders a page in a sandbox and publishes the result", { audience: "benign-bot" }),
  vertical("vc-phishtank", "PhishTank verification", "reputation-crawler", "Mozilla/5.0 (compatible; PhishTankBot/1.0; +https://phishtank.org/bot)", "Verifies reported phishing URLs", { audience: "benign-bot" }),

  // ---- SEO auditing run by the site's own owner ----
  vertical("vc-screaming-frog", "Screaming Frog", "seo-crawler", "Screaming Frog SEO Spider/21.4", "A desktop crawler; almost always the site's own SEO team auditing their own site", { audience: "benign-bot", notes: "No contact URL and no vendor infrastructure — it runs from somebody's laptop, so it arrives from a residential address. Blocking it blocks your own audit." }),
  vertical("vc-sitebulb", "Sitebulb", "seo-crawler", "Mozilla/5.0 (compatible; Sitebulb/6.5; +https://sitebulb.com/bot)", "Another desktop SEO auditor", { audience: "benign-bot" }),
  vertical("vc-lumar", "Lumar", "seo-crawler", "Mozilla/5.0 (compatible; deepcrawl; +https://www.lumar.io/bot)", "Enterprise site auditing, formerly DeepCrawl", { audience: "unwanted-bot" }),
  vertical("vc-oncrawl", "OnCrawl", "seo-crawler", "Mozilla/5.0 (compatible; OnCrawl/1.0; +https://www.oncrawl.com/bot)", "Enterprise SEO crawling", { audience: "unwanted-bot" }),
];
