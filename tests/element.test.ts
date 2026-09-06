import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { DASHBOARD_CSS, DASHBOARD_MARKUP, bootFor } from "../src/dashboard/page.js";
import { cellText, explainStatus, parseMount, resolveSections, shapeOf } from "../src/element/config.js";

/**
 * The pieces the embeddable element is built from.
 *
 * The element itself needs a DOM and is exercised by the browser suite; what can be
 * asserted here is that the page still hands it what it needs, which is the thing most
 * likely to break silently when somebody edits the page template.
 */
describe("the shared stylesheet and markup", () => {
  it("defines its tokens against a shadow host as well as a document", () => {
    // `:root` matches the document element and matches *nothing* inside a shadow tree, so
    // an element styled only against :root renders unthemed — no surface, no ink, no
    // accent. Every token block has to name :host too.
    expect(DASHBOARD_CSS).toContain(":root, :host {");
    expect(DASHBOARD_CSS).toContain(':host([data-theme="dark"])');
    expect(DASHBOARD_CSS).toContain(':host(:not([data-theme="light"]))');
  });

  it("carries the whole page's markup, and only the title as a placeholder", () => {
    for (const id of ['id="tab-live"', 'id="tab-actors"', 'id="tab-stats"', 'id="tab-policy"', 'id="view-live"', 'id="rows"', 'id="toasts"']) {
      expect(DASHBOARD_MARKUP, `the element renders this markup and needs ${id}`).toContain(id);
    }
    // The element substitutes this one itself; anything else appearing here would reach
    // the screen verbatim, which is how the header once read "__TITLE__".
    const placeholders = [...new Set(DASHBOARD_MARKUP.match(/__[A-Z_]+__/g) ?? [])];
    expect(placeholders).toEqual(["__TITLE__"]);
  });

  it("keeps no script in the markup, so the element can inject it separately", () => {
    expect(DASHBOARD_MARKUP).not.toContain("<script");
  });

  /**
   * The element asks for this over HTTP because it cannot be handed it at render time.
   * If the two ever disagree the embedded dashboard and the standalone page start
   * behaving differently, which is the kind of bug nobody looks for.
   */
  it("builds the same boot object the page stamps in", () => {
    const sections = { feed: true, evidence: true, actors: true, registry: true, tester: true, statistics: true, audit: true, notices: true, changes: true, policy: false, guard: true, robots: true, ranges: true };
    const boot = bootFor({
      title: "shop", basePath: "/_bots", links: [{ label: "Site", href: "/" }],
      allowReset: false, allowEdit: false, allowGuardEdit: false, allowActing: false,
      sections, peers: [],
    });
    expect(boot["base"]).toBe("/_bots");
    expect(boot["title"]).toBe("shop");
    expect((boot["sections"] as Record<string, boolean>)["policy"]).toBe(false);
    expect(boot["links"]).toEqual([{ label: "Site", href: "/" }]);
  });

  it("reports a root-mounted dashboard as an empty base, not as a slash", () => {
    // The client joins this onto every request path, so "/" would produce "//api/stats".
    const boot = bootFor({
      title: "x", basePath: "/", links: [], allowReset: false, allowEdit: false, allowGuardEdit: false, allowActing: false,
      sections: { feed: true, evidence: true, actors: true, registry: true, tester: true, statistics: true, audit: true, notices: true, changes: true, policy: true, guard: true, robots: true, ranges: true },
      peers: [],
    });
    expect(boot["base"]).toBe("");
  });
});

/**
 * Stylesheets carried in template literals.
 *
 * A backtick anywhere inside one ends it early and turns the rest of the file into syntax
 * errors thirty lines from the cause — or, with a second backtick to balance it, into CSS
 * that is quietly missing the middle. That has now happened five times in this codebase,
 * always in a comment where somebody quoted an identifier out of habit, and the fifth was
 * in `src/dashboard/page.ts`, which this guard did not cover because it was written for
 * the element alone. It covers both now: the trap belongs to the technique, not to a file.
 *
 * The interstitial is guarded separately by parsing its rendered script. These two are
 * compiled rather than rendered, so the check is on the source.
 */
describe("the embedded stylesheets", () => {
  const sources = [
    ["src/element/index.ts", readFileSync(new URL("../src/element/index.ts", import.meta.url), "utf8")],
    ["src/dashboard/page.ts", readFileSync(new URL("../src/dashboard/page.ts", import.meta.url), "utf8")],
  ] as const;
  const source = sources[0][1];

  it.each(sources)("has no backtick inside the CSS template literals of %s", (_name, text) => {
    // `String.raw` in one file and a plain literal in the other, so the tag is optional
    // here; what matters is where the literal starts and where the first backtick after it
    // is, which is exactly the question being asked.
    const blocks = [...text.matchAll(/const [A-Z_]+ = (?:String\.raw)?`([\s\S]*?)`;/g)].map((match) => match[1] ?? "");
    expect(blocks.length, "expected to find the template literals").toBeGreaterThan(0);
    for (const block of blocks) {
      expect(block, "a backtick here ends the literal and breaks the build").not.toContain("`");
    }
  });

  it("styles the host, because a shadow root has no body to style", () => {
    // Without this nothing sets the base colour or type and every element inherits the
    // host page's, which in dark mode was near-black text on a near-black surface.
    const host = /:host \{([\s\S]*?)\}/.exec(source)?.[1] ?? "";
    expect(host).toContain("color: var(--ink)");
    expect(host).toContain("background: var(--page)");
  });
});

/**
 * The module has to survive being imported where there is no DOM.
 *
 * Every framework with server rendering evaluates a top-level
 * `import { defineBotDashboard } from "@osqd/bothandlerjs/element"` on the server, which is
 * precisely the line the documentation tells people to write. `class X extends HTMLElement`
 * is evaluated at load, so on Node it threw `ReferenceError: HTMLElement is not defined`
 * before any of the caller's code ran — from a package whose `defineBotDashboard` was
 * already careful to do nothing without a `customElements` registry.
 *
 * The rest of this suite reads the element as *text*, and the browser suite runs it in a
 * browser; neither could see this, and it took packing the tarball and importing it from
 * outside the repository to find. So the check lives here, in the node-environment suite,
 * where the import itself is the assertion.
 */
describe("importing the element without a DOM", () => {
  it("does not throw, and defines nothing", async () => {
    // Loaded through a specifier TypeScript cannot follow, on purpose.
    // `tsconfig.typecheck.json` excludes `src/element` so that a stray `document` in the
    // rest of `src/` cannot pass a Node type-check, and a static import here would pull it
    // straight back into that project. What is being asserted is a *runtime* property —
    // that loading this module where there is no DOM does not throw — so asking at runtime
    // is both the accurate way to ask and the one that leaves the boundary intact.
    const specifier = "../src/element/index.js";
    const element = (await import(specifier)) as { defineBotDashboard: (name?: string) => void; BotDashboardElement: unknown };

    // Reaching this line at all is most of the test: the failure was at import.
    expect(typeof element.defineBotDashboard).toBe("function");
    expect(typeof element.BotDashboardElement).toBe("function");
    // And calling it on a server is a no-op rather than an error.
    expect(() => {
      element.defineBotDashboard();
      element.defineBotDashboard("ops-dashboard");
    }).not.toThrow();
  });
});

/**
 * What the element's published types drag in behind them.
 *
 * `src/element/index.ts` is compiled to a `.d.ts` that a front-end application reads, and
 * every `import type` in it is reproduced there. It used to take `DashboardSections` from
 * `dashboard/types.ts`, which imports `node:http` because it describes a request handler —
 * so a browser project type-checking its dependencies strictly was told to install
 * `@types/node` before it could say which panels it wanted. Found by packing the tarball
 * and compiling a browser app against it; kept honest here, where it is a one-line rule.
 */
describe("the element's type surface", () => {
  const source = readFileSync(new URL("../src/element/index.ts", import.meta.url), "utf8");

  it("takes nothing from a module that speaks Node", () => {
    const imports = [...source.matchAll(/^import[^;]*?from "([^"]+)";/gm)].map((match) => match[1] ?? "");
    expect(imports.length).toBeGreaterThan(0);
    // `dashboard/types.js` is the one that reaches `node:http`; the section names it used
    // to supply now live in a leaf of their own.
    expect(imports).not.toContain("../dashboard/types.js");
    expect(imports.some((from) => from.startsWith("node:"))).toBe(false);
  });
});

/**
 * The element's decisions, without a document.
 *
 * `src/element/` is excluded from the coverage report because it needs a browser — the
 * same call `src/dashboard/client/` gets, and for the same reason. That exclusion has
 * always carried a second half for the client: its pure modules are unit-tested here even
 * though they are not counted. The element copied the exclusion without the tests, and the
 * logic below is where two of this feature's bugs lived — a `hide` key from the wrong
 * vocabulary doing nothing in silence, and a screen the server withheld disappearing
 * without a word. Both were found in a browser, which is a slow way to find an argument
 * about an object.
 */
describe("resolving which screens exist", () => {
  const all = { feed: true, registry: true, statistics: true, policy: true, evidence: true };

  it("leaves everything alone when nothing asks otherwise", () => {
    const { sections, warnings } = resolveSections(all, {});
    expect(sections).toEqual(all);
    expect(warnings).toEqual([]);
  });

  it("switches off what `hide` names, by section name", () => {
    const { sections, warnings } = resolveSections(all, { hide: { feed: true } });
    expect(sections.feed).toBe(false);
    expect(sections.policy).toBe(true);
    expect(warnings).toEqual([]);
  });

  it("says which section a tab name in `hide` meant", () => {
    // `hide: { live: true }` is the natural thing to write after reading about `tabs`, and
    // it hides nothing: `live` is a screen and `hide` takes sections.
    const { sections, warnings } = resolveSections(all, { hide: { live: true } as never });
    expect(sections.feed).toBe(true);
    expect(warnings.join(" ")).toContain("hide.feed");
  });

  it("lists the real sections when `hide` names nothing at all", () => {
    const { warnings } = resolveSections(all, { hide: { nonsense: true } as never });
    expect(warnings.join(" ")).toContain("evidence");
    expect(warnings.join(" ")).toContain("did nothing");
  });

  it("keeps only the screens `tabs` lists", () => {
    const { sections } = resolveSections(all, { tabs: [{ id: "stats" }, { id: "live" }] });
    expect(sections.statistics).toBe(true);
    expect(sections.feed).toBe(true);
    expect(sections.registry).toBe(false);
    expect(sections.policy).toBe(false);
  });

  it("treats an empty `tabs` as no instruction rather than as none of them", () => {
    // Worth pinning down, because the other reading — an empty list meaning an empty
    // dashboard — is just as defensible and would be a silent change of behaviour.
    const { sections } = resolveSections(all, { tabs: [] });
    expect(sections).toEqual(all);
  });

  it("names a screen in `tabs` that does not exist", () => {
    const { warnings } = resolveSections(all, { tabs: [{ id: "stat" as never }] });
    expect(warnings.join(" ")).toContain('"stat"');
    expect(warnings.join(" ")).toContain("live, actors, stats, policy");
  });

  it("blames the server when the server is what withheld the screen", () => {
    const { sections, warnings } = resolveSections({ ...all, policy: false }, { tabs: [{ id: "live" }, { id: "policy" }] });
    expect(sections.policy).toBe(false);
    expect(warnings.join(" ")).toContain("createDashboardHandler");
  });

  it("stays quiet when the same screen was also hidden on purpose", () => {
    const { warnings } = resolveSections({ ...all, policy: false }, { tabs: [{ id: "live" }, { id: "policy" }], hide: { policy: true } });
    expect(warnings).toEqual([]);
  });

  it("lets `hide` win over `tabs` for a screen named by both", () => {
    const { sections } = resolveSections(all, { tabs: [{ id: "live" }, { id: "policy" }], hide: { policy: true } });
    expect(sections.feed).toBe(true);
    expect(sections.policy).toBe(false);
  });

  it("does not write back into the object it was handed", () => {
    const server = { ...all };
    resolveSections(server, { hide: { feed: true }, tabs: [{ id: "live" }] });
    expect(server).toEqual(all);
  });
});

describe("the rest of the element's arithmetic", () => {
  it("keeps the path of a src and drops what cannot survive concatenation", () => {
    expect(parseMount("/_bots").base).toBe("/_bots");
    expect(parseMount("/_bots/").base).toBe("/_bots");
    expect(parseMount("").base).toBe("");
    const query = parseMount("/_bots?token=x");
    expect(query.base).toBe("/_bots");
    expect(query.warning).toContain("query string");
    const fragment = parseMount("/_bots#top");
    expect(fragment.base).toBe("/_bots");
    expect(fragment.warning).toContain("fragment");
  });

  it("turns a refusal into something the reader can act on", () => {
    expect(explainStatus(401, "/_bots")).toContain("sign in once");
    expect(explainStatus(401, "")).toContain("the dashboard");
    expect(explainStatus(403, "/_bots")).toContain("allowedHosts");
    // Anything else is reported as itself rather than guessed at.
    expect(explainStatus(503, "/_bots")).toBe("it answered 503");
  });

  it("compares configs by what they describe, not by identity", () => {
    const make = (): { panels: [{ id: string; screen: "live"; title: string; source: () => { rows: [] } }] } => ({
      panels: [{ id: "p", screen: "live", title: "P", source: () => ({ rows: [] }) }],
    });
    // A framework hands over a fresh object with fresh closures on every render.
    expect(shapeOf(make())).toBe(shapeOf(make()));
    expect(shapeOf({ tabs: [{ id: "live" }] })).not.toBe(shapeOf({ tabs: [{ id: "stats" }] }));
  });

  it("renders a cell as text, bounded", () => {
    expect(cellText("hi")).toBe("hi");
    expect(cellText(12)).toBe("12");
    expect(cellText(false)).toBe("false");
    expect(cellText(null)).toBe("");
    expect(cellText(undefined)).toBe("");
    expect(cellText("x".repeat(500))).toHaveLength(200);
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    expect(cellText(circular)).toBe("");
  });
});
