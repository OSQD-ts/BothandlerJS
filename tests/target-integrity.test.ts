import { describe, expect, it } from "vitest";
import { createFacts } from "../src/index.js";
import { targetIntegrityDetector } from "../src/detectors/target-integrity.js";
import { makeContext } from "./helpers.js";
import type { Evidence } from "../src/types.js";

/**
 * How a target was spelled, which normalisation destroys.
 *
 * Half of these are the ones it must stay quiet on, and that is the harder half. A path
 * with a percent-encoded space in it, a trailing slash, an application's own link with a
 * URL encoded into a segment — all of them survive `createFacts` looking different from
 * how they arrived, which is the only thing this detector has to go on. If presence of a
 * difference were the signal, this would report a large share of the ordinary web.
 */
const HEADERS = {
  host: "shop.test",
  "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml",
};

/** The detector reads `rawPath`, which `makeContext` does not build — so hand it the real facts. */
const on = (url: string, options?: { reportPlainTraversal?: boolean }): Evidence | undefined => {
  const facts = createFacts({ method: "GET", url, headers: HEADERS, ip: "203.0.113.4" });
  const ctx = makeContext({ headers: HEADERS });
  return targetIntegrityDetector(options ?? {}).inspect({ ...ctx, facts }) as Evidence | undefined;
};

describe("targets that were spelled to get past something", () => {
  /**
   * The case the whole detector exists for. Normalisation resolves the dots, so what
   * every other detector sees is `/app/config.yml` — a page nobody has, on no wordlist,
   * indistinguishable from a broken link.
   */
  it("sees an encoded traversal that normalisation has already tidied away", () => {
    const facts = createFacts({ method: "GET", url: "/%2e%2e%2f%2e%2e%2fapp/config.yml", headers: HEADERS, ip: "203.0.113.4" });
    expect(facts.path, "which is why nothing else can see it").toBe("/app/config.yml");

    const evidence = on("/%2e%2e%2f%2e%2e%2fapp/config.yml");
    expect(evidence?.certainty).toBe("strong");
    expect(evidence?.botClass).toBe("scanner");
    expect(evidence?.summary).toContain("percent-encoding");
  });

  it("sees encoding applied twice", () => {
    const evidence = on("/static/%252e%252e%252fetc/passwd");
    expect(evidence?.certainty).toBe("strong");
    expect(evidence?.summary).toContain("encoded its own encoding");
  });

  it("sees a request addressed to a proxy", () => {
    const evidence = on("http://scanner.example/check");
    expect(evidence?.certainty).toBe("strong");
    expect(evidence?.summary).toContain("addressed to a proxy");
  });

  it("sees a control character, encoded or raw", () => {
    expect(on("/a%00b")?.summary).toContain("control character");
    expect(on("/a%0db%0ac")?.summary).toContain("control character");
    expect(on("/a%09b"), "a tab, which the first version of the character class quietly left out").toBeDefined();
  });

  it("sees a separator hidden inside a segment, and says so more quietly", () => {
    const evidence = on("/files/one%2ftwo");
    expect(evidence?.certainty, "not a traversal — a path pretending to be shorter than it is").toBe("moderate");
    expect(evidence?.summary).toContain("hid a path separator");
  });

  /** A broken relative link produces this, which is why it is the one with a switch. */
  it("reports a plainly written traversal at a lower tier, and can be told not to", () => {
    expect(on("/../../etc/passwd")?.certainty).toBe("moderate");
    expect(on("/../../etc/passwd", { reportPlainTraversal: false })).toBeUndefined();
  });

  it("names every way one target was spelled, in one piece of evidence", () => {
    const evidence = on("/%252e%252e%252f%252e%252e%252fetc/passwd");
    expect(evidence?.summary).toContain("encoded its own encoding");
    // One act seen twice, so one family and one piece of evidence rather than two.
    expect(evidence?.family).toBe("evasive-target");
  });
});

describe("targets that are merely spelled differently", () => {
  /**
   * The false positives this would have if the mere existence of a difference were the
   * signal. Every one of these leaves `rawPath` set.
   */
  it("says nothing about ordinary targets that normalisation still changed", () => {
    for (const url of [
      "/products/",                                   // a trailing slash
      "/search/a%20b",                                // a space in a segment
      "/caf%C3%A9/menu",                              // a non-ASCII name
      "/a//b",                                        // a doubled slash from a template
      "/./current",                                   // a dot segment from a path join
      "/files/report%2Epdf",                          // an encoded dot that is not a traversal
    ]) {
      expect(on(url), url).toBeUndefined();
    }
  });

  /**
   * The application's own link, and the reason none of this is `certain`.
   *
   * A URL carried as data inside a path is encoded once to sit there, and encoded again
   * by whatever built the link around it. It produces exactly the characters a
   * double-encoding check looks for, honestly, on a site that has done nothing wrong.
   */
  it("does report a link carrying an encoded URL — at a tier that cannot close a door", () => {
    const evidence = on("/redirect/https%253A%252F%252Fexample.com%252Fa");
    expect(evidence?.certainty, "strong is the ceiling, and strong alone denies nobody").toBe("strong");
    expect(evidence?.certainty).not.toBe("certain");
  });

  it("says nothing when the target survived normalisation untouched", () => {
    for (const url of ["/", "/products/42", "/a/b/c.html", "/search?q=shoes"]) {
      const facts = createFacts({ method: "GET", url, headers: HEADERS, ip: "203.0.113.4" });
      expect(facts.rawPath, url).toBeUndefined();
      expect(on(url), url).toBeUndefined();
    }
  });
});
