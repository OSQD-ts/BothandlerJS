/**
 * Realistic cookie jars.
 *
 * A browser that has been to a commercial site once is carrying a dozen cookies it
 * never asked for, and their *shape* is as characteristic as any header: Google
 * Analytics' `_ga` encodes a client id and a first-seen timestamp, Meta's `_fbp`
 * encodes a version, a subdomain index and a creation time, a TCF consent string is
 * base64 with a version prefix. Automation carries none of this, or carries a single
 * hand-set session cookie and nothing else.
 *
 * The values below are structurally correct and entirely synthetic. They exist so a
 * fixture looks like a request from somebody who has actually used the web, rather
 * than like `Cookie: sid=abc`.
 */

/** Deterministic pseudo-random digits, so a fixture is stable across runs. */
function digits(seed: string, length: number): string {
  let hash = 0x811c9dc5;
  let out = "";
  for (let i = 0; out.length < length; i++) {
    hash ^= seed.charCodeAt(i % seed.length) + i;
    hash = Math.imul(hash, 0x01000193) >>> 0;
    out += String(hash % 1_000_000_000).padStart(9, "0");
  }
  return out.slice(0, length);
}

export interface CookieJarOptions {
  /** Seed for the synthetic identifiers, so two visitors differ. */
  visitor?: string;
  /** Epoch seconds the visitor was first seen. */
  firstSeen?: number;
  /** Epoch seconds of this session's start. */
  sessionStart?: number;
  /** Include Google Analytics 4 cookies. Present on most of the commercial web. */
  analytics?: boolean;
  /** Include Meta's advertising cookies. */
  advertising?: boolean;
  /** Include a consent-management platform's cookies. */
  consent?: boolean;
  /** Include Cloudflare's bot-management cookies, present on a large slice of sites. */
  cloudflare?: boolean;
  /** Include product-analytics and support-widget cookies. */
  productAnalytics?: boolean;
  /** Application cookies: session, cart, CSRF. */
  application?: boolean;
  /** Extra pairs appended verbatim. */
  extra?: readonly (readonly [string, string])[];
}

/**
 * Builds a `Cookie` header value.
 *
 * Order matters a little: browsers send cookies sorted by path length descending and
 * then by creation time, which in practice means the host-wide analytics cookies set
 * on the first visit come before the application cookies set later. Reproducing that
 * ordering is the kind of detail a hand-written fixture never has.
 */
export function cookieJar(options: CookieJarOptions = {}): string {
  const visitor = options.visitor ?? "v1";
  const firstSeen = options.firstSeen ?? 1_753_920_000;
  const sessionStart = options.sessionStart ?? 1_756_544_400;
  const pairs: Array<[string, string]> = [];

  if (options.analytics !== false) {
    const clientId = `GA1.1.${digits(`${visitor}ga`, 10)}.${firstSeen}`;
    pairs.push(["_ga", clientId]);
    // GA4's per-property cookie: session count, engagement flags, session start.
    pairs.push(["_ga_QK7X2ZLM4P", `GS1.1.${sessionStart}.4.1.${sessionStart + 187}.58.0.0`]);
  }
  if (options.advertising === true) {
    pairs.push(["_fbp", `fb.1.${firstSeen}000.${digits(`${visitor}fb`, 10)}`]);
    pairs.push(["_gcl_au", `1.1.${digits(`${visitor}gcl`, 9)}.${firstSeen}`]);
  }
  if (options.consent === true) {
    pairs.push([
      "OptanonConsent",
      `isGpcEnabled=0&datestamp=Sat+Aug+30+2026+09%3A00%3A00+GMT%2B0000&version=202405.1.0&interactionCount=1&groups=C0001%3A1%2CC0002%3A1%2CC0003%3A1%2CC0004%3A0`,
    ]);
    pairs.push(["euconsent-v2", "CQJd8YAQJd8YAAcABBENBhFsAP_gAEPgAAYgKPtV_G__bWlr8X73aftkeY1P9_h77sQxBhfJE-4FzLvW_JwXx2ExNA36tqIKmRIAu3TBIQNlHJDURVCgaogVryDMak2coTNKJ6BkiFMRO2dYCF5vmwtj-QKY5vr991dx2B-t7dr83dzyy4hHn3a5_2a0WJCdA5-tDfv9bROb-9IOd_x8v4v8_F_rE2_eT1l_tWvp7D9-cts7_XW89_fff_9Pn_-uB_-_3_vAAA"],
    );
  }
  if (options.cloudflare === true) {
    pairs.push(["__cf_bm", `${digits(`${visitor}cf`, 22)}.${sessionStart}-1.0.1.1-${digits(`${visitor}cfb`, 40)}`]);
    pairs.push(["cf_clearance", `${digits(`${visitor}cfc`, 32)}-${sessionStart}-1.2.1.1-${digits(`${visitor}cfd`, 48)}`]);
  }
  if (options.productAnalytics === true) {
    pairs.push(["_hjSessionUser_3184920", `eyJpZCI6IjQ0NmE${digits(`${visitor}hj`, 8)}IiwiY3JlYXRlZCI6MTc1MzkyMDAwMH0=`]);
    pairs.push(["intercom-id-jf7q2wnx", `d8${digits(`${visitor}ic`, 6)}-4a1c-9e0b-${digits(`${visitor}ic2`, 12)}`]);
  }
  if (options.application !== false) {
    pairs.push(["sid", `s%3A${digits(`${visitor}sid`, 24)}.${digits(`${visitor}sig`, 26)}`]);
    pairs.push(["csrftoken", digits(`${visitor}csrf`, 32)]);
  }
  for (const [name, value] of options.extra ?? []) pairs.push([name, value]);

  return pairs.map(([name, value]) => `${name}=${value}`).join("; ");
}

/** A first-time visitor: no analytics history, only whatever this page set. */
export function freshVisitorJar(visitor = "new"): string {
  return cookieJar({ visitor, analytics: false, application: true });
}

/** A returning customer of a commercial site — the fullest jar in ordinary use. */
export function returningCustomerJar(visitor = "returning"): string {
  return cookieJar({
    visitor,
    analytics: true,
    advertising: true,
    consent: true,
    cloudflare: true,
    productAnalytics: true,
    application: true,
    extra: [
      ["cart", `${digits(`${visitor}cart`, 8)}%3A3items`],
      ["locale", "en-GB"],
      ["currency", "GBP"],
    ],
  });
}
