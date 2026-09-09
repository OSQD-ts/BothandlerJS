import type { Detector, DetectionContext } from "./types.js";
import type { Evidence } from "../types.js";

/**
 * Request targets spelled in ways nothing fetching a resource spells them.
 *
 * Everything else in this library reads `facts.path`, which is normalised: decoded once,
 * backslashes and doubled slashes collapsed, `.` and `..` resolved. That normalisation is
 * not optional — a rule scoped to `/admin` has to hold against `/%61dmin` and `/./admin`,
 * or it is not a rule — but it is also the reason an evasive target arrives here looking
 * ordinary. `/%2e%2e%2f%2e%2e%2fapp/config.yml` reads as `/app/config.yml`, which is a
 * page nobody has and nothing on a wordlist, and the one fact that made it worth looking
 * at has been tidied away.
 *
 * So this reads {@link RequestFacts.rawPath}, the target as it arrived. The question is
 * narrow, and it is about *spelling* rather than about destination: a client that wanted
 * `/app/config.yml` and asked for it plainly is somebody else's problem, and
 * `probe-signature` and `path-novelty` are the detectors for what was asked for. This one
 * is interested only in clients that took trouble not to be understood.
 *
 * ## Why none of it is `certain`
 *
 * Each of these is a deliberate act with no ordinary cause, and that is not the same as
 * admitting no benign explanation — which is the bar {@link Evidence.deterministicBasis}
 * sets, and the bar that lets a verdict close a door.
 *
 * Double-encoding is the closest call and the clearest example of why the answer is no. A
 * path segment that *carries a URL as data* — `/redirect/https%3A%2F%2Fexample.com%2Fa` —
 * is encoded once to sit inside a path, and encoded again by whatever built the link
 * around it. That is a real pattern on real sites, it produces `%252e` and `%252f`
 * honestly, and a library that blocked it would be blocking an application's own links.
 * `strong` is the honest tier: enough to score, never enough on its own to deny anybody.
 *
 * They also share a family. One target usually trips several of these — a traversal is
 * normally encoded, and an encoded traversal is often double-encoded — and that is one
 * act observed three ways, not three reasons.
 */

/** `%2e`, `%2f` and `%5c`: the dot, the slash and the backslash, written the long way. */
const ENCODED_SEPARATOR = /%2e|%2f|%5c/i;
/** An encoded separator that is specifically a slash, hidden inside a segment. */
const ENCODED_SLASH = /%2f|%5c/i;
/** A percent sign that was itself percent-encoded, followed by more hex. */
const DOUBLE_ENCODED = /%25[0-9a-f]{2}/i;
/**
 * An encoded control character: the whole C0 range, and DEL.
 *
 * Including `%09`, `%0a` and `%0d` — tab, newline and carriage return — which an earlier
 * version of this class quietly left out, and which are the three that matter most: a
 * newline in a request target is how a header is injected into whatever writes the log
 * or builds the next request. Nothing legitimate puts one in a *path*; this runs before
 * the query string, where a form's textarea has every right to one.
 */
const ENCODED_CONTROL = /%0[0-9a-f]|%1[0-9a-f]|%7f/i;
/** Dots written out, or spelled: `..`, `%2e%2e`, `%2e.`, `.%2e`. */
const TRAVERSAL = /\.\.|%2e%2e|%2e\.|\.%2e/i;
/** `GET http://elsewhere/` — the form a request to a *proxy* takes. */
const ABSOLUTE_FORM = /^[a-z][a-z0-9+.-]*:\/\//i;

export interface TargetIntegrityOptions {
  /**
   * Report a target that walks above the site root, e.g. `/../../etc/passwd`. Default
   * true.
   *
   * Worth a switch because it is the one signal here a *broken* client produces as
   * readily as a hostile one: a relative link resolved against the wrong base gives a
   * client dots to send, and some feed readers and old link checkers duly send them.
   * Encoding those dots is deliberate; writing them is a bug. Both are reported, the
   * second at a lower tier, and this turns the second off for a site that has one of
   * those clients and would rather not hear about it on every request.
   */
  reportPlainTraversal?: boolean;
}

/** One observation about how a target was spelled. */
interface Finding {
  what: string;
  certainty: "strong" | "moderate";
}

export function targetIntegrityDetector(options: TargetIntegrityOptions = {}): Detector {
  const reportPlain = options.reportPlainTraversal ?? true;

  return {
    id: "target-integrity",
    description: "Reports a request target spelled to get past something rather than to fetch something",
    cost: "cheap",
    stage: "always",

    inspect(ctx: DetectionContext): Evidence | undefined {
      const raw = ctx.facts.rawPath;
      // Absent on every request whose target survived normalisation unchanged, which is
      // very nearly all of them. This is the fast path, and it is one property read.
      if (raw === undefined) return undefined;

      const findings: Finding[] = [];

      if (ABSOLUTE_FORM.test(raw)) {
        // Origin-form is what a client sends to the server holding the resource;
        // absolute-form is what it sends to a proxy it wants to fetch *through*. Arriving
        // here it is a question — "will you fetch this for me?" — and what it is asking
        // for is not ours.
        findings.push({ what: "asked this server to fetch a URL elsewhere, which is a request addressed to a proxy", certainty: "strong" });
      }

      if (DOUBLE_ENCODED.test(raw)) {
        findings.push({ what: "encoded its own encoding, so one round of decoding leaves it still encoded", certainty: "strong" });
      }

      // Only the encoded form is checked, and that is not an omission. A raw control
      // character does not survive an HTTP parser — it is how a request line ends, which
      // is why nothing delivers one in `req.url` — and, more to the point here, it would
      // pass through normalisation unchanged, so `rawPath` would never be set and this
      // branch could not be reached. What actually arrives is the encoding.
      if (ENCODED_CONTROL.test(raw)) {
        findings.push({ what: "carried a control character in the target", certainty: "strong" });
      }

      if (TRAVERSAL.test(raw)) {
        if (ENCODED_SEPARATOR.test(raw)) {
          findings.push({ what: "spelled the dots and slashes of a directory traversal in percent-encoding", certainty: "strong" });
        } else if (reportPlain) {
          // Plainly written. A broken relative link produces exactly this, so it is the
          // one observation here that is genuinely ambiguous, and it is tiered for that.
          findings.push({ what: "walked up out of the site root", certainty: "moderate" });
        }
      } else if (ENCODED_SLASH.test(raw)) {
        // A separator hidden inside what a naive filter reads as a single segment.
        // Without the dots it is not a traversal, but it is still a path pretending to be
        // shorter than it is.
        findings.push({ what: "hid a path separator inside a segment by encoding it", certainty: "moderate" });
      }

      if (findings.length === 0) return undefined;

      // The strongest observation sets the tier, and every one of them is named: whoever
      // reads this is deciding whether a client is a person, and "the target was
      // malformed" does not help them do it.
      const certainty = findings.some((finding) => finding.certainty === "strong") ? "strong" : "moderate";
      const what = findings.map((finding) => finding.what);
      const listed = what.length === 1 ? (what[0] as string) : `${what.slice(0, -1).join(", ")}, and ${what[what.length - 1]}`;

      return {
        detector: "target-integrity",
        summary: `The request target ${listed}`,
        direction: "bot",
        certainty,
        botClass: "scanner",
        // One act, however many ways it shows. A traversal is usually encoded and an
        // encoded traversal is often double-encoded; compounding them would turn one
        // request into three independent reasons to be suspicious.
        family: "evasive-target",
        metadata: { target: raw.length > 200 ? `${raw.slice(0, 200)}…` : raw },
      };
    },
  };
}
