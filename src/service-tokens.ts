import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Shared secrets that let a service caller prove itself.
 *
 * The gap this fills is narrow and very common. A challenge is unanswerable from `fetch`:
 * an uptime monitor is a bare HTTP client with no browser, no cookies and nothing
 * browser-shaped, so under a strict policy it is challenged at best — and then reports the
 * site down every fifteen minutes while the site is fine. Every deployment that has a
 * monitor writes a rule to let it through, which means every deployment writes a rule that
 * handles a credential, and the library has been giving that rule no shape at all.
 *
 * Shape matters here more than convenience. Handed no help, the rule people write is a
 * predicate that pulls a header and compares it with `===`, which is:
 *
 * - **variable-time**, so it leaks the secret a byte at a time to anyone who can measure
 *   the difference between a wrong first character and a wrong last one;
 * - **invisible to redaction**, because a header the library has never heard of is
 *   printed in full on the dashboard and into every export — a live credential in a file
 *   somebody pastes into a chat.
 *
 * So the comparison happens once, here, in constant time, and the header is registered as
 * a secret by construction rather than by remembering to configure it. What reaches a rule
 * is the *name* — "uptime monitor" — which is not a secret and can be shown, logged and
 * filtered on freely.
 *
 * What this is not: a general authentication mechanism. A shared secret in a header is the
 * weakest credential there is — it does not expire, it is replayable by anyone who sees it
 * once, and it says nothing about *which* caller presented it. It is right for a monitor
 * you operate calling an endpoint you operate, and wrong for anything a third party holds.
 */
export interface ServiceTokenOptions {
  /**
   * The header the token arrives in. Default `x-bothandler-token`.
   *
   * Whatever it is, it is redacted wherever a header is shown — feed, row detail, export,
   * request tester — because that redaction is the second half of the point.
   */
  header?: string;
  /**
   * Name → secret.
   *
   * The name is what rules match and what appears on screen; the secret appears nowhere.
   * Several names may be configured, which is the usual case: a monitor and a deploy hook
   * are different callers and rotating one should not revoke the other.
   */
  tokens: Readonly<Record<string, string>>;
}

/**
 * Short enough to be guessed.
 *
 * Not a hard floor, because a deployment mid-rotation should not fail to start over a
 * secret it is about to replace — but short secrets in this position are a real finding
 * and staying quiet about them would repeat the mistake this module exists to prevent.
 */
export const MIN_TOKEN_LENGTH = 16;

export const DEFAULT_TOKEN_HEADER = "x-bothandler-token";

/**
 * Compares two secrets without revealing where they first differ.
 *
 * Both are hashed before comparison, which is what makes this safe for values of
 * *different lengths*: `timingSafeEqual` throws on a length mismatch, so the obvious
 * implementation has to check lengths first — and that check is itself an oracle for the
 * length of the real secret. Two digests are always 32 bytes, so there is nothing to
 * branch on and the comparison is the only thing that happens.
 */
function sameSecret(presented: string, expected: string): boolean {
  const a = createHash("sha256").update(presented, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

/** A configured set of tokens, compiled once. */
export class ServiceTokens {
  readonly header: string;
  private readonly entries: ReadonlyArray<readonly [string, string]>;

  constructor(options: ServiceTokenOptions) {
    this.header = (options.header ?? DEFAULT_TOKEN_HEADER).toLowerCase();
    this.entries = Object.entries(options.tokens ?? {}).filter(([, secret]) => typeof secret === "string" && secret.length > 0);
  }

  get names(): string[] {
    return this.entries.map(([name]) => name);
  }

  /** Names configured with a secret short enough to be worth saying something about. */
  get weak(): string[] {
    return this.entries.filter(([, secret]) => secret.length < MIN_TOKEN_LENGTH).map(([name]) => name);
  }

  get size(): number {
    return this.entries.length;
  }

  /**
   * The name of the token this request presented, or `undefined`.
   *
   * Every configured token is compared even after one matches. Returning early would make
   * the response time depend on the position of the matching entry, which over enough
   * requests says which token was presented — and with it, which caller a given secret
   * belongs to.
   */
  identify(headers: Readonly<Record<string, string | undefined>>): string | undefined {
    const presented = headers[this.header];
    if (presented === undefined || presented === "") return undefined;
    let found: string | undefined;
    for (const [name, secret] of this.entries) {
      if (sameSecret(presented, secret) && found === undefined) found = name;
    }
    return found;
  }
}
