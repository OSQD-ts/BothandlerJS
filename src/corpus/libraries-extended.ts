import { bot } from "./schema.js";
import type { Header } from "./headers.js";
import type { CaseRequest, TrafficCase } from "./schema.js";

/**
 * HTTP clients across every ecosystem that shows up in a server log.
 *
 * Each entry reproduces the client's **default header set in its default order**,
 * because that order is a fingerprint in its own right and the differences between
 * these libraries are the whole point: `requests` sends `Accept-Encoding` before
 * `Accept`; Go sends no `Accept` at all; `urllib` puts `Host` second; OkHttp sends
 * `Connection` before `Accept-Encoding`. No browser does any of those things.
 *
 * None of this is evidence of hostility. It is evidence that nobody is looking at the
 * response — a narrower and much safer claim, and one that is usually about somebody's
 * own integration. The right treatment is an allowlist entry or a challenge, not a
 * block.
 */

function client(
  id: string,
  title: string,
  headers: readonly Header[],
  provenance: string,
  options: { identity?: string; certain?: boolean; automation?: boolean; suspectedOnly?: boolean; botClass?: "http-client" | "declared-bot"; notes?: string; path?: string; method?: string; audience?: TrafficCase["audience"] } = {},
): TrafficCase {
  const request: CaseRequest = {
    headers: [["Host", "shop.example"], ...headers],
    protocol: "https",
    httpVersion: "1.1",
    ...(options.path !== undefined ? { path: options.path } : {}),
    ...(options.method !== undefined ? { method: options.method } : {}),
  };
  return bot({
    id,
    title,
    audience: options.audience ?? "unwanted-bot",
    category: "http-library",
    provenance,
    ...(options.notes !== undefined ? { notes: options.notes } : {}),
    requests: [request],
    expect: options.automation === true
      ? { verdict: "confirmed-bot", botClass: "automation", certain: true }
      : options.suspectedOnly === true
        ? { verdict: "suspected-bot", botClass: "http-client", certain: false, detectors: ["self-identified"] }
        : options.certain === false
        ? { certain: false, botClass: ["http-client", "unknown"] }
        : {
            verdict: "confirmed-bot",
            botClass: options.botClass ?? "http-client",
            certain: true,
            ...(options.identity !== undefined ? { identity: options.identity } : {}),
            detectors: ["self-identified"],
          },
  });
}

export const EXTENDED_LIBRARY_CASES: TrafficCase[] = [
  // ---- Python ----
  client("lib-requests-session", "requests with a Session and keep-alive", [["User-Agent", "python-requests/2.32.4"], ["Accept-Encoding", "gzip, deflate, zstd"], ["Accept", "*/*"], ["Connection", "keep-alive"]], "requests 2.32 added zstd to its default Accept-Encoding", { identity: "python" }),
  client("lib-requests-json-post", "requests posting JSON", [["User-Agent", "python-requests/2.32.4"], ["Accept-Encoding", "gzip, deflate"], ["Accept", "*/*"], ["Connection", "keep-alive"], ["Content-Type", "application/json"], ["Content-Length", "142"]], "The shape of a scripted API call", { identity: "python", method: "POST", path: "/api/v1/orders" }),
  client("lib-httpx-async", "httpx in async mode", [["Accept", "*/*"], ["Accept-Encoding", "gzip, deflate, br, zstd"], ["Connection", "keep-alive"], ["User-Agent", "python-httpx/0.28.1"]], "httpx sorts its defaults differently from requests and sends User-Agent last", { identity: "python" }),
  client("lib-aiohttp-client", "aiohttp", [["Accept", "*/*"], ["Accept-Encoding", "gzip, deflate"], ["User-Agent", "Python/3.13 aiohttp/3.11.11"]], "aiohttp names the interpreter version ahead of its own", { identity: "python" }),
  client("lib-urllib3-direct", "urllib3 used directly", [["User-Agent", "python-urllib3/2.3.0"], ["Accept-Encoding", "identity"]], "urllib3 below requests sends a bare identity encoding", { identity: "python" }),
  client("lib-python-urllib", "the standard library's urllib", [["Accept-Encoding", "identity"], ["User-Agent", "Python-urllib/3.13"], ["Connection", "close"]], "urllib emits Accept-Encoding before Host and sends no Accept at all", { identity: "python" }),
  client("lib-scrapy-crawler", "Scrapy", [["User-Agent", "Scrapy/2.12.0 (+https://scrapy.org)"], ["Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"], ["Accept-Language", "en"], ["Accept-Encoding", "gzip, deflate"]], "Scrapy's default crawler headers; it names a contact URL like a polite crawler", { identity: "python" }),
  client("lib-selenium-wire", "selenium-wire's underlying client", [["User-Agent", "python-requests/2.32.4"], ["Accept-Encoding", "gzip, deflate"], ["Accept", "*/*"], ["X-Selenium-Wire", "1"]], "Instrumented Selenium proxies leak their own headers", { identity: "python" }),
  client("lib-mechanicalsoup", "MechanicalSoup", [["User-Agent", "python-requests/2.32.4"], ["Accept-Encoding", "gzip, deflate"], ["Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"], ["Connection", "keep-alive"]], "A form-filling wrapper over requests, used for scripted logins", { identity: "python" }),

  // ---- JavaScript and TypeScript ----
  client("lib-undici-fetch", "Node's built-in fetch", [["Accept", "*/*"], ["Accept-Language", "*"], ["Sec-Fetch-Mode", "cors"], ["User-Agent", "node"], ["Accept-Encoding", "gzip, deflate"]], "Node's global fetch is undici; it sends a bare 'node' User-Agent and an Accept-Language of *", { certain: false, notes: "Two characters of User-Agent. Undici also sends Sec-Fetch-Mode, which is unusual for a non-browser and shows that Fetch Metadata alone does not imply a browser." }),
  client("lib-node-fetch-v3", "node-fetch v3", [["Accept", "*/*"], ["User-Agent", "node-fetch"], ["Accept-Encoding", "gzip,deflate,br"], ["Connection", "close"]], "node-fetch v3 dropped the URL from its default User-Agent", { identity: "node" }),
  client("lib-axios-node", "axios in Node", [["Accept", "application/json, text/plain, */*"], ["User-Agent", "axios/1.8.4"], ["Accept-Encoding", "gzip, compress, deflate, br"]], "axios in Node; in a browser it cannot set User-Agent at all", { identity: "node" }),
  client("lib-got", "got", [["User-Agent", "got (https://github.com/sindresorhus/got)"], ["Accept-Encoding", "gzip, deflate, br"]], "got names its repository in the User-Agent", { identity: "node" }),
  client("lib-superagent", "superagent", [["User-Agent", "superagent/9.0.2"], ["Accept-Encoding", "gzip, deflate"]], "A long-lived Node client still common in older services", { identity: "node" }),
  client("lib-puppeteer-fetch", "Puppeteer's page.goto with an overridden UA", [["User-Agent", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/152.0.0.0 Safari/537.36"], ["Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"], ["Accept-Encoding", "gzip, deflate, br"], ["Accept-Language", "en-US"]], "Puppeteer leaves HeadlessChrome in the UA unless told otherwise", { audience: "unwanted-bot", automation: true, identity: "headless-chrome" }),
  client("lib-deno-fetch", "Deno's fetch", [["Accept", "*/*"], ["Accept-Encoding", "gzip, br"], ["User-Agent", "Deno/2.1.9"], ["Accept-Language", "*"]], "Deno identifies its runtime and version", { identity: "node" }),
  client("lib-bun-fetch", "Bun's fetch", [["Accept", "*/*"], ["Accept-Encoding", "gzip, deflate, br"], ["User-Agent", "Bun/1.2.4"], ["Connection", "keep-alive"]], "Bun identifies its runtime and version", { identity: "node" }),

  // ---- JVM ----
  client("lib-okhttp-android", "OkHttp from an Android app", [["User-Agent", "okhttp/4.12.0"], ["Connection", "Keep-Alive"], ["Accept-Encoding", "gzip"]], "The default client behind most Android apps; Connection precedes Accept-Encoding", { identity: "java" }),
  client("lib-retrofit", "Retrofit over OkHttp", [["Accept", "application/json"], ["User-Agent", "okhttp/4.12.0"], ["Connection", "Keep-Alive"], ["Accept-Encoding", "gzip"]], "Retrofit adds an Accept and leaves OkHttp's own headers in place", { identity: "java" }),
  client("lib-jdk-httpclient", "The JDK HttpClient", [["User-Agent", "Java-http-client/21.0.6"], ["Connection", "Upgrade, HTTP2-Settings"], ["Upgrade", "h2c"], ["HTTP2-Settings", "AAEAAEAAAAIAAAABAAMAAABkAAQBAAAAAAUAAEAA"]], "The JDK client attempts an h2c upgrade over cleartext, which browsers never do", { identity: "java" }),
  client("lib-apache-httpclient5", "Apache HttpClient 5", [["User-Agent", "Apache-HttpClient/5.4.1 (Java/21.0.6)"], ["Accept-Encoding", "gzip, x-gzip, deflate"], ["Connection", "keep-alive"]], "Ubiquitous in JVM services; note the x-gzip alias no browser sends", { identity: "java" }),
  client("lib-spring-webclient", "Spring WebClient over Reactor Netty", [["User-Agent", "ReactorNetty/1.2.2"], ["Accept", "application/json"], ["Accept-Encoding", "gzip"]], "The reactive stack in most modern Spring services", { certain: false }),
  client("lib-ktor", "Ktor's client", [["Accept", "*/*"], ["Accept-Charset", "UTF-8"], ["User-Agent", "ktor-client"], ["Accept-Encoding", "gzip,deflate,identity"]], "Ktor still sends Accept-Charset, which browsers dropped over a decade ago", { identity: "java", notes: "Accept-Charset is a genuine period marker: no browser has sent it since 2014." }),
  client("lib-jsoup", "jsoup fetching a page to parse", [["User-Agent", "Mozilla/5.0 (jsoup)"], ["Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"], ["Accept-Encoding", "gzip"]], "jsoup wears a Mozilla preamble it did not earn", { identity: "java", notes: "A Mozilla preamble with `(jsoup)` where the platform block belongs. The preamble buys nothing: the product token names the library, and that is what is read." }),

  // ---- Go, Rust, and systems languages ----
  client("lib-go-nethttp", "Go's net/http", [["User-Agent", "Go-http-client/2.0"], ["Accept-Encoding", "gzip"]], "Go sends only a User-Agent and Accept-Encoding by default — no Accept at all", { identity: "go" }),
  client("lib-go-resty", "Go with resty", [["User-Agent", "go-resty/2.16.5 (https://github.com/go-resty/resty)"], ["Accept-Encoding", "gzip"]], "resty names its repository", { identity: "go" }),
  client("lib-rust-reqwest", "Rust's reqwest", [["Accept", "*/*"], ["User-Agent", "reqwest/0.12.12"], ["Accept-Encoding", "gzip, br, zstd, deflate"]], "reqwest advertises four encodings including zstd", { identity: "rust" }),
  client("lib-rust-ureq", "Rust's ureq", [["User-Agent", "ureq/3.0.5"], ["Accept", "*/*"], ["Accept-Encoding", "gzip"]], "A blocking Rust client common in CLI tools", { identity: "rust" }),
  client("lib-curl-cli", "curl from a shell", [["User-Agent", "curl/8.12.1"], ["Accept", "*/*"]], "curl sends exactly three headers by default and no Accept-Encoding unless asked", { identity: "curl" }),
  client("lib-curl-compressed", "curl --compressed", [["User-Agent", "curl/8.12.1"], ["Accept", "*/*"], ["Accept-Encoding", "deflate, gzip, br, zstd"]], "The --compressed flag adds every encoding libcurl was built with", { identity: "curl" }),
  client("lib-wget", "Wget", [["User-Agent", "Wget/1.25.0"], ["Accept", "*/*"], ["Accept-Encoding", "identity"], ["Connection", "Keep-Alive"]], "Wget defaults to identity encoding", { identity: "wget" }),
  client("lib-wget2", "Wget2", [["User-Agent", "Wget/2.2.0"], ["Accept-Encoding", "gzip, br, zstd, lzip, deflate"], ["Accept", "*/*"], ["Connection", "keep-alive"]], "Wget2 advertises encodings no browser supports, including lzip", { identity: "wget" }),
  client("lib-aria2", "aria2 download manager", [["User-Agent", "aria2/1.37.0"], ["Accept", "*/*"], ["Accept-Encoding", "deflate, gzip"], ["Connection", "close"], ["Range", "bytes=0-1048575"]], "aria2 segments downloads with parallel Range requests", { identity: "misc-cli", path: "/downloads/catalogue.pdf" }),

  // ---- PHP, Ruby, Perl, .NET ----
  client("lib-guzzle", "Guzzle", [["User-Agent", "GuzzleHttp/7.9.2 curl/8.12.1 PHP/8.4.3"], ["Accept", "*/*"]], "Guzzle names itself, libcurl and PHP in one string", { identity: "php" }),
  client("lib-php-file-get-contents", "PHP's file_get_contents", [["User-Agent", "PHP/8.4.3"], ["Accept", "*/*"], ["Connection", "close"]], "The default stream wrapper sends the bare interpreter version", { identity: "php" }),
  client("lib-wordpress-pingback", "A WordPress pingback", [["User-Agent", "WordPress/6.8.1; https://blog.example"], ["Accept", "*/*"], ["Accept-Encoding", "deflate;q=1.0, compress;q=0.5, gzip;q=0.5"], ["Content-Type", "application/x-www-form-urlencoded"]], "WordPress names the calling site in its User-Agent, which makes it traceable", { identity: "php", method: "POST", path: "/xmlrpc.php", notes: "Honest automation from somebody else's blog. A block here breaks a pingback, not an attack." }),
  client("lib-drupal-http", "Drupal's HTTP client", [["User-Agent", "Drupal/11.1 (+https://www.drupal.org/)"], ["Accept", "*/*"], ["Accept-Encoding", "gzip"]], "Drupal names its project URL", { identity: "php" }),
  client("lib-ruby-faraday", "Ruby with Faraday", [["User-Agent", "Faraday v2.12.2"], ["Accept-Encoding", "gzip;q=1.0,deflate;q=0.6,identity;q=0.3"], ["Accept", "*/*"]], "Faraday's quality-weighted encoding list is distinctive", { identity: "ruby" }),
  client("lib-ruby-nethttp", "Ruby's Net::HTTP", [["Accept-Encoding", "gzip;q=1.0,deflate;q=0.6,identity;q=0.3"], ["Accept", "*/*"], ["User-Agent", "Ruby"], ["Connection", "close"]], "The standard library sends a User-Agent of exactly 'Ruby'", { suspectedOnly: true, notes: "Four characters. No signature matches it — a token of 'ruby' would match any string containing the word — so it is caught by shape alone, as a bare product token no browser emits. Strong, not proven, and that is the right answer." }),
  client("lib-httprb-mastodon", "http.rb, as used by Mastodon", [["User-Agent", "http.rb/5.2.0 (Mastodon/4.3.4; +https://mastodon.example/)"], ["Accept", "application/activity+json, application/ld+json"], ["Accept-Encoding", "gzip"]], "Fediverse servers fetch on their users' behalf and name both the library and the instance", { audience: "benign-bot", identity: "mastodon", botClass: "declared-bot", notes: "One shared link can arrive from hundreds of instances at once, each a separate server acting for a real reader. Identified as Mastodon rather than as a Ruby client: the more specific claim is the more useful one for writing a rule." }),
  client("lib-dotnet-httpclient", ".NET HttpClient", [["User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) HttpClient/9.0"], ["Accept-Encoding", "gzip, deflate, br"], ["Connection", "keep-alive"]], "Even library clients sometimes wear a Mozilla preamble", { identity: "dotnet" }),
  client("lib-restsharp", "RestSharp", [["User-Agent", "RestSharp/112.1.0"], ["Accept", "application/json, text/json, text/x-json, text/javascript, application/xml, text/xml"], ["Accept-Encoding", "gzip, deflate"]], "RestSharp's Accept list is long and unmistakably not a browser's", { identity: "dotnet" }),
  client("lib-powershell-invoke", "PowerShell's Invoke-WebRequest", [["User-Agent", "Mozilla/5.0 (Windows NT 10.0; Microsoft Windows 10.0.26100; en-GB) PowerShell/7.5.0"], ["Accept-Encoding", "gzip, deflate, br"]], "PowerShell names the exact Windows build and the shell version", { identity: "shell", notes: "A Mozilla preamble again, beside a product token no browser emits. Invoke-WebRequest is a deployment script far more often than it is an attack." }),
  client("lib-libwww-perl", "Perl's LWP", [["User-Agent", "libwww-perl/6.78"], ["TE", "deflate,gzip;q=0.3"]], "One of the oldest scripted clients still in circulation", { identity: "perl" }),

  // ---- CLI tools people use by hand ----
  client("lib-httpie", "HTTPie", [["User-Agent", "HTTPie/3.2.4"], ["Accept-Encoding", "gzip, deflate"], ["Accept", "*/*"], ["Connection", "keep-alive"]], "A command-line client aimed at people rather than at scripts", { identity: "misc-cli", notes: "Automation by shape, a developer by intent. Worth remembering when choosing an action." }),
  client("lib-postman", "Postman", [["User-Agent", "PostmanRuntime/7.43.0"], ["Accept", "*/*"], ["Cache-Control", "no-cache"], ["Postman-Token", "0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9"], ["Accept-Encoding", "gzip, deflate, br"], ["Connection", "keep-alive"]], "Postman adds a per-request token header of its own", { identity: "misc-cli" }),
  client("lib-insomnia", "Insomnia", [["User-Agent", "insomnia/10.3.0"], ["Accept", "*/*"], ["Accept-Encoding", "gzip, deflate, br"]], "An API client, a person clicking Send", { identity: "misc-cli" }),
  client("lib-xh", "xh", [["User-Agent", "xh/0.23.1"], ["Accept", "*/*"], ["Accept-Encoding", "gzip, deflate, br, zstd"], ["Connection", "keep-alive"]], "A Rust reimplementation of HTTPie", { certain: false }),
  client("lib-k6-load-test", "A k6 load test", [["User-Agent", "k6/0.56.0 (https://k6.io/)"], ["Accept", "*/*"], ["Accept-Encoding", "gzip"]], "Load generators identify themselves; usually this is your own test running against your own site", { identity: "k6", audience: "infrastructure", notes: "k6 is a named signature, and deliberately a `library` one rather than a `monitoring` one: monitoring is a benign category and benign categories are allowed by default, which is the wrong default for a tool whose purpose is generating load. Allowlist the load generator addresses before a test rather than discovering mid-run that the bot policy is what you measured." }),
  client("lib-vegeta", "A Vegeta load test", [["User-Agent", "Go-http-client/2.0"], ["Accept-Encoding", "gzip"], ["X-Vegeta-Attack", "1"]], "Vegeta is built on Go's client and inherits its header set", { identity: "go", audience: "infrastructure" }),
  client("lib-ab-benchmark", "ApacheBench", [["User-Agent", "ApacheBench/2.3"], ["Accept", "*/*"]], "The oldest load tool still in daily use", { suspectedOnly: true, audience: "infrastructure" }),
];
