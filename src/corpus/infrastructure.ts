import { browser, plain } from "./headers.js";
import { bot, human } from "./schema.js";
import type { TrafficCase } from "./schema.js";

/**
 * Traffic from the machinery around your application.
 *
 * Load balancer probes, container orchestration health checks, your own mobile app,
 * your own server-side renderer, webhooks arriving from a payment processor, a
 * browser prefetching a page a person has not asked for yet. None of it is a person,
 * almost none of it is unwelcome, and most of it will be classified as automation
 * because that is exactly what it is.
 *
 * The lesson this section is here to teach is that **the answer is usually the
 * allowlist or `ignorePaths`, not a detector**. A health check from your own load
 * balancer should never reach detection at all: it costs work, it inflates every
 * per-actor counter with perfectly regular traffic, and the one thing you must never
 * do is let a bot policy decide whether your orchestrator thinks you are alive.
 */

export const INFRASTRUCTURE_CASES: TrafficCase[] = [
  // ---------------------------------------------------------------------------
  // Probes. These belong in ignorePaths.
  // ---------------------------------------------------------------------------
  bot({
    id: "kubernetes-probe",
    title: "A Kubernetes liveness probe",
    audience: "infrastructure",
    category: "health-probe",
    provenance: "kubelet sends kube-probe/<version> with no Accept-Language and no cookies, on a perfect interval",
    notes:
      "Machine-regular by design, from a fixed address, forever. Put the path in `ignorePaths`: letting a bot policy decide whether your orchestrator believes the pod is healthy is a way to turn a false positive into a restart loop.",
    requests: Array.from({ length: 10 }, (_, index) => ({ ...plain("kube-probe/1.31"), path: "/healthz", atMs: index * 10_000, ip: "10.42.0.1" })),
    expect: { neverAction: ["block", "drop", "redirect"] },
    tags: ["allowlist-candidate"],
  }),
  bot({
    id: "elb-health-checker",
    title: "An AWS load balancer health check",
    audience: "infrastructure",
    category: "health-probe",
    provenance: "ELB-HealthChecker/2.0",
    requests: Array.from({ length: 8 }, (_, index) => ({ ...plain("ELB-HealthChecker/2.0"), path: "/healthz", atMs: index * 15_000, ip: "10.0.3.44" })),
    expect: { neverAction: ["block", "drop", "redirect"] },
    tags: ["allowlist-candidate"],
  }),
  bot({
    id: "prometheus-blackbox",
    title: "A Prometheus blackbox exporter probe",
    audience: "infrastructure",
    category: "health-probe",
    provenance: "Blackbox exporter identifies itself and runs on a scrape interval",
    requests: Array.from({ length: 6 }, (_, index) => ({ ...plain("Prometheus/2.54.1 blackbox_exporter/0.25.0"), path: "/metrics", atMs: index * 30_000, ip: "10.0.9.12" })),
    expect: { neverAction: ["block", "drop", "redirect"] },
    tags: ["allowlist-candidate"],
  }),

  // ---------------------------------------------------------------------------
  // Your own software.
  // ---------------------------------------------------------------------------
  bot({
    id: "first-party-mobile-app",
    title: "Your own iOS app calling your own API",
    audience: "infrastructure",
    category: "first-party-client",
    provenance: "A native app using URLSession identifies itself as the app, not as a browser",
    notes:
      "Automation by every measure the library has, and a paying customer holding a phone. Nothing in a request distinguishes the two — which is what `isHuman` is for: your application knows this session is authenticated, and the library does not.",
    requests: [
      {
        headers: [
          ["Host", "api.shop.example"],
          ["Accept", "application/json"],
          ["Authorization", "Bearer redacted"],
          ["User-Agent", "ShopApp/4.12.0 (com.example.shop; build:4120; iOS 18.5.0) Alamofire/5.9.1"],
          ["Accept-Language", "en-GB;q=1.0"],
          ["Accept-Encoding", "br;q=1.0, gzip;q=0.9, deflate;q=0.8"],
        ],
        path: "/v1/basket",
        protocol: "https",
        httpVersion: "1.1",
      },
    ],
    expect: { neverAction: ["block", "drop", "redirect"] },
    tags: ["allowlist-candidate"],
  }),
  bot({
    id: "server-side-render",
    title: "Your own renderer fetching your own API",
    audience: "infrastructure",
    category: "first-party-client",
    provenance: "A Next.js server component calling an internal endpoint with undici",
    requests: [
      {
        headers: [["Host", "api.shop.example"], ["Accept", "application/json"], ["User-Agent", "undici"], ["Accept-Encoding", "gzip, deflate"]],
        path: "/v1/products",
        protocol: "https",
        httpVersion: "1.1",
        ip: "10.0.5.20",
      },
    ],
    expect: { neverAction: ["block", "drop", "redirect"] },
    tags: ["allowlist-candidate"],
  }),
  bot({
    id: "stripe-webhook",
    title: "A payment webhook arriving from Stripe",
    audience: "infrastructure",
    category: "webhook",
    provenance: "Stripe posts events with its own User-Agent and a signature header",
    notes:
      "Blocking this loses orders silently, and the retry backoff means you find out hours later. Webhook endpoints belong in `ignorePaths` — they authenticate themselves cryptographically and have no use for bot detection.",
    requests: [
      {
        headers: [
          ["Host", "shop.example"],
          ["Accept", "*/*; q=0.5, application/xml"],
          ["Content-Type", "application/json; charset=utf-8"],
          ["Stripe-Signature", "t=1756544400,v1=redacted"],
          ["User-Agent", "Stripe/1.0 (+https://stripe.com/docs/webhooks)"],
        ],
        method: "POST",
        path: "/webhooks/stripe",
        protocol: "https",
        httpVersion: "1.1",
      },
    ],
    expect: { neverAction: ["block", "drop", "redirect"] },
    tags: ["allowlist-candidate"],
  }),
  bot({
    id: "github-webhook",
    title: "A GitHub webhook",
    audience: "infrastructure",
    category: "webhook",
    provenance: "GitHub-Hookshot/<sha>",
    requests: [
      {
        headers: [["Host", "shop.example"], ["User-Agent", "GitHub-Hookshot/f1a2b3c"], ["Content-Type", "application/json"], ["X-GitHub-Event", "push"], ["Accept", "*/*"]],
        method: "POST",
        path: "/webhooks/github",
        protocol: "https",
        httpVersion: "1.1",
      },
    ],
    expect: { neverAction: ["block", "drop", "redirect"] },
    tags: ["allowlist-candidate"],
  }),

  // ---------------------------------------------------------------------------
  // Browser-initiated requests that no person asked for.
  // ---------------------------------------------------------------------------
  human({
    id: "speculation-rules-prefetch",
    title: "A browser prefetching a page the person has not clicked yet",
    category: "browser-initiated",
    provenance: "Speculation Rules mark prefetches with Sec-Purpose: prefetch",
    notes:
      "A real browser, a real person, and a request they never made — issued speculatively while they hover a link. It arrives with no Sec-Fetch-User, because no user gesture triggered it. Reading that absence as evidence would penalise the person for their browser being fast.",
    requests: [
      {
        ...browser("chromeWindows", { kind: "same-origin-navigate", referer: "https://shop.example/products" }),
        headers: [
          ...browser("chromeWindows", { kind: "same-origin-navigate", referer: "https://shop.example/products" }).headers.filter(([name]) => name !== "Sec-Fetch-User"),
          ["Sec-Purpose", "prefetch"],
          ["Purpose", "prefetch"],
        ],
        path: "/products/88",
      },
    ],
    expect: { certain: false, neverAction: ["block", "drop", "redirect"] },
  }),
  human({
    id: "service-worker-fetch",
    title: "A service worker refreshing cached content in the background",
    category: "browser-initiated",
    provenance: "Sec-Fetch-Dest: empty with Sec-Fetch-Mode: cors, issued with no tab in the foreground",
    requests: [{ ...browser("chromeWindows", { kind: "xhr" }), path: "/api/catalog.json" }],
    expect: { verdict: "unknown", maxScore: 20, neverAction: ["block", "drop", "redirect"] },
  }),

  // ---------------------------------------------------------------------------
  // People arriving from address space that looks automated.
  // ---------------------------------------------------------------------------
  human({
    id: "consumer-vpn-exit",
    title: "A person browsing through a consumer VPN",
    category: "datacenter-human",
    provenance: "VPN exit nodes live in hosting-provider address space, which is also where scrapers live",
    notes:
      "A perfect browser request from an address that any datacenter range list will flag. This is why `ip-intelligence` caps datacenter matches at `moderate`: the population using a VPN is overwhelmingly people, and disproportionately people with reasons.",
    requests: [{ ...browser("chromeMac"), ip: "192.0.2.150" }],
    expect: { certain: false, neverAction: ["block", "drop", "redirect"] },
    tags: ["known-cost"],
  }),
  human({
    id: "icloud-private-relay",
    title: "A person on iCloud Private Relay",
    category: "datacenter-human",
    provenance: "Private Relay egresses from Apple's partner networks; the address never belongs to the subscriber",
    requests: [{ ...browser("safariIos"), ip: "192.0.2.151" }],
    expect: { certain: false, neverAction: ["block", "drop", "redirect"] },
    tags: ["known-cost"],
  }),
  human({
    id: "corporate-egress-shared",
    title: "An office of two hundred people behind one address",
    category: "datacenter-human",
    provenance: "A single corporate egress address carrying an entire building's traffic",
    notes: "Rate counting sees one extraordinarily busy actor. It is two hundred ordinary ones.",
    requests: Array.from({ length: 45 }, (_, index) => ({
      ...browser(index % 3 === 0 ? "chromeWindows" : index % 3 === 1 ? "edgeWindows" : "firefoxWindows"),
      path: `/products/${(index % 12) + 1}`,
      ip: "192.0.2.200",
      atMs: index * 180,
    })),
    expect: { certain: false, neverAction: ["block", "drop", "redirect"] },
    tags: ["known-cost"],
  }),

  // ---------------------------------------------------------------------------
  // Forwarding headers. The highest-consequence configuration in the library.
  // ---------------------------------------------------------------------------
  bot({
    id: "xff-spoof-attempt",
    title: "A client prepending a fake hop to X-Forwarded-For",
    audience: "hostile",
    category: "forwarding",
    provenance: "X-Forwarded-For is client-supplied; anyone can prepend an address and choose the identity they are tracked under",
    notes:
      "The corpus cannot assert the resolved address directly, so this case asserts the consequence: the client's chosen address must not let it escape its own classification. A curl request stays a curl request whatever it writes in the header.",
    requests: [
      {
        headers: [["Host", "shop.example"], ["User-Agent", "curl/8.11.1"], ["Accept", "*/*"], ["X-Forwarded-For", "66.249.66.1, 192.0.2.90"]],
        ip: "192.0.2.90",
        protocol: "https",
        httpVersion: "1.1",
      },
    ],
    expect: { verdict: "confirmed-bot", botClass: "http-client", certain: true },
    tags: ["security"],
  }),
];
