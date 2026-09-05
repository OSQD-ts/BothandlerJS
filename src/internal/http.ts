/** Cookie parsing and serialisation, plus small header helpers. No dependencies. */

/** Longest Cookie header we will parse. Beyond this it is a payload, not a session. */
const MAX_COOKIE_HEADER = 8192;
const MAX_COOKIES = 64;

/**
 * Parses a `Cookie` header into a null-prototype bag.
 *
 * Null-prototype matters: a request carrying `__proto__=x` would otherwise hit the
 * prototype setter on a plain object and vanish, and any later `cookies.constructor`
 * lookup would find `Object`'s rather than `undefined`. Neither is a vulnerability by
 * itself; both are the kind of surprise that becomes one.
 */
export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = Object.create(null) as Record<string, string>;
  if (header === undefined || header.length === 0) return cookies;
  const source = header.length > MAX_COOKIE_HEADER ? header.slice(0, MAX_COOKIE_HEADER) : header;

  let count = 0;
  for (const pair of source.split(";")) {
    if (count >= MAX_COOKIES) break;
    const equals = pair.indexOf("=");
    if (equals <= 0) continue;
    const name = pair.slice(0, equals).trim();
    if (name.length === 0) continue;
    const rawValue = pair.slice(equals + 1).trim();
    const value = rawValue.startsWith('"') && rawValue.endsWith('"') ? rawValue.slice(1, -1) : rawValue;
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      // A malformed percent-escape is not worth rejecting the whole header over.
      cookies[name] = value;
    }
    count++;
  }
  return cookies;
}

export interface CookieOptions {
  maxAgeMs?: number;
  path?: string;
  domain?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: "Lax" | "Strict" | "None";
}

/** Builds a `Set-Cookie` value. Rejects names and values that would let a caller inject attributes. */
export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) throw new TypeError(`Invalid cookie name: ${name}`);
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (options.maxAgeMs !== undefined) parts.push(`Max-Age=${Math.floor(options.maxAgeMs / 1000)}`);
  parts.push(`Path=${options.path ?? "/"}`);
  if (options.domain !== undefined) {
    if (!/^[A-Za-z0-9.-]+$/.test(options.domain)) throw new TypeError(`Invalid cookie domain: ${options.domain}`);
    parts.push(`Domain=${options.domain}`);
  }
  if (options.secure !== false) parts.push("Secure");
  if (options.httpOnly !== false) parts.push("HttpOnly");
  // `SameSite=None` without `Secure` is rejected by browsers, so it is never a valid
  // combination to emit — fail loudly here rather than shipping a cookie nothing keeps.
  const sameSite = options.sameSite ?? "Lax";
  if (sameSite === "None" && options.secure === false) {
    throw new TypeError("SameSite=None requires Secure");
  }
  parts.push(`SameSite=${sameSite}`);
  return parts.join("; ");
}

/** Joins multi-value headers the way the rest of the library expects to see them. */
export function joinHeaderValue(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value.join(", ") : value;
}
