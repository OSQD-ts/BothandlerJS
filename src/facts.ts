import { joinHeaderValue, parseCookies } from "./internal/http.js";
import { normalizeIp } from "./internal/ip.js";
import type { RequestFacts } from "./types.js";

/** Longest URL we will parse. Anything beyond this is a payload, not a path. */
const MAX_URL_LENGTH = 8192;
/** Cap on query parameters kept. */
const MAX_QUERY_PARAMS = 64;

export interface FactsInput {
  method?: string | undefined;
  /** Request target, path plus optional query — what `req.url` gives you. */
  url?: string | undefined;
  /** Raw header map. Values may be arrays; names may be any case. */
  headers: Record<string, string | string[] | undefined>;
  /**
   * Header names in wire order. Node exposes them via `req.rawHeaders` (alternating
   * name/value) — pass that array directly, or a name-only list.
   */
  rawHeaders?: readonly string[] | undefined;
  /** Socket address. Pass the *socket's* address; forwarding is resolved separately. */
  ip: string;
  timestamp?: number | undefined;
  protocol?: "http" | "https" | undefined;
  /**
   * The HTTP version of the connection **this process accepted** — Node's
   * `request.httpVersion`, not the version the client negotiated with your edge.
   *
   * The distinction has teeth. HTTP/2 forbids connection-specific headers, and
   * `header-integrity` treats one as a deterministic protocol violation. If you set
   * this from a forwarded header while the request itself arrived over HTTP/1.1 from
   * a proxy — which adds `Connection: keep-alive` — you will manufacture that
   * violation for every real browser behind that proxy, and it is a `certain` verdict,
   * so it can block. Report the connection you actually have, or leave it unset.
   */
  httpVersion?: string | undefined;
  tlsFingerprint?: string | undefined;
  /** See {@link RequestFacts.partialHeaders}. Set it when the source cannot supply every header. */
  partialHeaders?: boolean | undefined;
  extra?: Record<string, unknown> | undefined;
}

/**
 * Reduces a request to the facts detectors are allowed to see.
 *
 * Normalisation happens exactly once, here, and every detector reads the result. That
 * is partly performance — lowercasing a header map per detector would be absurd — but
 * mostly correctness: if one detector reads `req.headers['User-Agent']` and another
 * reads `req.headers['user-agent']`, they will eventually disagree about the same
 * request, and the bug will be invisible.
 *
 * Every field is bounded. Each one is attacker-controlled, and this runs on every
 * request to your site.
 */
export function createFacts(input: FactsInput): RequestFacts {
  const rawUrl = input.url ?? "/";
  const url = rawUrl.length > MAX_URL_LENGTH ? rawUrl.slice(0, MAX_URL_LENGTH) : rawUrl;
  const queryStart = url.indexOf("?");
  const rawPath = queryStart === -1 ? url : url.slice(0, queryStart);

  const headers: Record<string, string | undefined> = Object.create(null) as Record<string, string | undefined>;
  for (const [name, value] of Object.entries(input.headers)) {
    const joined = joinHeaderValue(value);
    if (joined !== undefined) headers[name.toLowerCase()] = joined;
  }

  const facts: RequestFacts = {
    method: (input.method ?? "GET").toUpperCase(),
    path: normalizePath(rawPath),
    query: parseQuery(queryStart === -1 ? "" : url.slice(queryStart + 1)),
    headers,
    headerOrder: extractOrder(input.rawHeaders, headers),
    ip: normalizeIp(input.ip) ?? input.ip,
    timestamp: input.timestamp ?? Date.now(),
  };

  // Only parse cookies that exist. Most bot traffic carries none, and building an
  // empty bag for every one of those requests is pure garbage.
  const cookieHeader = headers["cookie"];
  if (cookieHeader !== undefined) facts.cookies = parseCookies(cookieHeader);

  if (input.protocol !== undefined) facts.protocol = input.protocol;
  if (input.httpVersion !== undefined) facts.httpVersion = input.httpVersion;
  if (input.tlsFingerprint !== undefined) facts.tlsFingerprint = input.tlsFingerprint;
  if (input.partialHeaders === true) facts.partialHeaders = true;
  if (input.extra !== undefined) facts.extra = input.extra;

  return facts;
}

/**
 * Decodes and normalises a path.
 *
 * Rule matching is done on this value, so `/admin`, `/%61dmin` and `/./admin` must
 * not be three different paths as far as a policy is concerned — otherwise a rule
 * scoped to a path is trivially side-stepped by spelling it differently. Decoding is
 * single-pass: repeatedly decoding until it stops changing is how `%2525` becomes `%`
 * and how path-traversal filters get bypassed.
 */
function normalizePath(rawPath: string): string {
  let path = rawPath;
  try {
    path = decodeURIComponent(rawPath);
  } catch {
    // Malformed percent-encoding. Keep the raw form: it is still a fact about the
    // request, and guessing at an intended decoding would be inventing one.
  }
  path = path.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  if (!path.startsWith("/")) path = `/${path}`;

  // Resolve `.` and `..` segments so a rule on a path prefix cannot be walked around.
  if (path.includes("./")) {
    const resolved: string[] = [];
    for (const segment of path.split("/")) {
      if (segment === "" || segment === ".") continue;
      if (segment === "..") resolved.pop();
      else resolved.push(segment);
    }
    path = `/${resolved.join("/")}`;
  }
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

function parseQuery(search: string): Record<string, string> {
  // Null-prototype: a literal `?__proto__=x` becomes an ordinary own key instead of
  // hitting the prototype setter and vanishing, so a detector can actually see it.
  const query: Record<string, string> = Object.create(null) as Record<string, string>;
  if (search.length === 0) return query;
  let count = 0;
  for (const [key, value] of new URLSearchParams(search)) {
    if (count++ >= MAX_QUERY_PARAMS) break;
    query[key] = value.length > 1024 ? value.slice(0, 1024) : value;
  }
  return query;
}

/**
 * Extracts wire-order header names.
 *
 * Both documented input shapes have to be told apart: Node's `rawHeaders`, which
 * alternates name and value, and a plain list of names.
 *
 * Asking whether the even-indexed entries *look like* header names cannot do it, and
 * used to get the common case backwards. Every entry of a name-only list looks like a
 * header name, so any such list of even length was read as Node-style and every second
 * name was discarded — silently halving the header order, which is a fingerprint, for
 * a shape the documentation invites callers to pass.
 *
 * The header map decides it instead. In a name-only list every entry is a header that
 * was actually received; in an alternating list the odd entries are values, which are
 * almost never also header names. That distinguishes the two even for a single-header
 * request, where any shape-based guess is ambiguous.
 */
const MAX_ORDERED_HEADERS = 64;

function extractOrder(rawHeaders: readonly string[] | undefined, headers: Record<string, string | undefined>): readonly string[] {
  if (!rawHeaders || rawHeaders.length === 0) return EMPTY_ORDER;

  let isNodeStyle = rawHeaders.length % 2 === 0;
  if (isNodeStyle) {
    let everyEntryIsAHeader = true;
    for (let i = 0; i < rawHeaders.length; i++) {
      const entry = rawHeaders[i]!;
      const known = headers[entry.toLowerCase()] !== undefined;
      // An even entry that is neither a received header nor even a valid token cannot
      // be a name in either shape; fall back to reading the list as names rather than
      // dropping half of something unrecognised.
      if (i % 2 === 0 && !known && !isHeaderName(entry)) {
        isNodeStyle = false;
        break;
      }
      if (!known) everyEntryIsAHeader = false;
    }
    if (everyEntryIsAHeader) isNodeStyle = false;
  }

  // One pass, one array. The previous version walked the input three times —
  // `every`, then `filter`, then `slice().map()` — allocating at each step.
  const step = isNodeStyle ? 2 : 1;
  const order: string[] = [];
  for (let i = 0; i < rawHeaders.length && order.length < MAX_ORDERED_HEADERS; i += step) {
    order.push(rawHeaders[i]!.toLowerCase());
  }
  return order;
}

const EMPTY_ORDER: readonly string[] = Object.freeze([]);

/** RFC 9110 token characters. A scan rather than a regex: this runs once per header. */
function isHeaderName(value: string): boolean {
  if (value.length === 0) return false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    const ok =
      (code >= 0x30 && code <= 0x39) || // 0-9
      (code >= 0x41 && code <= 0x5a) || // A-Z
      (code >= 0x61 && code <= 0x7a) || // a-z
      code === 0x21 || (code >= 0x23 && code <= 0x27) || code === 0x2a || code === 0x2b ||
      code === 0x2d || code === 0x2e || code === 0x5e || code === 0x5f || code === 0x60 ||
      code === 0x7c || code === 0x7e;
    if (!ok) return false;
  }
  return true;
}
