import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { BotHandler, ChallengeService, createFacts } from "../../src/index.js";
import type { Browser, Page } from "playwright";
import type { DashboardServer } from "../../src/index.js";

/**
 * The dashboard page, in a real browser.
 *
 * Everything else in this repo can be tested by calling a function. This file cannot:
 * the page is two thousand lines of DOM work whose whole job is to behave correctly
 * under a keyboard, a scroll and a narrow viewport, and none of those exist in Node.
 * Until this file was written the page's coverage was string matching — "the source
 * contains the word ArrowRight" — which passes just as happily against a handler
 * wired to the wrong element.
 *
 * Kept out of `npm test` on purpose. It needs a browser binary that a fresh checkout
 * does not have, and a suite that fails until you run `npx playwright install` is a
 * suite people learn to ignore. `npm run test:browser` runs it; CI runs it in a job
 * that installs the browser first.
 */

let browser: Browser;
let dashboard: DashboardServer;
/** A second listener over the same handler, with sections switched off. See below. */
let analyst: DashboardServer;
let handler: BotHandler;
let url: string;

const CLIENTS: ReadonlyArray<readonly [string, string, string]> = [
  ["curl/8.4.0", "203.0.113.10", "/api/items"],
  ["python-requests/2.32.3", "203.0.113.11", "/products"],
  ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36", "198.51.100.20", "/"],
  ["Mozilla/5.0 (compatible; GPTBot/1.0; +https://openai.com/gptbot)", "198.51.100.30", "/products"],
  ["Go-http-client/2.0", "203.0.113.12", "/api/items"],
];

beforeAll(async () => {
  handler = new BotHandler({ preset: "protect-content", metrics: { perDetectorTiming: true } });
  dashboard = await handler.serveDashboard({
    port: 0,
    title: "acme-shop",
    controls: { reset: true, editPolicy: true, editGuard: true, editRanges: true },
    links: [
      { label: "Site", href: "http://localhost:3000/" },
      { label: "Runbook", href: "http://localhost:3001/" },
    ],
  });
  url = dashboard.url;
  // What a role with less to see gets. The server-side half of this is covered in
  // `tests/dashboard.test.ts`; what needs a browser is that the page removes what it
  // was not given rather than rendering empty panels or throwing on the way past them.
  analyst = await handler.serveDashboard({
    port: 0,
    title: "analyst",
    sections: { evidence: false, policy: false, audit: false },
  });
  // Enough rows that the feed is longer than the viewport, which is the only state in
  // which a sticky header means anything.
  for (let i = 0; i < 40; i++) {
    const client = CLIENTS[i % CLIENTS.length]!;
    await handler.handle(
      createFacts({
        method: "GET",
        url: client[2],
        headers: { host: "acme.example", "user-agent": client[0], accept: "*/*" },
        ip: client[1],
        protocol: "https",
        httpVersion: "1.1",
      }),
    );
  }
  browser = await chromium.launch();
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await analyst?.close();
  await dashboard?.close();
});

async function open(width = 1440, hash = "", settled = ""): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.goto(url.replace(/\/$/, "/") + hash);
  // Wait for whichever view this page is going to land on. The feed's rows are only
  // drawn while the live tab is showing, so a deep link to another view would sit
  // here forever waiting for a row that is never built.
  if (settled === "") await page.waitForSelector("tbody tr.row");
  else await page.waitForSelector(settled + ":not([hidden])");
  return page;
}

describe("moving between views", () => {
  it("switches with the arrow keys, which is what its tablist role promises", async () => {
    const page = await open();
    await page.locator("#tab-live").focus();
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => page.locator("#tab-actors").getAttribute("aria-selected")).toBe("true");
    await expect.poll(() => page.locator("#view-actors").isVisible()).toBe(true);

    await page.keyboard.press("End");
    await expect.poll(() => page.locator("#tab-policy").getAttribute("aria-selected")).toBe("true");
    await page.keyboard.press("Home");
    await expect.poll(() => page.locator("#tab-live").getAttribute("aria-selected")).toBe("true");
    await page.close();
  });

  /** Tab should step past the strip into the panel, not through every tab on the way. */
  it("keeps exactly one tab in the tab order", async () => {
    const page = await open();
    const order = (): Promise<number[]> => page.locator(".tab").evaluateAll((tabs) => tabs.map((tab) => (tab as HTMLElement).tabIndex));
    expect(await order()).toEqual([0, -1, -1, -1]);
    await page.locator("#tab-stats").click();
    expect(await order()).toEqual([-1, -1, 0, -1]);
    await page.close();
  });

  it("puts the view in the URL and comes back with the back button", async () => {
    const page = await open();
    await page.locator("#tab-policy").click();
    await expect.poll(() => new URL(page.url()).hash).toBe("#policy");

    await page.goBack();
    await expect.poll(() => page.locator("#view-live").isVisible()).toBe(true);
    await page.goForward();
    await expect.poll(() => page.locator("#view-policy").isVisible()).toBe(true);
    await page.close();
  });

  it("opens on the view a link names", async () => {
    const page = await open(1440, "#stats", "#view-stats");
    await expect.poll(() => page.locator("#view-stats").isVisible()).toBe(true);
    expect(await page.locator("#tab-stats").getAttribute("aria-selected")).toBe("true");
    await page.close();
  });

  it("takes a digit as a shortcut to a view", async () => {
    const page = await open();
    await page.keyboard.press("4");
    await expect.poll(() => page.locator("#view-policy").isVisible()).toBe(true);
    await page.keyboard.press("2");
    await expect.poll(() => page.locator("#view-actors").isVisible()).toBe(true);
    await page.keyboard.press("1");
    await expect.poll(() => page.locator("#view-live").isVisible()).toBe(true);
    await page.close();
  });
});

describe("the feed without a mouse", () => {
  /**
   * The row's disclosure is a real button inside the first cell rather than the row
   * wearing `role="button"`. The row carried the actor link inside it, and a control
   * nested in a control leaves a screen reader with two things to announce and no way
   * to say which one Enter belongs to. Clicking the row still opens it — a click is a
   * convenience, not a contract.
   */
  it("opens a row's evidence on Enter and keeps the focus there", async () => {
    const page = await open();
    const first = page.locator("tbody tr.row .row-toggle").first();
    await first.focus();
    expect(await first.getAttribute("aria-expanded")).toBe("false");

    await page.keyboard.press("Enter");
    await expect.poll(() => page.locator("tr.detail").count()).toBe(1);
    // The row is a new node after the redraw; focus has to survive it or a keyboard
    // user is dumped back at the top of the document on every open.
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-request"))).toBeTruthy();
    expect(await page.evaluate(() => document.activeElement?.className)).toContain("row-toggle");
    expect(await page.locator("tbody tr.row .row-toggle").first().getAttribute("aria-expanded")).toBe("true");
    await page.close();
  });

  it("still opens on a click anywhere in the row", async () => {
    const page = await open();
    await page.locator("tbody tr.row td.edge").first().click();
    await expect.poll(() => page.locator("tr.detail").count()).toBe(1);
    await page.close();
  });

  it("opens on Space without scrolling the page", async () => {
    const page = await open();
    await page.locator("tbody tr.row .row-toggle").first().focus();
    const before = await page.evaluate(() => scrollY);
    await page.keyboard.press(" ");
    await expect.poll(() => page.locator("tr.detail").count()).toBe(1);
    expect(await page.evaluate(() => scrollY)).toBe(before);
    await page.close();
  });

  it("jumps to the filter on / and clears it on Escape", async () => {
    const page = await open();
    await page.keyboard.press("/");
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("search");

    await page.keyboard.type("products");
    await expect.poll(() => page.locator("tbody tr.row").count()).toBeLessThan(40);

    await page.keyboard.press("Escape");
    await expect.poll(() => page.locator("#search").inputValue()).toBe("");
    await page.close();
  });

  it("closes an open row on Escape", async () => {
    const page = await open();
    await page.locator("tbody tr.row").first().click();
    await expect.poll(() => page.locator("tr.detail").count()).toBe(1);
    await page.locator("body").press("Escape");
    await expect.poll(() => page.locator("tr.detail").count()).toBe(0);
    await page.close();
  });

  /**
   * Asserted as "first in the tab order, visible once focused, and it goes where it
   * says" rather than by pressing Tab from the top of the document. Chrome's
   * sequential-navigation starting point after a fresh load is not reliably the
   * document start in headless, so a Tab-from-body test measures the harness rather
   * than the page — Shift+Tab from the next control does reach it, which is the
   * property that matters.
   */
  it("offers a way past the header to a keyboard", async () => {
    const page = await open();

    const order = await page.evaluate(() => {
      const focusable = [...document.querySelectorAll<HTMLElement>("a[href], button, input, [tabindex]")];
      return focusable.filter((node) => node.tabIndex >= 0).map((node) => node.className);
    });
    expect(order[0], "the skip link must come before every control it exists to skip").toContain("skip");

    // Clipped to its borders until reached, rather than moved off-screen — an element
    // whose box is outside the viewport is dropped from the tab order altogether.
    expect(await page.locator(".skip").evaluate((node) => node.getBoundingClientRect().width)).toBeLessThanOrEqual(2);
    await page.locator(".skip").focus();
    await expect.poll(() => page.locator(".skip").evaluate((node) => node.getBoundingClientRect().width)).toBeGreaterThan(50);

    // Reverse navigation from the first real control lands on it, which is the same
    // edge of the tab order seen from the other side.
    await page.locator(".head-links a").first().focus();
    await page.keyboard.press("Shift+Tab");
    expect(await page.evaluate(() => document.activeElement?.className)).toContain("skip");

    await page.keyboard.press("Enter");
    await expect.poll(() => new URL(page.url()).hash).toBe("#view-live");
    await page.close();
  });
});

/**
 * The header, which was the weakest part of the page.
 *
 * Its top row was pinned to a fixed 54px with children that refused to shrink, so on
 * a narrow window the title and the live indicator drew on top of each other. And the
 * feed's column headers were anchored to a hard-coded offset that had never been
 * right — and, because the panel around them was a scroll container, never applied.
 */
describe("the header", () => {
  it("holds the column headers below itself when the feed scrolls", async () => {
    const page = await open();
    const headerHeight = (await page.locator("header").boundingBox())?.height ?? 0;
    expect(headerHeight).toBeGreaterThan(54);

    // The first *visible* header cell, not the first one in the markup: which columns
    // the feed shows depends on how wide the panel is, and this test is about sticky
    // positioning rather than about the column ladder. Selecting `th` blindly made it
    // fail the moment a threshold moved, reporting a broken header when the truth was
    // that the Time column had been dropped and had no box to measure.
    const heading = page.locator("thead th:visible").first();
    const resting = (await heading.boundingBox())?.y ?? 0;
    expect(resting).toBeGreaterThan(headerHeight);

    await page.evaluate(() => scrollTo(0, 600));
    await page.waitForTimeout(120);
    const stuck = (await heading.boundingBox())?.y ?? 0;
    // Pinned exactly under the header — not at 0, where the header would cover it,
    // and not scrolled away with the rows.
    expect(stuck).toBeCloseTo(headerHeight, 0);
    await page.close();
  });

  it("measures the header rather than trusting a constant", async () => {
    const page = await open();
    const measured = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--header-h").trim());
    const actual = (await page.locator("header").boundingBox())?.height ?? 0;
    expect(Number.parseFloat(measured)).toBeCloseTo(actual, 0);
    await page.close();
  });

  it("wraps instead of overlapping when the window is narrow", async () => {
    for (const width of [1440, 1024, 860, 720, 560, 420]) {
      const page = await open(width);
      const boxes = await page.evaluate(() => {
        const rect = (selector: string) => {
          const node = document.querySelector(selector);
          return node ? node.getBoundingClientRect().toJSON() : null;
        };
        return { brand: rect(".brand"), live: rect(".live"), actions: rect(".head-actions") };
      });
      const overlaps = (a: DOMRect | null, b: DOMRect | null): boolean =>
        a !== null && b !== null && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
      expect(overlaps(boxes.brand as DOMRect | null, boxes.live as DOMRect | null), `brand and live overlap at ${width}px`).toBe(false);
      expect(overlaps(boxes.live as DOMRect | null, boxes.actions as DOMRect | null), `live and actions overlap at ${width}px`).toBe(false);
      await page.close();
    }
  });

  /** Status is not a control. Five bordered pills that did nothing sat beside five that did. */
  it("does not dress its configuration facts as buttons", async () => {
    const page = await open();
    expect(await page.locator(".facts button").count()).toBe(0);
    expect(await page.locator(".facts").innerText()).toMatch(/guard\s+strict/);
    // Label first, value second — "suspect at 60", not "60 suspect at".
    expect(await page.locator(".facts").innerText()).toMatch(/suspect at\s+\d+/);
    await page.close();
  });
});

describe("the page at any width", () => {
  it("never scrolls the document sideways", async () => {
    for (const width of [1440, 1080, 980, 860, 700, 560, 420]) {
      const page = await open(width);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `the page scrolls sideways at ${width}px`).toBeLessThanOrEqual(0);
      await page.close();
    }
  });

  /**
   * The feed table has a floor that no amount of shrinking gets under. It used to be
   * amputated by the panel; now the columns it can spare go first and what is left
   * scrolls inside its own box.
   */
  /**
   * The table is inside one column of a two-column grid, so what it has to fit inside
   * is the panel and not the window. A viewport breakpoint gets that wrong for every
   * width where the grid is still two columns — which is most desktops — and the
   * failure is silent: the panel clips, and the columns are simply not there. It has
   * been introduced twice now, once per column added.
   */
  it("never clips a column at any width; it drops one, then scrolls", async () => {
    for (const width of [2200, 1600, 1440, 1400, 1200, 1100, 1000, 900, 760, 600]) {
      const page = await open(width);
      const measured = await page.evaluate(() => {
        const wrap = document.querySelector(".feed-scroll") as HTMLElement;
        const table = wrap.querySelector("table") as HTMLElement;
        // The table stretches to fill, so its rendered width says nothing about what it
        // needs. Ask for the floor directly: below this, a column gets amputated.
        table.style.width = "min-content";
        const floor = table.scrollWidth;
        table.style.width = "";
        return { floor, room: wrap.clientWidth, scrolls: getComputedStyle(wrap).overflowX === "auto" };
      });
      expect(measured.floor <= measured.room || measured.scrolls, `at ${width}px the table is clipped`).toBe(true);

      /*
       * And it has to fit with something to spare. This assertion is the one that
       * matters, because the version without it passed on this machine by nine pixels
       * and failed on a CI runner whose default face is wider: the columns are sized in
       * glyphs, so a layout that fits exactly here fits nowhere else. Anything under
       * this margin is tuned to one font rather than laid out.
       */
      if (!measured.scrolls) {
        const slack = measured.room - measured.floor;
        expect(slack, `at ${width}px the table fits by only ${slack}px — too close to be true of any font but this one`).toBeGreaterThanOrEqual(16);
      }
      await page.close();
    }
  });

  it("lets the feed be reached rather than clipping it", async () => {
    for (const width of [420, 560, 700]) {
      const page = await open(width);
      const reach = await page.evaluate(() => {
        const wrap = document.querySelector(".feed-scroll") as HTMLElement;
        const table = document.querySelector("table") as HTMLElement;
        return { scrollable: getComputedStyle(wrap).overflowX === "auto", covered: wrap.scrollWidth >= table.scrollWidth };
      });
      expect(reach.scrollable, `the feed cannot be scrolled at ${width}px`).toBe(true);
      expect(reach.covered, `the feed is clipped at ${width}px`).toBe(true);
      await page.close();
    }
  });

  it("renders in both themes without losing its background", async () => {
    for (const scheme of ["light", "dark"] as const) {
      const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, colorScheme: scheme });
      await page.goto(url);
      await page.waitForSelector("tbody tr.row");
      const paint = await page.evaluate(() => ({
        body: getComputedStyle(document.body).backgroundColor,
        ink: getComputedStyle(document.body).color,
      }));
      expect(paint.body).not.toBe("rgba(0, 0, 0, 0)");
      expect(paint.ink).not.toBe(paint.body);
      await page.close();
    }
  });
});

/**
 * The feed as something you can read while it is moving.
 *
 * The old renderer emptied the table and rebuilt three hundred rows on every frame
 * that carried a request, which is why none of this worked: a selection was wiped
 * before you could copy it, and the row you were reading was a different node by the
 * time you looked back at it.
 */
describe("the live feed under load", () => {
  async function arrive(path: string): Promise<void> {
    await handler.handle(
      createFacts({
        method: "GET",
        url: path,
        headers: { host: "acme.example", "user-agent": "curl/8.4.0", accept: "*/*" },
        ip: "203.0.113.77",
        protocol: "https",
        httpVersion: "1.1",
      }),
    );
  }

  it("keeps the rows it already drew when a new request arrives", async () => {
    const page = await open();
    await page.evaluate(() => {
      // Mark the rows currently in the table. A rebuild throws the marks away with the
      // nodes; a keyed update keeps both.
      for (const row of Array.from(document.querySelectorAll("tbody tr.row"))) (row as HTMLElement).dataset["seen"] = "yes";
    });
    const before = await page.locator("tbody tr.row[data-seen]").count();
    await arrive("/api/fresh");
    await expect.poll(() => page.locator("tbody tr.row").count()).toBeGreaterThan(before);
    expect(await page.locator("tbody tr.row[data-seen]").count()).toBe(before);
    await page.close();
  });

  it("does not wipe a text selection out from under a reader", async () => {
    const page = await open();
    await page.evaluate(() => {
      const target = document.querySelector("tbody tr.row .ua");
      const range = document.createRange();
      range.selectNodeContents(target as Node);
      const selection = getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    });
    const selected = await page.evaluate(() => getSelection()?.toString() ?? "");
    expect(selected.length).toBeGreaterThan(0);

    await arrive("/api/during-selection");
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => getSelection()?.toString() ?? "")).toBe(selected);
    await page.close();
  });

  it("says when each request happened", async () => {
    const page = await open();
    const when = await page.locator("tbody tr.row td.when").first().innerText();
    expect(when).toMatch(/\d/);
    expect(await page.locator("#feed-window").innerText()).toMatch(/requests/);
    await page.close();
  });
});

/**
 * The filter, and where it lives.
 *
 * The view was already in the URL; the filter and the search are what make a screen
 * shareable — "look at the guard stops on /export" as a link rather than as
 * instructions — and what survives the refresh everybody reaches for when a live feed
 * looks stuck.
 */
describe("finding things in the feed", () => {
  it("narrows to a named field rather than matching anywhere", async () => {
    const page = await open();
    await page.locator("#search").fill("path:/products");
    await expect.poll(() => page.locator("tbody tr.row").count()).toBeGreaterThan(0);
    const paths = await page.locator("tbody tr.row td.req .row-toggle").allInnerTexts();
    expect(paths.every((text) => text.includes("/products"))).toBe(true);
    await page.close();
  });

  it("excludes with a leading dash", async () => {
    const page = await open();
    await page.locator("#search").fill("-path:/products");
    await page.waitForTimeout(200);
    const paths = await page.locator("tbody tr.row td.req .row-toggle").allInnerTexts();
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.some((text) => text.includes("/products"))).toBe(false);
    await page.close();
  });

  it("puts the filter and the search in the URL", async () => {
    const page = await open();
    await page.locator("#search").fill("path:/products");
    await page.locator(".filters button", { hasText: "Proven" }).click();
    await expect.poll(() => new URL(page.url()).hash).toContain("q=path");
    expect(new URL(page.url()).hash).toContain("f=proven");
    await page.close();
  });

  it("comes back the same way after a reload", async () => {
    const page = await open(1440, "#live?f=proven&q=path%3A%2Fproducts");
    expect(await page.locator("#search").inputValue()).toBe("path:/products");
    expect(await page.locator('.filters button[aria-pressed="true"]').innerText()).toBe("Proven");
    await page.close();
  });
});

/**
 * From a request to a rule.
 *
 * The row detail could already turn a request into a replay line and a corpus case —
 * the offline loop. This is the online one, and the three things it must not do are
 * more important than the one thing it does: it must not pick a terminal action, must
 * not apply anything, and must not put the rule anywhere it could shadow an existing
 * one.
 */
describe("drafting a rule from a request", () => {
  it("fills the editor, previews it, and applies nothing", async () => {
    const page = await open();
    await page.locator("tbody tr.row").first().click();
    await page.waitForSelector("tr.detail");
    const rulesBefore = handler.policy.ruleIds.length;

    await page.locator("tr.detail .tools button", { hasText: "Draft a rule" }).click();
    await expect.poll(() => new URL(page.url()).hash).toContain("policy");

    // Every rule the handler has, plus the draft — not the draft on its own, which is
    // what happens if the editor is filled before the policy document has loaded.
    await expect.poll(() => page.locator("#rulelist .rule").count()).toBe(rulesBefore + 1);
    expect(handler.policy.ruleIds.length).toBe(rulesBefore);

    const drafted = await page.locator("#rulelist .rule").last().locator('input[aria-label="Rule id"]').inputValue();
    expect(drafted.startsWith("from-")).toBe(true);
    const action = await page.locator("#rulelist .rule").last().locator("select").first().inputValue();
    expect(action).toBe("tag");
    await expect.poll(() => page.locator("#policy-result").innerText()).toContain("Nothing is applied");
    await page.close();
  });
});

/**
 * The guard, from the page.
 *
 * Behind `controls.editGuard`, which is off by default and separate from the rule
 * editor's flag. The form's job is to make the consequence legible before the click,
 * which is why the mode explains itself and why Preview is next to Apply.
 */
describe("the guard form", () => {
  it("explains what each mode means where the choice is made", async () => {
    const page = await open(1440, "#policy", "#view-policy");
    await expect.poll(() => page.locator("#stat-policy .seg button").count()).toBe(3);
    await page.locator("#stat-policy .seg button", { hasText: "aggressive" }).click();
    expect(await page.locator(".guard-explains").innerText()).toContain("The guard is off");
    await page.close();
  });

  it("does not offer a fallback the server would refuse", async () => {
    const page = await open(1440, "#policy", "#view-policy");
    const options = await page.locator("#stat-policy select").first().locator("option").allInnerTexts();
    expect(options).not.toContain("block");
    expect(options).not.toContain("drop");
    expect(options).toContain("challenge");
    await page.close();
  });

  it("previews a change against real traffic before it is made", async () => {
    const page = await open(1440, "#policy", "#view-policy");
    await page.locator("#stat-policy .seg button", { hasText: "balanced" }).click();
    await page.locator("#stat-policy .bar-actions button", { hasText: "Preview" }).click();
    await expect.poll(() => page.locator("#policy-result").innerText()).toContain("would be treated differently");
    expect(handler.policy.describeGuard().falsePositivePolicy).toBe("strict");
    await page.close();
  });

  it("applies it, and says out loud what changed", async () => {
    const page = await open(1440, "#policy", "#view-policy");
    await page.locator("#stat-policy .seg button", { hasText: "balanced" }).click();
    await page.locator("#stat-policy .bar-actions button", { hasText: "Apply" }).click();
    await expect.poll(() => handler.policy.describeGuard().falsePositivePolicy).toBe("balanced");
    await expect.poll(() => page.locator("#policy-result").innerText()).toContain("The guard changed");
    // Put back, so the tests after this one see the guard they expect.
    handler.updateGuard({ falsePositivePolicy: "strict" });
    await page.close();
  });
});

/**
 * The score distribution says which population it is drawing.
 *
 * It used to say "this window" beside panels that counted since the process started,
 * in the same grey subtitle — two populations, one label, on the chart people read
 * before moving a threshold.
 */
describe("the statistics screen's two windows", () => {
  it("draws the whole run by default, and says so", async () => {
    const page = await open(1440, "#stats", "#view-stats");
    expect(await page.locator("#score-window").innerText()).toBe("since start");
    await page.close();
  });

  it("switches to the retained window and says how much of it there is", async () => {
    const page = await open(1440, "#stats", "#view-stats");
    await page.locator("#score-scope button", { hasText: "this window" }).click();
    await expect.poll(() => page.locator("#score-window").innerText()).toMatch(/last \d+ requests/);
    await page.close();
  });

  it("says how much window every window-scoped panel is counting", async () => {
    const page = await open(1440, "#stats", "#view-stats");
    const labels = await page.locator("#view-stats .win").allInnerTexts();
    expect(labels.length).toBeGreaterThan(0);
    expect(labels.every((text) => /requests/.test(text))).toBe(true);
    await page.close();
  });
});

/**
 * A listener with sections switched off.
 *
 * `controls` says what a viewer may do; `sections` says what a viewer may see. The
 * distinction that matters is that a switched-off section is *gone* — the tab, the
 * panel and the data behind it — rather than hidden, so this drives the page rather
 * than reading the markup.
 */
describe("a dashboard with less on it", () => {
  async function openAnalyst(): Promise<Page> {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(analyst.url);
    await page.waitForSelector("tbody tr.row");
    return page;
  }

  it("has only the tabs it was given", async () => {
    const page = await openAnalyst();
    // No Policy: that section is off. Actors survives, because `sections.actors` is on
    // — a listener can perfectly well show who is hitting you without showing the
    // evidence trail that says how each of them was recognised.
    expect(await page.locator(".tabs .tab:not([hidden])").allInnerTexts()).toEqual(["Live feed", "Actors", "Statistics"]);
    await page.close();
  });

  it("removes the panels behind a switched-off section rather than emptying them", async () => {
    const page = await openAnalyst();
    expect(await page.locator("#audit-panel").count()).toBe(0);
    expect(await page.locator("#feed-export").isHidden()).toBe(true);
    await page.close();
  });

  it("says why a row has no evidence, and offers nothing that needs it", async () => {
    const page = await openAnalyst();
    await page.locator("tbody tr.row").first().click();
    await page.waitForSelector("tr.detail");
    expect(await page.locator("tr.detail").innerText()).toContain("evidence section is switched off");
    expect(await page.locator("tr.detail .tools button").allInnerTexts()).toEqual(["Show this actor"]);
    await page.close();
  });

  it("does not throw its way through a screen whose panels are missing", async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const problems: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") problems.push(message.text());
    });
    page.on("pageerror", (error) => problems.push(String(error)));
    await page.goto(analyst.url);
    await page.waitForSelector("tbody tr.row");
    await page.locator("#tab-stats").click();
    await page.waitForTimeout(400);
    expect(problems).toEqual([]);
    await page.close();
  });

  it("keeps the digit shortcuts pointing at the tabs it actually has", async () => {
    const page = await openAnalyst();
    // Four would be Policy on a whole dashboard. Here there is no fourth tab, so it
    // does nothing rather than landing on a screen this listener does not have.
    await page.keyboard.press("4");
    await page.waitForTimeout(150);
    expect(new URL(page.url()).hash).not.toContain("policy");
    await page.keyboard.press("3");
    await expect.poll(() => new URL(page.url()).hash).toContain("stats");
    await page.close();
  });
});

/**
 * The Actors screen.
 *
 * The feed holds requests; the registry holds clients. "Who is hitting me hardest right
 * now" is a question only the second can answer, and it had nowhere to be asked.
 */
describe("the actors screen", () => {
  it("lists who the registry is holding, busiest first", async () => {
    const page = await open(1440, "#actors", "#view-actors");
    await expect.poll(() => page.locator("#actor-rows tr").count()).toBeGreaterThan(0);
    const counts = await page.locator("#actor-rows tr td:nth-child(2)").allInnerTexts();
    const numbers = counts.map((text) => Number(text.replace(/[^\d]/g, "")));
    expect(numbers).toEqual([...numbers].sort((a, b) => b - a));
    await page.close();
  });

  /** Reuses the feed's own search, so the result is a shareable URL like any other view. */
  it("sends an actor to the feed as a filter", async () => {
    const page = await open(1440, "#actors", "#view-actors");
    await page.locator("#actor-rows tr").first().locator("button", { hasText: "In feed" }).click();
    await expect.poll(() => new URL(page.url()).hash).toContain("q=actor");
    await expect.poll(() => page.locator("#view-live").isVisible()).toBe(true);
    expect(await page.locator("#search").inputValue()).toMatch(/^actor:/);
    await page.close();
  });

  /**
   * An allowlisted address is not judged leniently — it is not judged at all. So the
   * button says the address it is about to exempt and waits for a second click. Not a
   * dialog: a confirmation you can dismiss without reading is a click with extra steps.
   */
  it("asks twice before allowlisting, and says what it is about to do", async () => {
    const page = await open(1440, "#actors", "#view-actors");
    const row = page.locator("#actor-rows tr").first();
    const key = (await row.locator("td.who").innerText()).trim();

    await row.locator("button", { hasText: "Allowlist" }).click();
    expect(await row.locator("button.danger").first().innerText()).toContain(key);
    expect(await row.locator("button.danger").first().innerText()).toContain("stops being assessed");
    expect(handler.isAllowlisted(key)).toBe(false);

    await row.locator("button.danger").first().click();
    await expect.poll(() => handler.isAllowlisted(key)).toBe(true);

    handler.updateRanges("allowlist", []);
    await page.close();
  });

  /**
   * The list refreshes every couple of seconds, and a refresh rebuilds every button in
   * it — including one somebody has half-pressed. An operator who clicked "Allowlist",
   * read the address it offered back and reached for the second click could have the
   * button reset under their cursor, so the second click armed it again rather than
   * doing anything. Which teaches people that the way through a confirmation is to
   * click it twice, fast.
   */
  it("holds the list still while a confirmation is waiting for its second click", async () => {
    const page = await open(1440, "#actors", "#view-actors");
    const row = page.locator("#actor-rows tr").first();
    const key = (await row.locator("td.who").innerText()).trim();
    await row.locator("button", { hasText: "Allowlist" }).click();

    // Long enough for a counters frame and a poll to have landed on it.
    await page.waitForTimeout(2600);
    expect(await row.locator("button.danger").first().innerText()).toContain(key);

    await row.locator("button.danger").first().click();
    await expect.poll(() => handler.isAllowlisted(key)).toBe(true);
    handler.updateRanges("allowlist", []);
    await page.close();
  });

  it("forgets one actor without touching the rest", async () => {
    const page = await open(1440, "#actors", "#view-actors");
    const before = await page.locator("#actor-rows tr").count();
    const key = (await page.locator("#actor-rows tr td.who").first().innerText()).trim();
    await page.locator("#actor-rows tr").first().locator("button", { hasText: "Forget" }).click();
    await expect.poll(() => handler.registry.peek(key) === undefined).toBe(true);
    await expect.poll(() => page.locator("#actor-rows tr").count()).toBe(before - 1);
    await page.close();
  });
});

/**
 * The request tester.
 *
 * A dry run on the server: the verdict is real and nothing is recorded, which is what
 * makes it safe to put on a page whose whole job is to describe traffic honestly.
 */
describe("testing a request", () => {
  it("answers with the verdict, the rule and the evidence", async () => {
    const page = await open();
    await page.locator("#test-input").fill("python-requests/2.32.3");
    await page.locator("#test-run").click();
    await expect.poll(() => page.locator("#test-result").innerText()).toContain("confirmed-bot");
    expect(await page.locator("#test-result").innerText()).toContain("self-identified");
    await page.close();
  });

  it("says what it assumed, every time", async () => {
    const page = await open();
    await page.locator("#test-input").fill("curl/8.4.0");
    await page.locator("#test-run").click();
    await expect.poll(() => page.locator(".assumed").innerText()).toContain("no history");
    expect(await page.locator(".assumed").innerText()).toContain("client address");
    await page.close();
  });

  it("puts nothing in the feed it is sitting next to", async () => {
    const page = await open();
    const before = await page.locator("tbody#rows tr.row").count();
    await page.locator("#test-input").fill("curl/8.4.0");
    await page.locator("#test-run").click();
    await expect.poll(() => page.locator("#test-result").isVisible()).toBe(true);
    await page.waitForTimeout(300);
    expect(await page.locator("tbody#rows tr.row").count()).toBe(before);
    await page.close();
  });
});

/** A change to the policy is a thing that happened to the traffic, so it goes on the chart. */
describe("runtime changes on the timeline", () => {
  it("marks each one, with what it was and who did it", async () => {
    handler.updateGuard({ falsePositivePolicy: "balanced" }, { by: "ada@example.com" });
    handler.updateGuard({ falsePositivePolicy: "strict" });

    const page = await open(1440, "#stats", "#view-stats");
    await expect.poll(() => page.locator("#traffic circle").count()).toBeGreaterThan(1);
    expect(await page.locator("#traffic-legend").innerText()).toContain("runtime change");
    // An SVG <title> is not an HTMLElement, so it is read as text rather than as
    // rendered content. It is what a browser shows on hover.
    const tooltips = await page.locator("#traffic circle title").allTextContents();
    expect(tooltips.some((text) => text.includes("guard"))).toBe(true);
    expect(tooltips.some((text) => text.includes("ada@example.com"))).toBe(true);
    await page.close();
  });
});

/**
 * Accessibility, checked by a machine.
 *
 * The page was built with a keyboard in mind from the start — a roving tab strip, rows
 * that are controls, a skip link, focus that survives a redraw — and none of that is
 * the same as *checked*. axe finds the class of problem a careful author still ships: a
 * control with no accessible name, a heading level that does not exist, a contrast pair
 * that fails at the ratio rather than to the eye.
 *
 * **Both themes and both widths**, because the first version of this ran in light mode
 * at one size and passed while the dark palette had a serious contrast failure on every
 * piece of weak evidence. A check that only looks where you already looked is a check
 * that agrees with you.
 *
 * Every severity is failed on, including the ones axe calls minor: the page is at zero,
 * and "nothing" is a much easier line to hold than "nothing important".
 */
describe("accessibility", () => {
  const axeSource = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");

  interface AxeResult {
    violations: Array<{ id: string; impact: string | null; help: string; nodes: Array<{ target: string[] }> }>;
  }

  async function audit(page: Page): Promise<string> {
    // `evaluate` runs through the debugger rather than as a page script, so the strict
    // CSP this page is served under does not have to be relaxed to test it.
    await page.evaluate(axeSource);
    const result = (await page.evaluate(async () => {
      const axe = (globalThis as unknown as { axe: { run: (context: unknown, options: unknown) => Promise<unknown> } }).axe;
      return await axe.run(document, { resultTypes: ["violations"] });
    })) as AxeResult;
    return result.violations
      .map((violation) => `${violation.id} (${violation.impact}) — ${violation.help} at ${violation.nodes.map((node) => node.target.join(" ")).join(", ")}`)
      .join("\n");
  }

  /** Opens a page in a theme, lands it on a view, and puts the view in its busiest state. */
  async function openFor(scheme: "light" | "dark", width: number, hash: string): Promise<Page> {
    const page = await browser.newPage({ viewport: { width, height: 950 }, colorScheme: scheme });
    await page.goto(url.replace(/\/$/, "/") + hash);
    if (hash === "") {
      await page.waitForSelector("tbody tr.row");
      // Open a row: the evidence tiers, the header table and the row tools only exist
      // in that state, and they are where two of the three defects this found were.
      await page.locator("tbody tr.row .row-toggle").first().click();
      await page.waitForSelector("tr.detail");
    } else {
      await page.waitForSelector(`#view-${hash.slice(1)}:not([hidden])`);
      if (hash === "#actors") await page.waitForSelector("#actor-rows tr");
      if (hash === "#policy") await page.locator("#rulelist .rule .chev").first().click();
    }
    await page.waitForTimeout(250);
    return page;
  }

  const screens: Array<[name: string, hash: string]> = [
    ["the live feed with a row open", ""],
    ["the actors screen", "#actors"],
    ["the statistics screen", "#stats"],
    ["the policy screen with a rule open", "#policy"],
  ];

  for (const scheme of ["light", "dark"] as const) {
    for (const [name, hash] of screens) {
      it(`has nothing to report on ${name}, in ${scheme}`, async () => {
        const page = await openFor(scheme, 1440, hash);
        expect(await audit(page)).toBe("");
        await page.close();
      });
    }
  }

  it("has nothing to report on a narrow window either", async () => {
    const page = await openFor("dark", 720, "");
    expect(await audit(page)).toBe("");
    await page.close();
  });

  /**
   * `role="img"` with a name says a picture is here and what it is called. It says
   * nothing about what is *in* it — so every number on the statistics screen used to be
   * unreachable to a reader who cannot see the bars.
   */
  it("says in words what each chart shows", async () => {
    const page = await open(1440, "#stats", "#view-stats");
    for (const [chart, expected] of [
      ["traffic-alt", /requests/],
      ["score-alt", /threshold/],
      ["latency-alt", /percentile|no assessments/],
    ] as Array<[string, RegExp]>) {
      const text = await page.locator(`#${chart}`).textContent();
      expect(text ?? "", chart).toMatch(expected);
    }
    // And it is a real alternative rather than a hidden decoration: the chart points at
    // it, so a screen reader reads it as the image's description.
    expect(await page.locator("#traffic").getAttribute("aria-labelledby")).toBe("traffic-alt");
    await page.close();
  });

  it("keeps the chart summaries out of everybody else's way", async () => {
    const page = await open(1440, "#stats", "#view-stats");
    const box = await page.locator("#traffic-alt").boundingBox();
    expect(box?.width).toBeLessThanOrEqual(1);
    await page.close();
  });

  /**
   * Every ink the page can paint, on every surface it can appear on.
   *
   * axe only sees what the traffic happened to produce: it audits the badges that are
   * on screen, so a verdict nobody made that afternoon goes unchecked. This puts each
   * one into each context deliberately — a closed row, an open row with its blue tint,
   * the detail panel — and measures the composite, because the failures found this way
   * were all *layered*: an amber ink on a 16%-amber chip on a tinted row is three
   * surfaces deep and passed at every stage but the last.
   */
  it("paints nothing below 4.5:1, in either theme", async () => {
    for (const scheme of ["light", "dark"] as const) {
      const page = await openFor(scheme, 1440, "");
      const failures = await page.evaluate(() => {
        const luminance = (rgb: number[]): number => {
          const [r, g, b] = rgb.map((value) => {
            const channel = value / 255;
            return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
          }) as [number, number, number];
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        const parse = (value: string): number[] => (value.match(/[\d.]+/g) ?? ["0", "0", "0", "1"]).map(Number);
        const over = (fg: number[], bg: number[]): number[] => {
          const alpha = fg[3] ?? 1;
          return [0, 1, 2].map((i) => (fg[i] ?? 0) * alpha + (bg[i] ?? 0) * (1 - alpha));
        };
        const backdrop = (node: HTMLElement): number[] => {
          const layers: number[][] = [];
          for (let el: HTMLElement | null = node; el !== null; el = el.parentElement) layers.push(parse(getComputedStyle(el).backgroundColor));
          let colour = [255, 255, 255];
          for (const layer of layers.reverse()) colour = layer[3] === 0 ? colour : over(layer, colour);
          return colour;
        };
        const ratio = (node: HTMLElement): number => {
          const background = backdrop(node);
          const foreground = over(parse(getComputedStyle(node).color), background);
          const a = luminance(foreground);
          const b = luminance(background);
          return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        };

        const inRow = ["badge b-proven", "badge b-suspected", "badge b-human", "badge b-unknown", "act act-deny", "act act-mitigate", "act act-allow", "act act-tag", "sub", "guard"];
        const inDetail = ["tier t-certain", "tier t-strong", "tier t-moderate", "tier t-weak", "ev-meta", "basis", "hint"];
        const closed = document.querySelector("tbody tr.row:not(.open) td") as HTMLElement | null;
        const opened = document.querySelector("tbody tr.row.open td") as HTMLElement | null;
        const detail = document.querySelector("tr.detail td") as HTMLElement | null;

        const bad: string[] = [];
        const measure = (className: string, host: HTMLElement | null, where: string): void => {
          if (host === null) return;
          const probe = document.createElement("span");
          probe.className = className;
          probe.textContent = "sample text";
          host.appendChild(probe);
          const value = ratio(probe);
          probe.remove();
          if (value < 4.5) bad.push(`${className} on ${where}: ${value.toFixed(2)}:1`);
        };
        for (const className of inRow) {
          measure(className, closed, "a closed row");
          measure(className, opened, "an open row");
        }
        for (const className of inDetail) measure(className, detail, "the detail panel");
        return bad;
      });
      expect(failures, scheme).toEqual([]);
      await page.close();
    }
  });

  /** A page with no `h1` gives "jump to the heading" nothing to jump to. */
  it("has one top-level heading, and it names the dashboard", async () => {
    const page = await open();
    expect(await page.locator("h1").count()).toBe(1);
    expect(await page.locator("h1").innerText()).toBe("acme-shop");
    await page.close();
  });
});

/**
 * The other page this library serves, and the only one a member of the public sees.
 *
 * The dashboard is for an operator who chose to open it. The challenge interstitial is
 * shown to somebody who was going about their day and tripped a probabilistic verdict —
 * which means it is shown to people using a screen reader, a magnifier or a phone, and
 * if it is unusable by them the library has denied service to exactly the population it
 * exists to protect. It is served here through the real `ChallengeService`, with the
 * headers and the strict CSP the action sets, rather than pasted into a blank page.
 */
describe("the challenge interstitial", () => {
  const axeSource = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
  let challengeUrl: string;
  let challengeServer: ReturnType<typeof createServer>;

  beforeAll(async () => {
    const service = new ChallengeService({ secrets: ["a-secret-long-enough-for-the-service"] });
    challengeServer = createServer((_request, response) => {
      const issued = service.issue("203.0.113.9");
      response.writeHead(issued.status, issued.headers);
      response.end(issued.body);
    });
    await new Promise<void>((resolve) => challengeServer.listen(0, "127.0.0.1", () => resolve()));
    challengeUrl = `http://127.0.0.1:${(challengeServer.address() as { port: number }).port}/`;
  });

  afterAll(() => {
    challengeServer?.close();
  });

  for (const scheme of ["light", "dark"] as const) {
    it(`has nothing for axe to report, in ${scheme}`, async () => {
      const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, colorScheme: scheme });
      await page.goto(challengeUrl);
      await page.waitForTimeout(400);
      await page.evaluate(axeSource);
      const result = (await page.evaluate(async () => {
        const axe = (globalThis as unknown as { axe: { run: (context: unknown, options: unknown) => Promise<unknown> } }).axe;
        return await axe.run(document, { resultTypes: ["violations"] });
      })) as { violations: Array<{ id: string; impact: string | null; nodes: Array<{ target: string[] }> }> };
      expect(result.violations.map((violation) => `${violation.id} (${violation.impact}) at ${violation.nodes[0]?.target.join(" ")}`).join("\n")).toBe("");
      await page.close();
    });
  }

  it("fits a phone without scrolling sideways", async () => {
    const page = await browser.newPage({ viewport: { width: 360, height: 720 } });
    await page.goto(challengeUrl);
    await page.waitForTimeout(300);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await page.close();
  });

  /**
   * The whole point of the page. Its one inline script runs under a nonce and nothing
   * else may run at all, so a proof of work that never starts is a person who cannot
   * get through — and they would have no way to tell you why.
   */
  it("runs its proof of work under the CSP it is served with", async () => {
    const page = await browser.newPage();
    const problems: string[] = [];
    page.on("pageerror", (error) => problems.push(String(error)));
    page.on("console", (message) => {
      // The page is served with 429 by design — "slow down and prove something" — and
      // Chromium logs every non-2xx navigation as a console error. That is the browser
      // narrating the status code, not the page failing.
      if (message.type() === "error" && !message.text().includes("Failed to load resource")) problems.push(message.text());
    });
    await page.goto(challengeUrl);
    // The status region is what a screen reader is told; it has to move off "Starting…".
    await expect.poll(() => page.locator("#status").innerText(), { timeout: 15_000 }).not.toBe("Starting…");
    expect(problems).toEqual([]);
    await page.close();
  });
});

describe("the page's own guarantees still hold in a browser", () => {
  /** A User-Agent is attacker-written. The page's rule is that it can only ever be text. */
  it("renders a hostile User-Agent as text and not as markup", async () => {
    await handler.handle(
      createFacts({
        method: "GET",
        url: "/products",
        headers: { host: "acme.example", "user-agent": "<img src=x onerror=alert(1)><script>alert(2)</script>", accept: "*/*" },
        ip: "203.0.113.99",
        protocol: "https",
        httpVersion: "1.1",
      }),
    );
    const page = await open();
    const dialogs: string[] = [];
    page.on("dialog", (dialog) => {
      dialogs.push(dialog.message());
      void dialog.dismiss();
    });
    await page.locator("#search").fill("onerror");
    await expect.poll(() => page.locator("tbody tr.row").count()).toBeGreaterThan(0);
    await page.locator("tbody tr.row").first().click();
    await page.waitForTimeout(250);

    expect(dialogs).toEqual([]);
    expect(await page.locator("img[src='x']").count()).toBe(0);
    expect(await page.locator("#rows").innerText()).toContain("onerror");
    await page.close();
  });

  it("runs its script under the nonce, with no console errors", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const problems: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") problems.push(message.text());
    });
    page.on("pageerror", (error) => problems.push(String(error)));
    await page.goto(url);
    await page.waitForSelector("tbody tr.row");
    await page.locator("#tab-stats").click();
    await page.locator("#tab-policy").click();
    await page.waitForTimeout(400);
    expect(problems).toEqual([]);
    await page.close();
  });
});
