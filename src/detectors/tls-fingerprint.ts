import type { Detector, DetectionContext } from "./types.js";
import type { Evidence } from "../types.js";

/** What a given TLS fingerprint is known to belong to. */
export interface FingerprintProfile {
  /** Human-readable client name, e.g. `"Chrome 122 (macOS)"`. */
  label: string;
  /** Rendering engine this fingerprint belongs to, matched against the parsed UA. */
  engine?: "blink" | "gecko" | "webkit" | undefined;
  /** True when the fingerprint belongs to a tool rather than a browser. */
  automated?: boolean | undefined;
}

export interface TlsFingerprintOptions {
  /** Fingerprint (JA3/JA4) to profile. Supply your own; none ships with this library. */
  profiles?: ReadonlyMap<string, FingerprintProfile>;
}

/**
 * Compares the TLS handshake fingerprint against the client the User-Agent claims.
 *
 * This is the signal that survives a scraper copying your browser's headers
 * perfectly, because the fingerprint is produced by the TLS library before a single
 * HTTP byte is sent. A Go program presenting Chrome's User-Agent still has Go's
 * ClientHello, and the mismatch is visible.
 *
 * Node cannot compute this — the ClientHello is consumed by the TLS layer before any
 * JavaScript runs — so the fingerprint must come from your edge: nginx with a JA3
 * module, HAProxy, Cloudflare's `cf-ja3-hash`, or an ALB with the right attributes
 * forwarded. Point `tlsFingerprintHeader` at whichever header carries it.
 *
 * It stops at `strong` for two reasons. Fingerprints collide across clients that
 * share a TLS library, so a match is weaker evidence than it looks. And they churn
 * with every browser release, so a profile table is out of date the moment you stop
 * updating it — a stale table produces mismatches for people running a browser newer
 * than your data, which is the worst possible failure mode.
 */
export function tlsFingerprintDetector(options: TlsFingerprintOptions = {}): Detector {
  const profiles = options.profiles ?? new Map<string, FingerprintProfile>();

  return {
    id: "tls-fingerprint",
    description: "Compares an edge-supplied JA3/JA4 handshake fingerprint against the claimed client",
    cost: "cheap",
    stage: "always",

    inspect(ctx: DetectionContext): Evidence | undefined {
      const fingerprint = ctx.facts.tlsFingerprint;
      if (fingerprint === undefined || profiles.size === 0) return undefined;

      const profile = profiles.get(fingerprint);
      // An unrecognised fingerprint means our table is incomplete, which is a fact
      // about us and not about the client. Silence is the only honest response.
      if (profile === undefined) return undefined;

      if (profile.automated === true) {
        return {
          detector: "tls-fingerprint",
          summary: `TLS handshake matches ${profile.label}, a non-browser client`,
          direction: "bot",
          certainty: "strong",
          weight: 0.7,
          botClass: "http-client",
          metadata: { fingerprint, profile: profile.label },
        };
      }

      if (profile.engine !== undefined && ctx.ua.engine !== undefined && profile.engine !== ctx.ua.engine) {
        return {
          detector: "tls-fingerprint",
          summary: `TLS handshake is ${profile.label} (${profile.engine}) but the User-Agent claims ${ctx.ua.engine}`,
          direction: "bot",
          certainty: "strong",
          weight: 0.75,
          botClass: "impersonator",
          metadata: { fingerprint, profile: profile.label, handshakeEngine: profile.engine, claimedEngine: ctx.ua.engine },
        };
      }

      // Fingerprint and claim agree. Real corroboration, and one of the few pieces of
      // human-pointing evidence available from the request alone.
      if (profile.engine !== undefined && profile.engine === ctx.ua.engine) {
        return {
          detector: "tls-fingerprint",
          summary: `TLS handshake matches the claimed client (${profile.label})`,
          direction: "human",
          certainty: "moderate",
          weight: 0.35,
          metadata: { fingerprint, profile: profile.label },
        };
      }

      return undefined;
    },
  };
}
