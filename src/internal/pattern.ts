/**
 * Path patterns supplied by an operator, made safe to reuse.
 *
 * `RegExp.test` is stateful when the pattern carries `g` or `y`: it resumes from
 * `lastIndex` and resets only on a failed match, so the same pattern tested against
 * the same string answers `true`, `false`, `true`, `false`. Nothing here matches a
 * path more than once, so neither flag can express anything anyone wanted — but both
 * turn a rule into a coin flip, and the symptom (a bot blocked, served, blocked,
 * served) reads as a bug anywhere except in the flag that caused it.
 */

/** The pattern with `g` and `y` removed. Returns strings and stateless regexes unchanged. */
export function statelessPattern<T extends string | RegExp>(pattern: T): T {
  if (typeof pattern === "string" || !/[gy]/.test(pattern.flags)) return pattern;
  return new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, "")) as T;
}

/** True when `path` matches: strings are a prefix test, regexes are tested as written. */
export function pathMatches(patterns: readonly (string | RegExp)[], path: string): boolean {
  for (let i = 0; i < patterns.length; i++) {
    const pattern = patterns[i]!;
    if (typeof pattern === "string" ? path.startsWith(pattern) : pattern.test(path)) return true;
  }
  return false;
}
