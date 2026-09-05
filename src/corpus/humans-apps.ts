import { plain } from "./headers.js";
import { cookieJar } from "./cookies.js";
import { human } from "./schema.js";
import type { Header } from "./headers.js";
import type { TrafficCase } from "./schema.js";

/**
 * People inside somebody else's app.
 *
 * A large and growing share of mobile traffic never touches a standalone browser. A
 * link tapped in Instagram, TikTok, Discord or a banking app opens in an embedded
 * WebView: a real engine, a real person, and a User-Agent carrying the host
 * application's name bolted onto the end.
 *
 * These are the clients most likely to be misread, for a specific reason. An embedded
 * WebView is frequently pinned to an older Chromium and frequently omits the Client
 * Hints and Fetch Metadata that a standalone browser of the claimed version would
 * send. Read literally that is a strong impersonation signal. Read correctly it is
 * a customer who tapped a link in an app.
 *
 * The desktop half of the file is the same problem in a different shape: Electron
 * applications embed a real Chromium with a person driving it, and one of them —
 * VS Code's Simple Browser — was misclassified as proven automation by a shipped
 * version of this library.
 */

/** An in-app WebView: an engine string, an app suffix, and the reduced header set they send. */
function webview(id: string, title: string, userAgent: string, provenance: string, options: { notes?: string; extra?: readonly Header[]; language?: string; cookie?: boolean } = {}): TrafficCase {
  const headers: Header[] = [
    ["Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8"],
    ["Accept-Language", options.language ?? "en-GB,en;q=0.9"],
    ["Accept-Encoding", "gzip, deflate, br"],
    ["Upgrade-Insecure-Requests", "1"],
    ...(options.extra ?? []),
    ...(options.cookie === false ? [] : ([["Cookie", cookieJar({ visitor: id, analytics: true })]] as Header[])),
  ];
  return human({
    id,
    title,
    category: "in-app-webview",
    provenance,
    ...(options.notes !== undefined ? { notes: options.notes } : {}),
    requests: [plain(userAgent, headers)],
    expect: { certain: false },
  });
}

export const HUMAN_APP_CASES: TrafficCase[] = [
  // ---------------------------------------------------------------------------
  // Social apps on iOS. WebKit underneath, with the app's own suffix.
  // ---------------------------------------------------------------------------
  webview(
    "app-instagram-ios",
    "A link tapped in Instagram on iOS",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 372.1.0.28.104 (iPhone17,1; iOS 18_6_1; en_GB; en; scale=3.00; 1206x2622; 748291056; IABMV/1)",
    "Instagram appends its version plus a full device descriptor and drops the Safari token entirely",
    { notes: "Note what is missing: no Safari/ token, so a check keyed on the browser name finds nothing to check. The IABMV flag marks the in-app browser build." },
  ),
  webview("app-instagram-android", "A link tapped in Instagram on Android", "Mozilla/5.0 (Linux; Android 15; SM-S931B Build/AP3A.240905.015.A2; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/149.0.7202.61 Mobile Safari/537.36 Instagram 372.0.0.39.108 Android (35/15; 450dpi; 1080x2229; samsung; SM-S931B; e3q; qcom; en_GB; 745123098)", "The Android build carries a wv token marking the WebView, plus a device and locale block"),
  webview("app-facebook-ios", "A link tapped in Facebook on iOS", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/500.0.0.44.107;FBBV/687451209;FBDV/iPhone17,1;FBMD/iPhone;FBSN/iOS;FBSV/18.6.1;FBSS/3;FBID/phone;FBLC/en_GB;FBOP/5;FBRV/0]", "The bracketed FB block names the app, build, device, OS and locale"),
  webview("app-facebook-android", "A link tapped in Facebook on Android", "Mozilla/5.0 (Linux; Android 14; SM-A556B Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/147.0.7071.53 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/500.0.0.32.109;]", "Android Facebook WebViews use FB_IAB and FBAV rather than the iOS block"),
  webview("app-messenger", "A link tapped in Messenger", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/MessengerForiOS;FBAV/500.1.0.52.106;FBBV/687912344;FBDV/iPhone16,2;FBMD/iPhone;FBSN/iOS;FBSV/18.6;FBSS/3;FBID/phone;FBLC/en_US;FBOP/5]", "Messenger identifies itself distinctly from the main Facebook app"),
  webview("app-tiktok-android", "A link tapped in TikTok", "Mozilla/5.0 (Linux; Android 14; 23021RAA2Y Build/UKQ1.230917.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/143.0.6980.113 Mobile Safari/537.36 musical_ly_2024505030 JsSdk/1.0 NetType/WIFI Channel/googleplay AppName/musical_ly app_version/40.5.3 ByteLocale/en ByteFullLocale/en Region/GB AppSkin/white AppTheme/light BytedanceWebview/d8a21c6", "TikTok carries both the legacy musical_ly token and a BytedanceWebview build hash", { notes: "Contains 'Bytedance' but not 'Bytespider'. A substring match on the vendor name would classify a person as ByteDance's crawler." }),
  webview("app-tiktok-ios", "A link tapped in TikTok on iOS", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 musical_ly_40.5.3 JsSdk/2.0 NetType/WIFI Channel/App Store ByteLocale/en Region/US isDarkMode/0 WKWebView/1 BytedanceWebview/d8a21c6", "The iOS build names WKWebView explicitly"),
  webview("app-snapchat", "A link tapped in Snapchat", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Snapchat/13.31.0.48 (like Safari/605.1.15)", "Snapchat's suffix says 'like Safari' rather than claiming to be Safari"),
  webview("app-linkedin", "A link tapped in the LinkedIn app", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [LinkedInApp]", "A bracketed suffix and nothing else", { notes: "Distinct from LinkedInBot, which is the unfurler. One is a person; the other is not; the strings differ by six characters." }),
  webview("app-pinterest", "A link tapped in Pinterest", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Pinterest for iOS/13.12", "Pinterest names itself and the platform in plain words"),
  webview("app-reddit", "A link tapped in the Reddit app", "Mozilla/5.0 (Linux; Android 15; Pixel 9 Build/AP4A.250105.002; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/149.0.7202.61 Mobile Safari/537.36 RedditAndroid/2025.03.0", "The Reddit app opens links in a WebView by default"),
  webview("app-x-twitter", "A link tapped in X", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Twitter for iPhone/10.71", "X still identifies its iOS client by the old product name"),
  webview("app-discord", "A link tapped in Discord on mobile", "Mozilla/5.0 (Linux; Android 14; SM-G991B Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/147.0.7071.53 Mobile Safari/537.36 Discord/271.0", "Discord's mobile WebView", { notes: "Distinct from Discordbot, which unfurls the link into an embed before anyone taps it. Both arrive for the same shared URL, seconds apart." }),
  webview("app-telegram", "A link tapped in Telegram", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Telegram-iOS/11.5", "Telegram's in-app browser"),
  webview("app-whatsapp", "A link tapped in WhatsApp", "Mozilla/5.0 (Linux; Android 15; SM-S931B Build/AP3A.240905.015; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/149.0.7202.61 Mobile Safari/537.36", "WhatsApp's Android WebView adds no suffix at all — only the wv token distinguishes it", { notes: "No app name anywhere. Indistinguishable from any other Android WebView, which is why the wv marker has to carry the weight." }),
  webview("app-line", "A link tapped in LINE", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari/604.1 Line/14.20.0", "LINE is the dominant messenger in Japan, Taiwan and Thailand", { language: "ja-JP,ja;q=0.9,en-US;q=0.8" }),
  webview("app-kakaotalk", "A link tapped in KakaoTalk", "Mozilla/5.0 (Linux; Android 15; SM-S938N Build/AP3A.240905.015; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/147.0.7071.53 Mobile Safari/537.36 KAKAOTALK 25.3.1", "The dominant messenger in South Korea", { language: "ko-KR,ko;q=0.9,en-US;q=0.8" }),
  webview("app-wechat-ios", "A link tapped in WeChat", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.58(0x18003a2b) NetType/WIFI Language/en", "WeChat's WebView is the entry point to an entire application ecosystem in China", { language: "zh-CN,zh;q=0.9,en;q=0.8" }),
  webview("app-weibo", "A link tapped in Weibo", "Mozilla/5.0 (Linux; Android 14; 2211133C Build/UKQ1.230804.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/122.0.6261.119 Mobile Safari/537.36 Weibo (Xiaomi-2211133C__weibo__14.9.0__android__android14)", "Weibo packs the manufacturer, app and OS versions into a parenthesised block", { language: "zh-CN,zh;q=0.9" }),
  webview("app-vk", "A link tapped in VK", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 VKClient/8.32", "The dominant social network across the CIS", { language: "ru-RU,ru;q=0.9,en-US;q=0.8" }),

  // ---------------------------------------------------------------------------
  // Non-social apps that embed a browser: banking, travel, retail, news.
  // ---------------------------------------------------------------------------
  webview("app-banking-3ds", "A 3-D Secure challenge inside a banking app", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 ExampleBank/7.14.2", "Card authentication opens the issuer's page inside the app's WebView", { notes: "A payment failing here is a lost order and a support call, and the person has no way to switch browser." }),
  webview("app-retail-loyalty", "A retailer's app opening its own web page", "Mozilla/5.0 (Linux; Android 15; Pixel 8 Build/AP4A.250105.002; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/149.0.7202.61 Mobile Safari/537.36 ExampleShop/9.4.1", "Native apps commonly render loyalty and account pages as embedded web views"),
  webview("app-travel-booking", "An airline app rendering a booking page", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 ExampleAir/6.2.0 (iOS)", "Booking flows are frequently web pages inside a native shell"),
  webview("app-news-reader", "A news app opening a linked article", "Mozilla/5.0 (Linux; Android 14; moto g84 5G Build/U1TNS34.82-12-9; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/145.0.7049.100 Mobile Safari/537.36 ExampleNews/8.1.0", "News aggregators open the publisher's page in a WebView"),
  human({
    id: "app-podcast-shownotes",
    title: "A podcast app opening show notes",
    category: "in-app-webview",
    provenance: "The same application that fetches your feed also opens your links, with the same User-Agent",
    notes:
      "The most instructive case in this file, and the corpus caught the expectation being wrong before the library was. Overcast's User-Agent carries the crawler contact convention because the app also fetches feeds — so the library reads a *proven declared bot*, and it is right: that is genuinely what the client software is. There is a person behind this particular request and nothing in it says so. The verdict is about the client, not the intent, and the gap between those two is exactly why a proven verdict tags rather than blocks here.",
    requests: [
      plain("Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Overcast/2025.4 (+http://overcast.fm/; iOS podcast app)", [
        ["Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8"],
        ["Accept-Language", "en-GB,en;q=0.9"],
        ["Accept-Encoding", "gzip, deflate, br"],
      ]),
    ],
    selfDeclared:
      "Overcast sends one User-Agent for both jobs, and it carries the crawler contact convention because the app also fetches feeds. The library reads a proven declaration and is correct about the client; there is simply a person behind this particular request and nothing in it says so.",
    expect: { verdict: "confirmed-bot", certain: true, botClass: "declared-bot" },
    tags: ["known-cost", "known-limit"],
  }),
  human({
    id: "app-kindle-in-book-link",
    title: "Following a footnote link from a Kindle book",
    category: "in-app-webview",
    provenance: "Kindle devices open external links in an embedded Silk-derived browser with a very reduced header set",
    requests: [
      plain("Mozilla/5.0 (Linux; U; Android 11; en-GB; KFTRWI) AppleWebKit/537.36 (KHTML, like Gecko) Silk/128.1.2 like Chrome/128.0.6613.146 Safari/537.36", [
        ["Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"],
        ["Accept-Language", "en-GB"],
        ["Accept-Encoding", "gzip, deflate"],
      ]),
    ],
    expect: { certain: false },
  }),
  human({
    id: "app-car-infotainment",
    title: "A passenger opening a link on a car's infotainment screen",
    category: "in-app-webview",
    provenance: "Android Automotive builds ship a WebView on an old Chromium with an unusual device string",
    notes: "A small population that no signature list will ever cover, on an engine years behind the release channel. The right treatment is the same as for any unfamiliar client: score it, do not deny it.",
    requests: [
      plain("Mozilla/5.0 (Linux; Android 13; Automotive Build/TQ3A.230805.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/119.0.6045.193 Safari/537.36", [
        ["Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8"],
        ["Accept-Language", "de-DE,de;q=0.9,en;q=0.8"],
        ["Accept-Encoding", "gzip, deflate, br"],
      ]),
    ],
    expect: { certain: false },
  }),
  webview("app-email-client", "A mobile mail client opening a newsletter link", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Outlook-iOS/4.2531.0", "Outlook opens links in its own WebView rather than handing off to Safari"),
  webview("app-google-app", "A link tapped in the Google app", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 GSA/354.0.723598878 Mobile/15E148 Safari/604.1", "GSA is the Google Search App's in-app browser and carries a very large share of mobile search traffic"),
  webview("app-android-webview-bare", "A bare Android WebView from an unnamed app", "Mozilla/5.0 (Linux; Android 13; SM-A135F Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/140.0.7028.61 Mobile Safari/537.36", "Any application can embed a WebView and add nothing; only the wv token remains", { cookie: false, notes: "No app name, no cookies, an old Chromium and none of the modern headers. Close to the worst case a real person can present, and still a real person." }),
  webview("app-huawei-quick", "A Huawei Quick App", "Mozilla/5.0 (Linux; Android 12; ELS-NX9; HMSCore 6.14.0.302; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.6478.186 Mobile Safari/537.36 QuickApp/12.0.6", "Huawei's lightweight app format renders web content in a WebView", { language: "zh-CN,zh;q=0.9" }),

  // ---------------------------------------------------------------------------
  // Desktop applications embedding a browser engine.
  // ---------------------------------------------------------------------------
  webview(
    "app-vscode-simple-browser",
    "A developer opening a page in VS Code's Simple Browser",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Code/1.97.2 Chrome/132.0.6834.196 Electron/34.2.0 Safari/537.36",
    "The Electron User-Agent emitted by VS Code webviews",
    { notes: "This exact string was classified as proven automation by a shipped version of this library, because Electron sat in the headless signature set. It then looped on the challenge, because passing one cannot undo a proven verdict. Two bugs, one User-Agent, both found by a person opening the project's own demo." },
  ),
  webview("app-slack-desktop", "Slack's desktop client opening a link internally", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Slack/4.45.69 Chrome/134.0.6998.205 Electron/35.7.5 Safari/537.36", "Electron-based desktop client"),
  webview("app-discord-desktop", "Discord's desktop client", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord/1.0.9200 Chrome/128.0.6613.186 Electron/32.2.7 Safari/537.36", "Electron again; the app name is lowercase here"),
  webview("app-spotify-desktop", "Spotify's desktop client opening a link", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Spotify/1.2.62 Chrome/134.0.6998.205 Electron/35.7.5 Safari/537.36", "A person listening, not the podcast fetcher", { notes: "The reason no signature claims the token `Spotify/`: this is a listener, and `Spotify/1.0` is a feed fetcher. One prefix, two entirely different clients." }),
  webview("app-notion-desktop", "Notion's desktop client", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Notion/4.5.0 Chrome/128.0.6613.186 Electron/32.2.6 Safari/537.36", "Electron-based note application embedding pages"),
  webview("app-figma-desktop", "Figma's desktop client loading an embed", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Figma/125.4.4 Chrome/126.0.6478.234 Electron/31.7.5 Safari/537.36", "Design tools embed live web previews"),
  webview("app-postman-desktop", "Postman's desktop client rendering a documentation page", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Postman/11.30.0 Chrome/128.0.6613.186 Electron/32.2.6 Safari/537.36", "Distinct from PostmanRuntime, which is the request sender", { notes: "PostmanRuntime is automation; Postman the application is a person reading documentation. The two arrive from the same machine within seconds of each other." }),
  webview("app-steam-overlay", "The Steam in-game browser", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.234 Safari/537.36 Valve Steam GameOverlay/1740000000", "Steam's overlay browser opens links without leaving a game"),
  webview("app-office-webview", "A link opened from Microsoft Word", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.6613.186 Safari/537.36 Microsoft Office Word/16.0.18324", "Office applications open links through an embedded browser and announce the host application"),
  webview("app-teams-desktop", "Microsoft Teams' desktop client", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.6613.186 Electron/32.2.6 Safari/537.36 Teams/25.31.0", "Teams renders tabs and link previews in an embedded browser"),
];
