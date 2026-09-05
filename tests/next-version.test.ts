import { describe, expect, it } from "vitest";
// @ts-expect-error — a plain .mjs script, deliberately not part of the published build.
import { bumpVersion, classify } from "../scripts/next-version.mjs";

/**
 * The rules that decide what the world gets.
 *
 * Every push to `main` runs this and publishes whatever it says, so a mistake here is
 * not a broken build — it is a wrong version on a registry that cannot take it back. The
 * expensive direction is under-reporting: a `feat` read as a patch ships a feature as a
 * bug fix, and nobody on a caret range finds out.
 */
describe("what a commit does to the version", () => {
  it("reads the conventional types", () => {
    expect(classify("feat: add a detector")).toBe("minor");
    expect(classify("feat(engine): add a detector")).toBe("minor");
    expect(classify("fix: stop clipping the feed")).toBe("patch");
    expect(classify("fix(dashboard): stop clipping the feed")).toBe("patch");
    expect(classify("perf: stop hashing on every request")).toBe("patch");
  });

  it("releases nothing for work that changes nothing for a consumer", () => {
    for (const message of ["docs: explain the guard", "ci: publish from main", "test: cover the browser", "chore: tidy", "build: add a ratchet", "refactor: rename a local", "style: reformat"]) {
      expect(classify(message), message).toBe("none");
    }
  });

  it("takes a bang as breaking, wherever the type is", () => {
    expect(classify("feat!: rename every export")).toBe("major");
    expect(classify("fix!: reject a config that used to be accepted")).toBe("major");
    expect(classify("refactor(policy)!: drop a rule field")).toBe("major");
  });

  it("takes the footer form as breaking too", () => {
    // The `!` does not always fit in a subject line, and the footer is the form the
    // specification requires tooling to honour.
    expect(classify("feat: rework the guard\n\nBREAKING CHANGE: fallbackAction is now validated")).toBe("major");
    expect(classify("fix: tighten it\n\nBREAKING-CHANGE: with a hyphen, as the spec also allows")).toBe("major");
  });

  it("ignores a message that is not conventional at all", () => {
    expect(classify("Initial commit: bot detection with evidence tiering")).toBe("none");
    expect(classify("wip")).toBe("none");
    expect(classify("")).toBe("none");
  });

  /**
   * A declaration is a footer, not a mention.
   *
   * The match is deliberately liberal — any body line *starting* `BREAKING CHANGE:`
   * counts, rather than only the last paragraph — and the asymmetry is on purpose. A
   * false positive publishes a larger version than the change deserved, which is
   * untidy. A false negative ships a breaking change as a patch to everyone on a caret
   * range, which is somebody's outage. When only one of those can happen, it should be
   * the first.
   */
  it("reads the footer form, and not the words in passing", () => {
    expect(classify("docs: explain the spec\n\nBREAKING CHANGE: is how you declare one")).toBe("major");
    // Subject lines do not count: the specification puts the declaration in a footer.
    expect(classify("docs: describe what a BREAKING CHANGE: footer means")).toBe("none");
    expect(classify("docs: say that a breaking change bumps the minor while we are 0.x")).toBe("none");
  });
});

describe("applying a bump", () => {
  it("moves the part it says it moves", () => {
    expect(bumpVersion("1.4.2", "patch")).toBe("1.4.3");
    expect(bumpVersion("1.4.2", "minor")).toBe("1.5.0");
    expect(bumpVersion("1.4.2", "major")).toBe("2.0.0");
    expect(bumpVersion("1.4.2", "none")).toBe("1.4.2");
  });

  /**
   * 1.0.0 is a claim that the API is stable, and it should be made on purpose. While the
   * major is 0, a breaking change lands on the minor — which is what SemVer says 0.x is
   * for — rather than having a stray `!` in a subject line announce stability.
   */
  it("keeps a breaking change inside 0.x", () => {
    expect(bumpVersion("0.2.0", "major")).toBe("0.3.0");
    expect(bumpVersion("0.2.0", "minor")).toBe("0.3.0");
    expect(bumpVersion("0.2.0", "patch")).toBe("0.2.1");
    expect(bumpVersion("1.0.0", "major")).toBe("2.0.0");
  });

  it("drops a prerelease suffix rather than carrying it forward", () => {
    expect(bumpVersion("0.3.0-rc.1", "patch")).toBe("0.3.1");
  });
});
