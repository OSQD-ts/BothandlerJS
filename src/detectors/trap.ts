import type { Detector, DetectionContext } from "./types.js";
import type { Evidence } from "../types.js";

export interface TrapOptions {
  /**
   * Paths that exist only to be found by something that reads markup rather than
   * renders it. Matched exactly, or as a prefix when the entry ends in `/`.
   */
  paths?: readonly string[];
  /**
   * Names of form fields that are present in your HTML, hidden from people, and must
   * therefore arrive empty. Anything that fills one filled it by parsing the form.
   *
   * **You have to hand the submitted values over.** The engine reads no request body,
   * deliberately — doing so would mean consuming the stream before your own parser
   * sees it. A hidden field in a `method="post"` form therefore arrives in the body,
   * where nothing here can see it, so a query-string-only check would silently never
   * fire for the forms honeypots are actually put on: sign-up, contact, comment,
   * login. Put the parsed fields in `facts.extra.formFields` — see
   * {@link TRAP_FIELD_SOURCE} — and this reads them alongside the query string.
   */
  formFields?: readonly string[];
  /** Header a trap link may carry, if you prefer marking traps out-of-band. */
  headerName?: string;
}

/**
 * Where {@link trapDetector} looks for submitted form fields, inside `facts.extra`.
 *
 * ```ts
 * botHandler(handler, {
 *   enrich: (request, facts) => ({ ...facts, extra: { [TRAP_FIELD_SOURCE]: request.body } }),
 * });
 * ```
 *
 * Values are read as strings; anything else is ignored rather than coerced, because
 * this feeds a `certain` verdict and `String(someObject)` is not evidence of anything.
 */
export const TRAP_FIELD_SOURCE = "formFields";

/** Trap paths installed unless you replace them. Chosen to look like something worth fetching. */
export const DEFAULT_TRAP_PATHS: readonly string[] = ["/internal/export.csv", "/api/v1/all-users", "/sitemap-index-full.xml"];

/**
 * Bait. The one detector whose evidence needs no statistics at all.
 *
 * A trap is a link or a form field that exists in your HTML but is unreachable by a
 * person: hidden from layout, hidden from assistive technology, and excluded in
 * `robots.txt`. There is no sequence of clicks, keystrokes or gestures that gets a
 * human to it. Something that requests it read your markup and followed every href
 * it found, which is the definition of automation.
 *
 * This is `certain` for a reason that no header check can match: it does not model
 * what bots look like, it constructs a situation only a bot can be in. Detection by
 * construction rather than by inference, and consequently the one signal whose
 * false-positive rate does not depend on how well the internet is behaving today.
 *
 * Three things must all be true for that guarantee to hold, and they are your
 * responsibility, not the library's:
 *
 * 1. The trap must be **invisible and unfocusable** — use {@link renderTrapLink},
 *    which handles `aria-hidden`, `tabindex="-1"` and `rel="nofollow"` together.
 * 2. The path must be **disallowed in robots.txt** — see {@link trapRobotsEntries} —
 *    so a well-behaved crawler you *want* is not punished for being thorough.
 * 3. The path must **serve nothing real**, now or ever. A trap that later becomes a
 *    working endpoint turns into a source of false positives that will be very hard
 *    to diagnose.
 */
export function trapDetector(options: TrapOptions = {}): Detector {
  const exact = new Set<string>();
  const prefixes: string[] = [];
  for (const path of options.paths ?? DEFAULT_TRAP_PATHS) {
    if (path.endsWith("/")) prefixes.push(path);
    else exact.add(path);
  }
  const formFields = new Set(options.formFields ?? []);
  const headerName = options.headerName?.toLowerCase();

  return {
    id: "trap",
    description: "Fires when a request touches a path, form field or header that only automated markup-following can reach",
    cost: "cheap",
    stage: "always",

    inspect(ctx: DetectionContext): Evidence | undefined {
      const { path, query, headers } = ctx.facts;

      if (exact.has(path) || prefixes.some((prefix) => path.startsWith(prefix))) {
        return {
          detector: "trap",
          summary: `Requested trap path ${path}`,
          direction: "bot",
          certainty: "certain",
          botClass: "scraper",
          deterministicBasis:
            "This path is linked only from markup that is hidden from layout and from assistive technology, and is disallowed in robots.txt. No sequence of user input reaches it; requesting it means the client parsed the HTML and followed every link it contained.",
          metadata: { path, trap: "path" },
        };
      }

      if (formFields.size > 0) {
        const submitted = submittedFields(ctx.facts.extra);
        for (const field of formFields) {
          const value = query[field] ?? submitted?.[field];
          if (typeof value === "string" && value.length > 0) {
            return {
              detector: "trap",
              summary: `Filled the hidden form field "${field}"`,
              direction: "bot",
              certainty: "certain",
              botClass: "scraper",
              deterministicBasis:
                "This field is rendered hidden and is not reachable by keyboard, pointer or assistive technology. A non-empty value can only have been produced by a client that enumerated the form's inputs.",
              metadata: { field, trap: "form-field", source: query[field] !== undefined ? "query" : "body" },
            };
          }
        }
      }

      if (headerName !== undefined && headers[headerName] !== undefined) {
        return {
          detector: "trap",
          summary: `Sent the trap header ${headerName}`,
          direction: "bot",
          certainty: "certain",
          botClass: "scraper",
          deterministicBasis: `The header ${headerName} appears only on trap links in hidden markup. A browser attaches it only if something followed such a link.`,
          metadata: { header: headerName, trap: "header" },
        };
      }

      return undefined;
    },
  };
}

/** Reads the caller's parsed form fields out of `facts.extra`, tolerating any shape. */
function submittedFields(extra: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const source = extra?.[TRAP_FIELD_SOURCE];
  return typeof source === "object" && source !== null ? (source as Record<string, unknown>) : undefined;
}

export interface TrapLinkOptions {
  /** Visible-to-nobody label. Something plausible to a parser, e.g. "Full export". */
  label?: string;
}

/**
 * Renders a trap link as HTML, with every attribute needed for the guarantee above.
 *
 * `aria-hidden` and `tabindex="-1"` together remove it from both the visual and the
 * accessibility tree, so screen-reader and keyboard-only users — who are otherwise
 * the group most at risk from clever traps — can never reach it. `rel="nofollow"`
 * asks search engines not to follow it, and belt-and-braces with `robots.txt`.
 *
 * The path and the label are interpolated, and both are escaped on the way in — the
 * comment here used to claim the output contained no interpolated input at all, which
 * was two lines above the code that interpolates it and is exactly the sentence that
 * gets escaping deleted as redundant one day.
 *
 * Emit it once, near the end of `<body>`. With no path it uses the first of
 * {@link DEFAULT_TRAP_PATHS}, which is what the documented example has always shown and
 * what `trapRobotsEntries` already does — until this defaulted, copying that example gave
 * you a route handler that threw.
 */
export function renderTrapLink(path: string = DEFAULT_TRAP_PATHS[0] as string, options: TrapLinkOptions = {}): string {
  // A trap path is matched against `facts.path`, which always begins with a slash, so a
  // path that does not cannot ever match and the link would be decoration. Refused here
  // rather than rendered, for the reason invalid CIDRs are refused at construction: a
  // control you believe you have and do not is worse than one you know you are missing.
  // It also means no scheme — `javascript:` among them — can reach the `href`, which
  // escaping alone does not prevent.
  if (!path.startsWith("/")) {
    throw new TypeError(`A trap path must begin with "/" — it is matched against the request path. Received: ${JSON.stringify(path.slice(0, 60))}`);
  }
  const label = escapeHtml(options.label ?? "Archive index");
  const href = escapeHtml(path);
  return `<a href="${href}" rel="nofollow noindex" aria-hidden="true" tabindex="-1" style="position:absolute;left:-10000px;top:auto;width:1px;height:1px;overflow:hidden">${label}</a>`;
}

/**
 * Renders a hidden honeypot form field. Give it a name a form-filler will want to
 * complete — `email_confirm`, `website` — and register that name in `formFields`.
 *
 * If the form is a POST — and the forms worth protecting are — the value arrives in
 * the body, which this library never reads. Pass your parsed body through
 * {@link TRAP_FIELD_SOURCE}, or the field will be rendered, filled, and ignored.
 */
export function renderTrapField(name: string): string {
  const safe = escapeHtml(name);
  return `<div aria-hidden="true" style="position:absolute;left:-10000px;top:auto;width:1px;height:1px;overflow:hidden"><label for="${safe}">Leave this field empty</label><input type="text" id="${safe}" name="${safe}" tabindex="-1" autocomplete="off" value=""></div>`;
}

/**
 * `robots.txt` lines that exclude your traps.
 *
 * Publish these. A crawler that obeys `robots.txt` is exactly the kind you want to
 * keep, and it is unfair — and bad for your search ranking — to catch it in a net it
 * had no way to see. The bots this detector is for ignore `robots.txt` entirely,
 * which is the point.
 */
export function trapRobotsEntries(paths: readonly string[] = DEFAULT_TRAP_PATHS): string {
  return ["User-agent: *", ...paths.map((path) => `Disallow: ${path}`)].join("\n");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}
