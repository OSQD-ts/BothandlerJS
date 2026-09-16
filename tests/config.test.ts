import { describe, expect, it } from "vitest";
import { BotHandler, ConfigError } from "../src/index.js";

describe("configuration that would fail silently", () => {
  // `test` on a `g` or `y` regex resumes from `lastIndex`, so the same pattern against
  // the same path answers true, false, true, false. On the rule that decides whether
  // detection runs at all, that assesses every second request to an ignored path.
  it("keeps a global ignorePaths regex from matching only every other time", () => {
    const handler = new BotHandler({ ignorePaths: [/\.png$/g] });
    for (let i = 0; i < 4; i++) expect(handler.isIgnoredPath("/assets/logo.png"), `call ${i + 1}`).toBe(true);
    expect(handler.isIgnoredPath("/assets/logo.svg")).toBe(false);
  });

  /**
   * The trailing slash is the whole difference between "this path" and "this subtree",
   * and it is the thing `docs/reference/configuration.md` now spells out. Pinned here
   * because `ignorePaths: ["/assets"]` reads like a subtree to almost everybody who
   * writes it, and what it actually ignores is one file called `/assets`.
   */
  it("reads a trailing slash in ignorePaths as the difference between a path and a subtree", () => {
    const exact = new BotHandler({ ignorePaths: ["/healthz"] });
    expect(exact.isIgnoredPath("/healthz")).toBe(true);
    expect(exact.isIgnoredPath("/healthz/live"), "an exact entry is not a prefix").toBe(false);
    expect(exact.isIgnoredPath("/healthzzz")).toBe(false);

    const subtree = new BotHandler({ ignorePaths: ["/assets/"] });
    expect(subtree.isIgnoredPath("/assets/app.js")).toBe(true);
    expect(subtree.isIgnoredPath("/assets/img/logo.png")).toBe(true);
    // And the directory itself without the slash is outside it, which is the one edge
    // the documentation would otherwise leave somebody to discover.
    expect(subtree.isIgnoredPath("/assets")).toBe(false);
  });

  it("leaves a sticky regex's meaning intact apart from the flag", () => {
    const handler = new BotHandler({ ignorePaths: [/^\/health$/y] });
    expect(handler.isIgnoredPath("/health")).toBe(true);
    expect(handler.isIgnoredPath("/health")).toBe(true);
    expect(handler.isIgnoredPath("/healthz")).toBe(false);
  });

  // A fractional or negative hop count indexes nothing, so the forwarded header would
  // be ignored and every client would appear to be the proxy. Loud beats silent.
  it("refuses a hop count that could never select a hop", () => {
    for (const hops of [1.5, 0, -1, Number.NaN]) {
      expect(() => new BotHandler({ proxy: { trustProxy: true, hops } }), String(hops)).toThrow(ConfigError);
    }
    expect(() => new BotHandler({ proxy: { trustProxy: true, hops: 2 } })).not.toThrow();
  });
});
