import { describe, expect, it } from "vitest";
// @ts-expect-error — a plain .mjs script, deliberately not part of the published build.
import { bumpVersion, classify, declaredRelease, isForwards } from "../scripts/next-version.mjs";

/**
 * The rules that decide what the world gets.
 *
 * Every push to `main` runs this and publishes whatever it says, so a mistake here is
 * not a broken build — it is a wrong version on a registry that cannot take it back.
 *
 * The expensive direction is at the top of the scale. A feature going out as a patch is a
 * number that undersells itself and costs nobody anything; a *breaking change* going out
 * as one breaks whoever is on a caret range, with no warning and no way to withdraw it.
 * That is why `feat` is deliberately a patch here and `!` is deliberately not.
 */
describe("what a commit does to the version", () => {
  /**
   * A feature is a patch, which is not what Conventional Commits says and is deliberate.
   *
   * This repository publishes on every push. Under the usual rule a fortnight of ordinary
   * work is a fortnight of minor bumps, and the version ends up measuring how often
   * somebody pushed rather than anything about the library. The smallest bump that still
   * publishes is the default; a minor is claimed out loud with `Release-As: minor` on the
   * commit that earns it.
   */
  it("reads the conventional types, with a feature landing on the patch", () => {
    expect(classify("feat: add a detector")).toBe("patch");
    expect(classify("feat(engine): add a detector")).toBe("patch");
    expect(classify("fix: stop clipping the feed")).toBe("patch");
    expect(classify("fix(dashboard): stop clipping the feed")).toBe("patch");
    expect(classify("perf: stop hashing on every request")).toBe("patch");
  });

  it("still lets a minor be asked for outright", () => {
    // The escape hatch that makes the default safe to lower: nothing about a real minor
    // release became impossible, it just has to be said rather than inferred.
    expect(declaredRelease("feat: the shape of the thing changed\n\nRelease-As: minor")).toEqual({ kind: "bump", value: "minor" });
    expect(bumpVersion("0.11.0", "minor")).toBe("0.12.0");
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

/**
 * Saying the version outright.
 *
 * The derived rules cover what the commits imply, and some releases are not implied by
 * anything: 1.0.0 is a decision about stability rather than a consequence of a `feat`,
 * and a docs-only push sometimes has to ship because the last one went out with the
 * wrong README. A `Release-As:` footer says so.
 *
 * The asymmetry here runs the opposite way to `BREAKING CHANGE:` above, and deliberately.
 * There, a false positive publishes a bigger number than deserved and a false negative is
 * somebody's outage, so the match is liberal. Here, a missed override publishes the
 * version the commits implied — merely not what was asked for — while a spurious one
 * publishes a number nobody chose. So this match is strict, and anything unreadable stops
 * the release rather than being ignored.
 */
describe("declaring a version outright", () => {
  it("reads an exact version from a footer", () => {
    expect(declaredRelease("feat: stabilise the API\n\nRelease-As: 1.0.0")).toEqual({ kind: "version", value: "1.0.0" });
    expect(declaredRelease("fix: patch it\n\nRelease-as: 0.9.1")).toEqual({ kind: "version", value: "0.9.1" });
    expect(declaredRelease("fix: patch it\n\nRelease-As:2.3.4")).toEqual({ kind: "version", value: "2.3.4" });
    expect(declaredRelease("feat: cut a candidate\n\nRelease-As: 1.0.0-rc.1")).toEqual({ kind: "version", value: "1.0.0-rc.1" });
  });

  it("reads a named bump", () => {
    expect(declaredRelease("docs: fix the README\n\nRelease-As: patch")).toEqual({ kind: "bump", value: "patch" });
    expect(declaredRelease("fix: small\n\nRelease-As: MINOR")).toEqual({ kind: "bump", value: "minor" });
  });

  it("says nothing when no commit declares anything", () => {
    expect(declaredRelease("feat: an ordinary feature")).toBeUndefined();
    expect(declaredRelease("fix: with a body\n\nExplaining what it does.")).toBeUndefined();
  });

  /** Describing the mechanism must not invoke it — the same trap the breaking-change match avoids. */
  it("does not fire on a subject line that mentions it", () => {
    expect(declaredRelease("docs: explain Release-As: 1.0.0 in the release guide")).toBeUndefined();
    expect(declaredRelease("chore: rename Release-As: to something else")).toBeUndefined();
  });

  /**
   * Reported rather than ignored, so the caller can refuse the release. Falling back to
   * the derived number would publish *something*, which is exactly the outcome that hides
   * the mistake: a plausible tag goes out and the version somebody asked for never does.
   */
  it("marks an unreadable declaration rather than dropping it", () => {
    expect(declaredRelease("feat: x\n\nRelease-As: banana")).toEqual({ kind: "invalid", value: "banana" });
    expect(declaredRelease("feat: x\n\nRelease-As: 1.0")).toEqual({ kind: "invalid", value: "1.0" });
    expect(declaredRelease("feat: x\n\nRelease-As: v1.0.0")).toEqual({ kind: "invalid", value: "v1.0.0" });
    expect(declaredRelease("feat: x\n\nRelease-As: 01.0.0")).toEqual({ kind: "invalid", value: "01.0.0" });
  });
});

describe("a release has to move forwards", () => {
  it("accepts a version ahead of the current one", () => {
    expect(isForwards("0.8.0", "0.8.1")).toBe(true);
    expect(isForwards("0.8.0", "0.9.0")).toBe(true);
    expect(isForwards("0.8.0", "1.0.0")).toBe(true);
    expect(isForwards("0.8.0", "0.9.0-rc.1")).toBe(true);
  });

  /**
   * A published version is immutable, so going backwards or standing still is not a
   * smaller release — it is one the registry will refuse after the tag has been pushed.
   */
  it("refuses one that is not", () => {
    expect(isForwards("0.8.0", "0.8.0")).toBe(false);
    expect(isForwards("0.8.0", "0.7.9")).toBe(false);
    expect(isForwards("1.0.0", "0.9.9")).toBe(false);
    // A prerelease sorts below its own release, so this is a step back.
    expect(isForwards("0.8.0", "0.8.0-rc.1")).toBe(false);
  });

  it("refuses anything it cannot read as a version", () => {
    expect(isForwards("0.8.0", "banana")).toBe(false);
    expect(isForwards("banana", "0.9.0")).toBe(false);
  });
});
