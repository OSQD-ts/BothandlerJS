import { browser, plain } from "./headers.js";
import { returningCustomerJar } from "./cookies.js";
import { bot, human } from "./schema.js";
import type { Header } from "./headers.js";
import type { TrafficCase } from "./schema.js";

/**
 * The machinery between the client and the origin.
 *
 * CDNs revalidating a cached object, edge functions calling back, API gateways
 * forwarding, service meshes probing, mirrors of your own content. None of it is a
 * person and almost none of it is unwelcome, and the recurring lesson is the same:
 * **the answer is usually `ignorePaths` or the allowlist, not a detector.**
 *
 * This section also carries the cases that matter most for getting the client address
 * right, because everything here adds a forwarding header. `X-Forwarded-For` is
 * client-supplied; trusting it without knowing your topology hands the choice of
 * identity to whoever is sending.
 */

function edge(id: string, title: string, userAgent: string, provenance: string, extra: readonly Header[] = [], options: { notes?: string; certain?: boolean } = {}): TrafficCase {
  return bot({
    id,
    title,
    audience: "infrastructure",
    category: "edge-infrastructure",
    provenance,
    ...(options.notes !== undefined ? { notes: options.notes } : {}),
    requests: [plain(userAgent, [["Accept-Encoding", "gzip, br"], ...extra])],
    expect: { neverAction: ["block", "drop", "redirect"] },
    tags: ["allowlist-candidate"],
  });
}

export const CDN_GATEWAY_CASES: TrafficCase[] = [
  // ---------------------------------------------------------------------------
  // CDN and edge fetchers pulling from origin.
  // ---------------------------------------------------------------------------
  edge("edge-cloudflare-origin", "Cloudflare fetching from origin", "Mozilla/5.0 (compatible; Cloudflare-Traffic-Manager/1.0; +https://www.cloudflare.com/bot)", "A CDN revalidating a cached object presents its own identity to the origin", [["CF-Connecting-IP", "203.0.113.88"], ["CF-Ray", "8f2a1c7d4e9b3210-LHR"], ["CF-IPCountry", "GB"], ["X-Forwarded-For", "203.0.113.88"], ["X-Forwarded-Proto", "https"]], { notes: "The real client address arrives in CF-Connecting-IP, which only Cloudflare can set. Reading X-Forwarded-For here instead would take whatever the client wrote." }),
  edge("edge-fastly-shield", "Fastly shield-tier fetch", "Mozilla/5.0 (compatible; Fastly/1.0)", "A shield POP consolidating requests before they reach origin", [["Fastly-Client-IP", "198.51.100.44"], ["X-Forwarded-For", "198.51.100.44, 151.101.1.1"], ["Fastly-FF", "a1b2c3"], ["X-Varnish", "912837465"]]),
  edge("edge-akamai", "Akamai edge fetch", "Mozilla/5.0 (compatible; Akamai/1.0)", "Akamai forwards the client address in True-Client-IP", [["True-Client-IP", "192.0.2.77"], ["X-Forwarded-For", "192.0.2.77"], ["Akamai-Origin-Hop", "2"], ["Via", "1.1 v1-akamaitech.net(ghost) (AkamaiGHost)"]]),
  edge("edge-cloudfront", "CloudFront origin request", "Amazon CloudFront", "CloudFront identifies itself with a bare product name and adds its own viewer headers", [["X-Amz-Cf-Id", "K3sLmN9pQrStUvWxYz01234567890AbCdEfGhIjKlMnOpQrSt=="], ["CloudFront-Viewer-Country", "DE"], ["CloudFront-Is-Mobile-Viewer", "false"], ["X-Forwarded-For", "198.51.100.9"], ["Via", "2.0 a1b2c3d4.cloudfront.net (CloudFront)"]], { certain: false }),
  edge("edge-bunny", "Bunny CDN origin pull", "Mozilla/5.0 (compatible; BunnyCDN/1.0)", "A smaller CDN pulling an uncached object", [["X-Forwarded-For", "203.0.113.5"], ["CDN-PullZone", "184920"], ["CDN-RequestCountryCode", "PL"]]),
  edge("edge-vercel", "Vercel edge function calling back to the API", "Vercel Edge Functions", "A serverless edge runtime invoking an origin route", [["X-Vercel-Id", "lhr1::iad1::abcde-1756544400123-1a2b3c4d5e6f"], ["X-Vercel-IP-Country", "GB"], ["X-Forwarded-For", "203.0.113.201"]], { certain: false }),
  edge("edge-cloudflare-worker", "A Cloudflare Worker subrequest", "Mozilla/5.0 (compatible; Cloudflare-Workers/1.0)", "Workers make subrequests that arrive at origin with their own identity", [["CF-Worker", "shop.example"], ["X-Forwarded-For", "203.0.113.14"]]),

  // ---------------------------------------------------------------------------
  // Gateways, meshes and load balancers.
  // ---------------------------------------------------------------------------
  edge("edge-aws-alb-health", "An ALB health check", "ELB-HealthChecker/2.0", "The load balancer deciding whether this target is in service", [["Connection", "close"]], { notes: "Perfectly regular, from a fixed private address, forever. Letting a bot policy decide whether the load balancer believes you are healthy is how a false positive becomes a rolling restart." }),
  edge("edge-gcp-health", "A Google Cloud health check", "GoogleHC/1.0", "The equivalent on Google Cloud load balancing", []),
  edge("edge-azure-probe", "An Azure Front Door probe", "Edge Health Probe", "Azure Front Door probing origin health from every edge location it serves from", []),
  edge("edge-envoy-mesh", "An Envoy sidecar forwarding within a service mesh", "Envoy/HC", "Service-mesh health checking between sidecars", [["X-Envoy-Internal", "true"], ["X-Request-Id", "0b4d1c8a-3f2e-4a91-b7c6-52e0d8f19a3b"], ["X-Envoy-Expected-Rq-Timeout-Ms", "15000"]], { certain: false }),
  edge("edge-istio-probe", "An Istio readiness probe", "kube-probe/1.32", "Kubernetes probing the sidecar rather than the application", []),
  edge("edge-nginx-upstream", "An nginx reverse proxy forwarding a browser request", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36", "The proxy passes the client's User-Agent through and adds forwarding headers of its own", [["X-Real-IP", "203.0.113.130"], ["X-Forwarded-For", "203.0.113.130"], ["X-Forwarded-Proto", "https"], ["X-Forwarded-Host", "shop.example"]], { certain: false, notes: "The User-Agent belongs to a person; the connection belongs to the proxy. Getting the address wrong here mislabels a real customer as the proxy, or the proxy as a customer." }),
  edge("edge-haproxy-forward", "HAProxy forwarding with a Forwarded header", "curl/8.12.1", "The standardised Forwarded header from RFC 7239, still much rarer than X-Forwarded-For", [["Forwarded", "for=192.0.2.60;proto=https;by=203.0.113.43"], ["X-Forwarded-For", "192.0.2.60"]], { certain: false }),
  edge("edge-api-gateway", "An API gateway forwarding an authenticated call", "AmazonAPIGateway_a1b2c3d4e5", "API Gateway rewrites the request entirely before it reaches the integration", [["X-Amzn-Trace-Id", "Root=1-68b2a1c0-1a2b3c4d5e6f708192a3b4c5"], ["X-Forwarded-For", "198.51.100.120"], ["X-Forwarded-Port", "443"]], { certain: false }),
  edge("edge-kong", "Kong forwarding upstream", "Kong/3.9.0", "An API gateway adding its own trace headers", [["X-Kong-Request-Id", "9f8e7d6c5b4a39281706"], ["X-Forwarded-For", "203.0.113.66"]], { certain: false }),

  // ---------------------------------------------------------------------------
  // Address resolution: the highest-consequence configuration in the library.
  // ---------------------------------------------------------------------------
  human({
    id: "edge-person-behind-two-proxies",
    title: "A person behind a CDN and a reverse proxy",
    category: "forwarding",
    provenance: "Two hops: the CDN appends the client, the reverse proxy appends the CDN. Reading the wrong entry mislabels a customer.",
    notes:
      "The chain is client, then CDN, then proxy. With `trustedProxies` configured the walk stops at the first address that is not yours, which is the customer. With a hop count that is wrong by one it stops at the CDN, and every customer behind that CDN becomes one actor.",
    requests: [
      {
        ...browser("chromeWindows", { cookie: returningCustomerJar("proxied"), kind: "same-origin-navigate", referer: "https://shop.example/" }),
        headers: [
          ...browser("chromeWindows", { cookie: returningCustomerJar("proxied"), kind: "same-origin-navigate", referer: "https://shop.example/" }).headers,
          ["X-Forwarded-For", "203.0.113.210, 198.51.100.1, 10.0.0.7"],
          ["X-Forwarded-Proto", "https"],
          ["Via", "1.1 cdn-edge (squid/6.6), 1.1 lb-01"],
        ],
        path: "/products/91",
      },
    ],
    expect: { certain: false },
  }),
  bot({
    id: "edge-xff-header-injection",
    title: "A client writing a forged chain into X-Forwarded-For",
    audience: "hostile",
    category: "forwarding",
    provenance: "Prepending entries is free; the header is whatever the sender types",
    notes:
      "Whatever it writes, it is still a bare library client and is classified as one. Address spoofing changes which *actor* the request is attributed to, not what the request is — which is why the classification and the actor key are separate concerns.",
    requests: [
      {
        headers: [["Host", "shop.example"], ["User-Agent", "curl/8.12.1"], ["Accept", "*/*"], ["X-Forwarded-For", "66.249.66.1, 8.8.8.8, 1.1.1.1"], ["X-Real-IP", "66.249.66.1"], ["True-Client-IP", "66.249.66.1"], ["CF-Connecting-IP", "66.249.66.1"]],
        ip: "192.0.2.222",
        protocol: "https",
        httpVersion: "1.1",
      },
    ],
    expect: { verdict: "confirmed-bot", botClass: "http-client", certain: true },
    tags: ["security"],
  }),

  // ---------------------------------------------------------------------------
  // Mirrors, caches and other people's infrastructure carrying your content.
  // ---------------------------------------------------------------------------
  edge("edge-google-amp", "Google AMP cache fetching a page", "Mozilla/5.0 (compatible; Google-AMPHTML; +http://www.google.com/bot.html)", "The AMP cache re-serves your page from Google's infrastructure"),
  edge("edge-cloudflare-alwaysonline", "Cloudflare Always Online archiving a page", "Mozilla/5.0 (compatible; CloudflareAlwaysOnline/1.0; +http://www.cloudflare.com/always-online) AppleWebKit/534.34", "Cloudflare snapshots pages so it can serve them while your origin is down"),
  edge("edge-wordpress-jetpack", "Jetpack fetching from a WordPress site", "Jetpack by WordPress.com", "Jetpack proxies images and stats through WordPress.com infrastructure", [], { certain: false }),
  edge("edge-imgproxy", "An image proxy fetching a source image", "imgproxy/3.27.2", "Image proxies fetch originals and re-encode them", [], { certain: false }),
  edge("edge-wayback-replay", "The Wayback Machine replaying an archived page", "Mozilla/5.0 (compatible; archive.org_bot; +http://archive.org/details/archive.org_bot)", "Replay fetches missing subresources live from the origin"),
  edge("edge-rss-proxy", "A feed proxy normalising a feed", "Mozilla/5.0 (compatible; FeedBurner/1.0; +https://feedburner.google.com)", "Feed proxies fetch once and fan out to many subscribers"),
];
