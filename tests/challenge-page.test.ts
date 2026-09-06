import { describe, expect, it } from "vitest";
import vm from "node:vm";
import { renderChallengePage } from "../src/challenge/page.js";

/**
 * The interstitial's inline script, parsed.
 *
 * The page is built inside a template literal, which has a failure mode with real teeth:
 * a single backtick anywhere in the embedded JavaScript — in a comment, in a string, in a
 * regular expression — ends the literal early and turns the rest of the file into
 * markup. It has happened three times while this page was being written, and each time
 * the symptom was a TypeScript parse error thirty lines away from the cause.
 *
 * Type-checking does catch it, eventually and confusingly. This catches it in the terms
 * that matter: the script the public is served either parses as JavaScript or it does
 * not. It also catches the subtler version, where the literal survives but an
 * interpolation lands somewhere it should not.
 */
function scriptOf(html: string): string {
  const match = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html);
  expect(match, "the page should carry exactly one inline script").not.toBeNull();
  return (match as RegExpExecArray)[1] as string;
}

const BASE = { challenge: "eyJ2IjoxfQ.signature", difficulty: 8, verifyPath: "/__bothandler/verify" };

describe("the interstitial's inline script", () => {
  for (const [label, options] of [
    ["the plain page", BASE],
    ["with the interaction challenge", { ...BASE, interaction: true }],
    ["with contact copy and a translation", { ...BASE, interaction: true, lang: "ja", title: "確認中", message: "少々お待ちください", contactHtml: '<p><a href="mailto:a@b.test">help</a></p>' }],
  ] as const) {
    it(`parses as JavaScript — ${label}`, () => {
      const source = scriptOf(renderChallengePage(options).html);
      expect(source.trim().length).toBeGreaterThan(100);
      // Parse without running: the script talks to a DOM that does not exist here.
      expect(() => new vm.Script(source)).not.toThrow();
    });
  }

  it("closes its own template literal, so nothing leaks into the markup", () => {
    const html = renderChallengePage({ ...BASE, interaction: true }).html;
    // A truncated literal shows up as JavaScript escaping into the document body, or as
    // markup escaping into the script.
    expect(html).toMatch(/<\/script>\s*<\/body>\s*<\/html>\s*$/);
    expect(scriptOf(html)).not.toContain("<body");
  });

  it("interpolates the challenge into the config rather than into the markup", () => {
    const source = scriptOf(renderChallengePage({ ...BASE, interaction: true }).html);
    expect(source).toContain("eyJ2IjoxfQ.signature");
    expect(source).toContain('"interaction":true');
  });

  /** The copy is operator-supplied and could contain anything, including a backtick. */
  it("survives copy that would end the literal", () => {
    const nasty = renderChallengePage({ ...BASE, interaction: true, title: "a ` backtick", message: "and ${an.interpolation}", contactHtml: "<p>`${x}`</p>" });
    expect(() => new vm.Script(scriptOf(nasty.html))).not.toThrow();
    // Escaped into text rather than executed.
    expect(nasty.html).toContain("a ` backtick");
  });
});
