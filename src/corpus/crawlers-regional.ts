import { crawler } from "./headers.js";
import { bot } from "./schema.js";
import type { TrafficCase } from "./schema.js";

/**
 * Search and discovery crawlers from outside the anglophone web.
 *
 * A corpus assembled from one developer's own logs is a corpus of one market. These
 * crawlers index the search engines that most of the world actually uses — Naver in
 * Korea, Seznam in Czechia, Yandex across the CIS, Baidu and Sogou in China, Coccoc
 * in Vietnam — and blocking them is invisible from a London office and catastrophic
 * for a business that sells into those markets.
 *
 * Nearly all follow the same convention: a `bot` or `spider` word, and a contact
 * address prefixed with `+`. That pairing is a declaration, which is why the library
 * reaches a proven verdict on clients it has never heard of.
 */

function declaredCrawler(id: string, title: string, userAgent: string, provenance: string, options: { identity?: string; from?: string; notes?: string; audience?: TrafficCase["audience"] } = {}): TrafficCase {
  return bot({
    id,
    title,
    audience: options.audience ?? "benign-bot",
    category: "regional-crawler",
    provenance,
    ...(options.notes !== undefined ? { notes: options.notes } : {}),
    requests: [crawler(userAgent, options.from !== undefined ? { from: options.from } : {})],
    expect: {
      verdict: "confirmed-bot",
      certain: true,
      detectors: ["self-identified"],
      ...(options.identity !== undefined ? { identity: options.identity } : {}),
    },
  });
}

export const REGIONAL_CRAWLER_CASES: TrafficCase[] = [
  // ---- East Asia ----
  declaredCrawler("rc-naver-yeti", "Naver Yeti", "Mozilla/5.0 (compatible; Yeti/1.1; +https://naver.me/spd)", "The dominant search engine in South Korea; Naver's share there exceeds Google's", { identity: "naver-yeti" }),
  declaredCrawler("rc-naver-yeti-mobile", "Naver Yeti, mobile crawl", "Mozilla/5.0 (Linux; U; Android 11; ko-kr;) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 (compatible; Yeti-Mobile/0.1; +https://naver.me/spd)", "Naver crawls mobile-first, like Google", { identity: "naver-yeti" }),
  declaredCrawler("rc-daum", "Daumoa", "Mozilla/5.0 (compatible; Daumoa/4.0; +https://cs.daum.net/faq/15/4118.html)", "Kakao's search crawler, the second Korean index"),
  declaredCrawler("rc-baidu-mobile", "Baiduspider, mobile crawl", "Mozilla/5.0 (Linux;u;Android 4.2.2;zh-cn;) AppleWebKit/534.46 (KHTML,like Gecko) Version/5.1 Mobile Safari/10600.6.3 (compatible; Baiduspider-render/2.0; +http://www.baidu.com/search/spider.html)", "Baidu's rendering crawler; note the frozen Android 4.2.2 device string", { identity: "baiduspider" }),
  declaredCrawler("rc-baidu-image", "Baiduspider-image", "Baiduspider-image+(+http://www.baidu.com/search/spider.htm)", "Baidu's image crawler uses a bare, unusual User-Agent with a doubled plus", { identity: "baiduspider" }),
  declaredCrawler("rc-sogou-inst", "Sogou inst spider", "Sogou inst spider/4.0(+http://www.sogou.com/docs/help/webmasters.htm#07)", "Sogou's instant-answer crawler; a major Chinese index owned by Tencent", { identity: "sogou" }),
  declaredCrawler("rc-360-spider", "360Spider", "Mozilla/5.0 (compatible; 360Spider/1.0; +http://www.so.com/help/help_3_2.html)", "Qihoo 360's search crawler, a significant Chinese index", {}),
  declaredCrawler("rc-shenma", "YisouSpider", "Mozilla/5.0 (Linux; U; Android 12; zh-CN;) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Mobile Safari/537.36 (compatible; YisouSpider/5.0; +http://www.yisou.com/help_center.html)", "Alibaba's Shenma mobile search crawler, large in Chinese mobile search", {}),
  declaredCrawler("rc-bytedance-toutiao", "Bytedance search crawler", "Mozilla/5.0 (Linux; Android 8.0; Pixel 2 Build/OPD3.170816.012) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/81.0.4044.117 Mobile Safari/537.36 (compatible; Bytespider; spider-feedback@bytedance.com)", "ByteDance's crawler, feeding Toutiao search and model training", { identity: "bytespider", audience: "unwanted-bot", notes: "Widely reported for aggressive rates and inconsistent robots.txt compliance. Honest about who it is, all the same." }),

  // ---- The CIS and Eastern Europe ----
  declaredCrawler("rc-yandex-images", "YandexImages", "Mozilla/5.0 (compatible; YandexImages/3.0; +http://yandex.com/bots)", "Yandex runs a fleet of specialised crawlers under one verification domain", { identity: "yandexbot" }),
  declaredCrawler("rc-yandex-mobile", "YandexMobileBot", "Mozilla/5.0 (iPhone; CPU iPhone OS 8_1 like Mac OS X) AppleWebKit/600.1.4 (KHTML, like Gecko) Version/8.0 Mobile/12B411 Safari/600.1.4 (compatible; YandexMobileBot/3.0; +http://yandex.com/bots)", "Yandex's mobile-first crawler", { identity: "yandexbot" }),
  declaredCrawler("rc-yandex-accessibility", "YandexAccessibilityBot", "Mozilla/5.0 (compatible; YandexAccessibilityBot/3.0; +http://yandex.com/bots)", "Checks pages for accessibility problems on Yandex's behalf", { identity: "yandexbot" }),
  declaredCrawler("rc-mail-ru", "Mail.RU_Bot", "Mozilla/5.0 (compatible; Linux x86_64; Mail.RU_Bot/2.0; +http://go.mail.ru/help/robots)", "The crawler behind Mail.ru's search and its social previews", {}),
  declaredCrawler("rc-seznam-mobile", "SeznamBot mobile", "Mozilla/5.0 (compatible; SeznamBot/4.0-mobile; +http://napoveda.seznam.cz/seznambot-intro/)", "Seznam holds a substantial share of Czech search", { identity: "seznambot" }),

  // ---- Southeast and South Asia ----
  declaredCrawler("rc-coccoc", "Coccoc bot", "Mozilla/5.0 (compatible; coccocbot-web/1.0; +http://help.coccoc.com/searchengine)", "Coc Coc is a major Vietnamese search engine and browser", {}),
  declaredCrawler("rc-coccoc-image", "Coccoc image bot", "Mozilla/5.0 (compatible; coccocbot-image/1.0; +http://help.coccoc.com/searchengine)", "Coc Coc's image crawler", {}),
  declaredCrawler("rc-petal-mobile", "PetalBot, mobile crawl", "Mozilla/5.0 (Linux; Android 7.0;) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 (compatible; PetalBot;+https://webmaster.petalsearch.com/site/petalbot)", "Huawei's Petal Search, the default on Huawei devices outside Google's ecosystem", { identity: "petalbot" }),

  // ---- Europe and the Americas ----
  declaredCrawler("rc-qwant", "Qwantbot", "Mozilla/5.0 (compatible; Qwantbot/1.0; +https://help.qwant.com/bot/)", "A French privacy-focused engine; blocking it removes a European alternative from your reach", { identity: "qwantbot" }),
  declaredCrawler("rc-mojeek", "MojeekBot", "Mozilla/5.0 (compatible; MojeekBot/0.11; +https://www.mojeek.com/bot.html)", "A British independent index — one of very few crawlers building an index from scratch", { identity: "mojeek" }),
  declaredCrawler("rc-startpage", "Startpage", "Mozilla/5.0 (compatible; StartpageBot/1.0; +https://www.startpage.com/robot)", "A Dutch privacy-preserving front end", {}),
  declaredCrawler("rc-ecosia", "Ecosia", "Mozilla/5.0 (compatible; EcosiaBot/1.0; +https://ecosia.org/bot)", "A German search engine that plants trees with its ad revenue", {}),
  declaredCrawler("rc-brave-search", "Brave Search", "Mozilla/5.0 (compatible; BraveSearchBot/1.0; +https://search.brave.com/help/brave-search-crawler)", "Brave builds its own index rather than reselling another engine's", {}),
  declaredCrawler("rc-kagi", "Kagi Search", "Mozilla/5.0 (compatible; Kagibot/1.0; +https://kagi.com/bot)", "A subscription search engine whose crawler is small but whose users are paying customers", {}),
  declaredCrawler("rc-stract", "Stract", "Mozilla/5.0 (compatible; StractBot/0.2; open source search engine; +https://trystract.com/webmasters)", "An open-source independent index", {}),
  declaredCrawler("rc-right-dao", "RightDao", "Mozilla/5.0 (compatible; RightDaoBot/1.0; +https://rightdao.com/bot)", "A small independent index", {}),
  declaredCrawler("rc-gigablast", "Gigablast", "Mozilla/5.0 (compatible; GigablastOpenSource/1.0; +http://www.gigablast.com/spider.html)", "A long-running open-source crawler", {}),

  // ---- Specialist Google and Microsoft fleets ----
  declaredCrawler("rc-googlebot-image", "Googlebot-Image", "Googlebot-Image/1.0", "Google's image crawler sends a bare product token with no contact URL at all", { identity: "googlebot", notes: "Recognised only because a signature knows the token. Google's own fleet does not consistently follow the contact convention, which is a useful corrective to any rule that assumes crawlers are legible." }),
  declaredCrawler("rc-googlebot-news", "Googlebot-News", "Googlebot-News", "Google News indexing; another bare token", { identity: "googlebot" }),
  declaredCrawler("rc-googlebot-video", "Googlebot-Video", "Googlebot-Video/1.0", "Google's video crawler", { identity: "googlebot" }),
  declaredCrawler("rc-google-favicon", "Google Favicon", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Google Favicon", "Fetches favicons for search results and bookmarks", { identity: "googlebot", notes: "A full Chrome User-Agent with a two-word suffix and none of the headers Chrome sends. Before a signature existed for it this scored 90 as an impersonator — a legitimate Google fetcher, one token away from being blocked." }),
  declaredCrawler("rc-google-read-aloud", "Google Read Aloud", "Mozilla/5.0 (Linux; Android 7.0;) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 (compatible; Google-Read-Aloud; +https://developers.google.com/search/docs/crawling-indexing/overview-google-crawlers)", "Fetches pages so Assistant can read them aloud — an accessibility surface", { identity: "googlebot", notes: "Blocking this removes a page from a text-to-speech surface that some people rely on to read the web at all." }),
  declaredCrawler("rc-google-site-verification", "Google Site Verification", "Mozilla/5.0 (compatible; Google-Site-Verification/1.0)", "Confirms ownership during Search Console setup; blocking it blocks your own onboarding", { identity: "googlebot" }),
  declaredCrawler("rc-bing-preview", "BingPreview", "Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/534+ (KHTML, like Gecko) BingPreview/1.0b", "Renders page snapshots for Bing results; note the unusual 'AppleWebKit/534+' version", { identity: "bingbot" }),
  declaredCrawler("rc-adidxbot", "adidxbot", "Mozilla/5.0 (compatible; adidxbot/2.0; +http://www.bing.com/bingbot.htm)", "Microsoft Advertising's landing-page crawler", { identity: "bingbot" }),
  declaredCrawler("rc-msnbot-media", "MSNBot-Media", "msnbot-media/1.1 (+http://search.msn.com/msnbot.htm)", "Microsoft's media crawler, still using the historic msnbot name", { identity: "bingbot" }),
  declaredCrawler("rc-apple-siri", "Applebot for Siri", "Mozilla/5.0 (Device; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1 (Applebot/0.1; +http://www.apple.com/go/applebot)", "Powers Siri suggestions and Spotlight; note the literal word 'Device' where a model would be", { identity: "applebot" }),
];
