import { claimsBrowser } from "../internal/ua.js";
import { absenceIsMeaningful } from "./types.js";
import type { Detector, DetectionContext } from "./types.js";
import type { Evidence } from "../types.js";

/** Headers HTTP/2 and HTTP/3 forbid outright. Sending one is a protocol violation, not a preference. */
const CONNECTION_SPECIFIC = ["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade"] as const;

/**
 * Fields a message may carry at most once, split by what a second copy means.
 *
 * `malformed` is the set RFC 9112 requires a recipient to *reject*: a second `Host`
 * or a second `Content-Length` makes the message length or target ambiguous, which is
 * the ambiguity every request-smuggling technique is built on. No client stack in
 * existence emits either, because emitting one breaks the client's own connection
 * through any compliant proxy.
 *
 * `singleton` is the weaker set — duplicating them is bad practice rather than a
 * violation, and it is what you get from a script that appends a header the library
 * already set. `cookie` is deliberately absent: HTTP/2 explicitly permits splitting
 * it across several fields, and a browser does exactly that.
 */
const MALFORMED_IF_REPEATED = ["host", "content-length"] as const;
const SINGLETON_HEADERS = ["user-agent", "accept", "accept-encoding", "accept-language", "referer", "content-type", "authorization", "range"] as const;

export interface HeaderIntegrityOptions {
  /** Report a browser-claiming client that omits `Accept-Language`. Default true. */
  checkAcceptLanguage?: boolean;
}

/** Header names that arrived more than once, from the wire-order list. */
function repeatedHeaders(order: readonly string[]): Set<string> {
  const repeated = new Set<string>();
  if (order.length < 2) return repeated;
  const seen = new Set<string>();
  for (const name of order) {
    if (seen.has(name)) repeated.add(name);
    else seen.add(name);
  }
  return repeated;
}

/**
 * Does this request's header set match the client it claims to be?
 *
 * Browsers are extremely consistent about which headers they attach; HTTP libraries
 * attach the minimum that gets a response. The gap between the two is one of the
 * most reliable probabilistic signals available from a single request.
 *
 * Almost everything here is deliberately kept below `certain`, because headers pass
 * through corporate proxies, CDNs, privacy extensions and mobile carrier
 * transcoders, any of which will strip or rewrite them for an entirely real person.
 *
 * The exceptions are the three genuine protocol violations: a connection-specific
 * header on HTTP/2 or HTTP/3, a message carrying both `Content-Length` and
 * `Transfer-Encoding`, and a repeated `Host` or `Content-Length`. Each is a rule the
 * specification requires a recipient to *enforce* rather than merely recommends, so a
 * client that breaks it cannot get a response through any compliant proxy — and each
 * is read from what the request *contains*, never from what it lacks. That second
 * property is the one doing the work: an absence is indistinguishable from a facts
 * source that dropped the header, and no absence in this file may reach `certain`.
 */
export function headerIntegrityDetector(options: HeaderIntegrityOptions = {}): Detector {
  const checkLanguage = options.checkAcceptLanguage ?? true;

  return {
    id: "header-integrity",
    description: "Compares the request's header set against what the client it claims to be would send",
    cost: "cheap",
    stage: "always",

    inspect(ctx: DetectionContext): Evidence[] | undefined {
      const { headers, httpVersion } = ctx.facts;
      const results: Evidence[] = [];

      // --- Protocol violation: the one deterministic check in this detector. ---
      if (httpVersion !== undefined && (httpVersion.startsWith("2") || httpVersion.startsWith("3"))) {
        const offending = CONNECTION_SPECIFIC.filter((name) => headers[name] !== undefined);
        if (offending.length > 0) {
          results.push({
            detector: "header-integrity",
            summary: `HTTP/${httpVersion} request carries connection-specific header(s): ${offending.join(", ")}`,
            direction: "bot",
            certainty: "certain",
            botClass: "http-client",
            deterministicBasis: `RFC 9113 §8.2.2 forbids connection-specific header fields in HTTP/2 and HTTP/3, and requires endpoints to treat them as malformed. Every browser and every maintained HTTP library complies; a request carrying one was assembled field-by-field by something that does not implement the protocol.`,
            metadata: { httpVersion, headers: offending },
          });
        }
      }

      // --- The message contradicts the framing rules of its own protocol. ---
      //
      // Everything in this block is `certain` for the same reason as the check above:
      // the specification does not merely discourage these, it requires a recipient to
      // refuse the message. A client that emits one cannot talk to a compliant proxy,
      // a CDN or a load balancer, so no shipping client emits one — which leaves
      // requests assembled by hand, and, overwhelmingly, requests assembled by hand
      // *for a purpose*: an ambiguous message length is the basis of every
      // request-smuggling technique there is.
      //
      // Worth knowing where this check does and does not apply: Node's own HTTP parser
      // answers 400 to a CL+TE message before a handler ever runs, so on a plain Node
      // server this branch is unreachable — the corpus's wire replay proved exactly
      // that and now skips the case. It earns its place for facts built where Node's
      // parser is not in the path: an edge worker, a WAF event, a log line, or another
      // runtime.
      if (headers["content-length"] !== undefined && headers["transfer-encoding"] !== undefined) {
        results.push({
          detector: "header-integrity",
          summary: "Request carries both Content-Length and Transfer-Encoding",
          direction: "bot",
          certainty: "certain",
          botClass: "scanner",
          deterministicBasis:
            "RFC 9112 §6.1 states that a message with both Content-Length and Transfer-Encoding must be treated as malformed, because the two disagree about where the body ends. Every HTTP implementation removes one before sending; a request carrying both was framed by hand, and the disagreement it creates between two servers in a chain is the mechanism of request smuggling.",
          metadata: { contentLength: headers["content-length"]?.slice(0, 32), transferEncoding: headers["transfer-encoding"]?.slice(0, 32) },
        });
      }

      const repeated = repeatedHeaders(ctx.facts.headerOrder);
      if (repeated.size > 0) {
        const malformed = MALFORMED_IF_REPEATED.filter((name) => repeated.has(name));
        if (malformed.length > 0) {
          results.push({
            detector: "header-integrity",
            summary: `Request repeats the ${malformed.join(" and ")} header, which may appear only once`,
            direction: "bot",
            certainty: "certain",
            botClass: "scanner",
            deterministicBasis:
              "RFC 9112 §3.2 and §6.3 require a recipient to reject a request with more than one Host or Content-Length field, because either makes the request target or the body length ambiguous. No client library or browser produces this; a request that does was assembled field by field.",
            metadata: { headers: malformed },
          });
        }

        // The weaker set, and only over HTTP/1.x — HTTP/2 permits a client to split
        // some fields across several frames, so a duplicate there is not the client's
        // doing.
        const singletons = httpVersion === undefined || httpVersion.startsWith("1") ? SINGLETON_HEADERS.filter((name) => repeated.has(name)) : [];
        if (singletons.length > 0) {
          results.push({
            detector: "header-integrity",
            summary: `Request sends ${singletons.join(", ")} more than once, which no browser does`,
            direction: "bot",
            certainty: "strong",
            weight: 0.6,
            botClass: "http-client",
            metadata: { headers: singletons },
          });
        }
      }

      // An HTTP/1.1 request with no `Host` is as clear a protocol violation as the two
      // above — RFC 9112 §3.2 requires one, and requires a server to answer 400 without
      // it — and it is deliberately *not* checked here. The rule this detector holds to
      // is that **no argument from absence may reach the `certain` tier**: a header
      // missing from the facts we were handed is not a header missing from the request,
      // and a caller who builds facts from a log line, a WAF event or a partial adapter
      // would otherwise manufacture proof against every request in the file. The two
      // checks above survive that test because both reason from what is *present*.

      if (!claimsBrowser(ctx.ua)) return results.length > 0 ? results : undefined;

      // Everything below is an argument from absence, so it is only available when
      // the header set we were handed is the one the client actually sent.
      if (!absenceIsMeaningful(ctx)) return results.length > 0 ? results : undefined;

      // --- Everything below applies only to clients claiming to be a browser. ---
      if (headers["accept"] === undefined) {
        results.push({
          detector: "header-integrity",
          summary: "Client claims to be a browser but sent no Accept header",
          direction: "bot",
          certainty: "strong",
          weight: 0.7,
          botClass: "impersonator",
          // One stripping intermediary removes the whole cluster; see `Evidence.family`.
          family: "stripped-headers",
          metadata: { browser: ctx.ua.browser },
        });
      }

      if (checkLanguage && headers["accept-language"] === undefined) {
        results.push({
          detector: "header-integrity",
          summary: "Client claims to be a browser but sent no Accept-Language header",
          direction: "bot",
          // Deliberately moderate: several privacy-hardening extensions and the Tor
          // Browser's stricter modes remove this header from real people's requests.
          certainty: "moderate",
          botClass: "impersonator",
          // One stripping intermediary removes the whole cluster; see `Evidence.family`.
          family: "stripped-headers",
          metadata: { browser: ctx.ua.browser },
        });
      }

      const encoding = headers["accept-encoding"];
      if (encoding === undefined) {
        results.push({
          detector: "header-integrity",
          summary: "Client claims to be a browser but sent no Accept-Encoding header",
          direction: "bot",
          certainty: "moderate",
          botClass: "impersonator",
          // One stripping intermediary removes the whole cluster; see `Evidence.family`.
          family: "stripped-headers",
          metadata: { browser: ctx.ua.browser },
        });
      } else if (!encoding.includes("gzip") && !encoding.includes("br") && !encoding.includes("*")) {
        results.push({
          detector: "header-integrity",
          summary: `Client claims to be a browser but advertises no common compression: "${encoding.slice(0, 60)}"`,
          direction: "bot",
          certainty: "moderate",
          botClass: "impersonator",
          family: "stripped-headers",
          metadata: { acceptEncoding: encoding.slice(0, 120) },
        });
      }

      return results.length > 0 ? results : undefined;
    },
  };
}
