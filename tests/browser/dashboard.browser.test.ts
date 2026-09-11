import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, firefox, webkit } from "playwright";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { BotHandler, ChallengeService, createFacts } from "../../src/index.js";
import { createDashboardHandler } from "../../src/dashboard/index.js";
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
 *
 * **Which engine.** `BROWSER_ENGINE` picks one — chromium by default, and CI runs all
 * three. Testing one engine was how a real bug shipped: the tables collapsed their
 * borders, which stops a sticky `th` sticking in WebKit, so the feed's column headers
 * scrolled away in Safari while every test here passed. A page this size is mostly CSS,
 * and CSS is where engines differ; a suite that only ever sees one of them is checking
 * the half of the page that was never in doubt.
 */

const ENGINES = { chromium, firefox, webkit } as const;
const ENGINE_NAME = (process.env["BROWSER_ENGINE"] ?? "chromium") as keyof typeof ENGINES;
const ENGINE = ENGINES[ENGINE_NAME] ?? chromium;

let browser: Browser;
let dashboard: DashboardServer;
/** A second listener over the same handler, with sections switched off. See below. */
let analyst: DashboardServer;
let handler: BotHandler;
let url: string;
/** axe, read once and evaluated into whichever page is being audited. */
const axeSource = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");

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
  browser = await ENGINE.launch();
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

  /**
   * The "Actors tracked" counter is the one tile that names a screen, so it takes you
   * there. A real `<button>` rather than a div with a click handler: it has to be in the
   * tab order, answer Enter and Space, and be announced as something to press, and a div
   * gets none of those.
   */
  it("goes to the Actors screen from the tile that counts them", async () => {
    const page = await open();
    const tile = page.locator("#tiles .tile", { hasText: "Actors tracked" });
    await expect.poll(() => tile.evaluate((node) => node.tagName)).toBe("BUTTON");

    // The count and the caption still read out; the hint is added to them, not over them.
    const label = await tile.evaluate((node) => (node.textContent ?? "").replace(/\s+/g, " "));
    expect(label).toContain("Actors tracked");
    expect(label).toContain("Show the Actors screen");

    await tile.click();
    await expect.poll(() => page.locator("#tab-actors").getAttribute("aria-selected")).toBe("true");
    await expect.poll(() => page.locator("#view-actors").isVisible()).toBe(true);

    // And from the keyboard, which is the half a div would have lost.
    await page.locator("#tab-live").click();
    await expect.poll(() => page.locator("#view-actors").isVisible()).toBe(false);
    await tile.focus();
    expect(await tile.evaluate((node) => document.activeElement === node)).toBe(true);
    await page.keyboard.press("Enter");
    await expect.poll(() => page.locator("#view-actors").isVisible()).toBe(true);
    await page.close();
  });

  /**
   * The filter box completes what it accepts.
   *
   * The options come from the parser's own field map, so anything offered is something the
   * language understands — the failure worth guarding against is teaching somebody a
   * syntax that does not exist.
   */
  it("completes a filter term, and then its values", async () => {
    const page = await open();
    await page.click("#search");
    await page.type("#search", "ver");
    await expect.poll(() => page.locator("#search-suggest li").allTextContents(), { timeout: 10_000 }).toEqual(["verdict:"]);

    // Keyboard alone: down to the option, Enter to take it.
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    expect(await page.inputValue("#search")).toBe("verdict:");
    // Completing the field leaves the caret where the values are, so they are offered
    // straight away rather than after another keystroke.
    await expect.poll(() => page.locator("#search-suggest li").allTextContents()).toContain("verdict:confirmed-bot");

    await page.keyboard.press("Escape");
    await expect.poll(() => page.locator("#search-suggest").isHidden()).toBe(true);
    await page.close();
  });

  /**
   * `$not` replaces the Exclude button that used to live beside the search box.
   *
   * One mechanism rather than two, and it is in the URL like every other narrowing — so
   * a hidden slice of traffic is now something a colleague can be sent a link to rather
   * than a setting living in one person's browser.
   */
  it("hides traffic with $not, everywhere", async () => {
    const page = await open();
    await handler.handle(createFacts({ method: "GET", url: "/health", headers: { host: "shop.test", "user-agent": "curl/8.4.0", accept: "*/*" }, ip: "203.0.113.201" }));
    await page.fill("#search", "path:/health");
    await expect.poll(() => page.locator("#rows tr.row").count(), { timeout: 15_000 }).toBeGreaterThan(0);

    // Searching for what was hidden finds none of it. That is the assertion worth
    // making: counting rows on a page cannot show it, because hiding one row out of a
    // full page leaves a full page.
    await page.fill("#search", "$not path:/health");
    await expect.poll(() => page.locator("#rows tr.row").count(), { timeout: 10_000 }).toBeGreaterThan(0);
    expect(await page.locator("#rows").textContent()).not.toContain("/health");

    // The Exclude button is gone, and nothing is left behind pointing at it.
    expect(await page.locator('#saved-filters button:has-text("Exclude this")').count()).toBe(0);
    await page.close();
  });

  it("takes $or, $in and brackets from the search box", async () => {
    const page = await open();
    await page.fill("#search", "verdict:$in(confirmed-bot, suspected-bot) $and $not path:/health");
    await expect.poll(() => page.locator("#rows tr.row").count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(0);
    expect(await page.locator("#rows").textContent()).not.toContain("/health");
    // A half-typed query must not break the page — this is a live search box.
    for (const half of ["$", "$no", "(", "verdict:$in(", "curl $or"]) {
      await page.fill("#search", half);
      await page.waitForTimeout(120);
      expect(await page.locator("#rows").count()).toBe(1);
    }
    await page.close();
  });

  /**
   * One control, three questions: from an incident until now, up to when something
   * stopped, or between two moments. Either end may be left empty.
   */
  it("narrows the feed to a window with either end open", async () => {
    const page = await open();
    await expect.poll(() => page.locator("#rows tr.row").count(), { timeout: 10_000 }).toBeGreaterThan(0);
    const all = await page.locator("#rows tr.row").count();

    // A window that ended before this dashboard existed selects nothing, which is the
    // clearest possible check that the bound is applied at all.
    //
    // Minute precision, not `…T00:00:00`. The input carries `step="1"`, so Chrome
    // normalises a zero-seconds value back to the minute form, and Playwright compares
    // what it typed against what the element reads back — so the seconds-precision string
    // is rejected as malformed while `…T00:00:01` and `…T00:00` are both fine.
    await page.fill("#to-at", "2000-01-01T00:00");
    await expect.poll(() => page.locator("#rows tr.row").count(), { timeout: 10_000 }).toBe(0);
    expect(await page.locator("#timeframe-clear").isVisible()).toBe(true);

    // And one that started before it selects everything.
    await page.fill("#to-at", "");
    await page.fill("#from-at", "2000-01-01T00:00");
    await expect.poll(() => page.locator("#rows tr.row").count(), { timeout: 10_000 }).toBe(all);

    await page.click("#timeframe-clear");
    await expect.poll(() => page.locator("#timeframe-clear").isHidden()).toBe(true);
    expect(await page.locator("#rows tr.row").count()).toBe(all);
    await page.close();
  });

  /**
   * Typing a date, rather than committing one.
   *
   * `fill()` above sets a value and dispatches both `input` and `change`, which is what a
   * date *picker* does. Typing into the field is not that: a `datetime-local` fires
   * `input` as each segment is edited and holds `change` back until the value is
   * committed, usually on blur. The control listened only for `change`, so somebody
   * typing a window watched the feed sit there unchanged until they clicked away —
   * which reads as a filter that does not work.
   */
  it("narrows the feed while the date is being typed, not only once it is committed", async () => {
    const page = await open();
    await expect.poll(() => page.locator("#rows tr.row").count(), { timeout: 10_000 }).toBeGreaterThan(0);

    // The field keeps focus throughout: no blur, so no `change`.
    await page.locator("#to-at").focus();
    await page.$eval("#to-at", (node) => {
      const input = node as HTMLInputElement;
      input.value = "2000-01-01T00:00";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await expect.poll(() => page.locator("#rows tr.row").count(), { timeout: 10_000 }).toBe(0);
    expect(await page.locator("#timeframe-clear").isVisible()).toBe(true);
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

  /**
   * On a phone, in the terms that matter to somebody holding one: every row is reachable
   * and openable.
   *
   * This used to assert `overflow-x: auto`, which is a mechanism rather than a
   * requirement — and asserting the mechanism made it wrong the moment a cheaper one
   * arrived. Wrapping the User-Agent line takes the table's floor from about 860px to
   * about 500px, so at 700px there is now nothing to scroll and nothing cut off, and the
   * old assertion failed a page that had got better. The scrollbar is still there
   * underneath, where it is genuinely needed.
   *
   * Clicking a row is the part worth keeping. A horizontal scroll container makes a row
   * wider than the box it sits in, and a row wider than its box is one a pointer cannot
   * reliably land on — which is how a stray scrollbar at 1440px stopped a click from
   * working at all rather than merely looking untidy.
   */
  it("lets the feed be reached rather than clipping it", async () => {
    for (const width of [420, 560, 700]) {
      const page = await open(width);
      const reach = await page.evaluate(() => {
        const wrap = document.querySelector(".feed-scroll") as HTMLElement;
        const table = wrap.querySelector("table") as HTMLElement;
        table.style.width = "min-content";
        const floor = table.scrollWidth;
        table.style.width = "";
        return { floor, room: wrap.clientWidth, scrolls: getComputedStyle(wrap).overflowX === "auto" };
      });
      expect(reach.floor <= reach.room || reach.scrolls, `the feed is clipped at ${width}px`).toBe(true);

      await page.locator("tbody tr.row").first().click({ timeout: 5000 });
      await expect.poll(() => page.locator("tbody tr.row.open").count()).toBeGreaterThan(0);
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

  /**
   * Saving a filter, the whole way round.
   *
   * Nothing tested this before, which is how both of its bugs shipped: Save asked for a
   * name with `prompt()`, which a sandboxed frame blocks, and Delete was never shown
   * because it checked for a selection the instant the list was built. Any dialog at all
   * fails this test — a name is typed into the page now.
   */
  it("saves a filter without a dialog, keeps it across a reload, and deletes it", async () => {
    const page = await open();
    const dialogs: string[] = [];
    page.on("dialog", (dialog) => {
      dialogs.push(dialog.type());
      void dialog.dismiss();
    });
    await page.locator("#search").fill("ua:curl");
    await page.locator('#saved-filters button:has-text("Save")').click();
    const name = page.locator("#saved-filters input.saved-name");
    await expect.poll(() => name.count()).toBe(1);
    await name.fill("browser-saved");
    await name.press("Enter");
    await expect.poll(() => page.locator("#saved-filters select option", { hasText: "browser-saved" }).count(), { timeout: 5_000 }).toBe(1);
    expect(dialogs, "no prompt, no alert, nothing").toEqual([]);

    // Kept by the dashboard, so a reload finds it.
    await page.reload();
    await page.waitForSelector("tbody tr.row");
    await expect.poll(() => page.locator("#saved-filters select option", { hasText: "browser-saved" }).count(), { timeout: 5_000 }).toBe(1);

    // Choosing it loads it, and offers Delete — which was never offered before.
    await page.locator("#saved-filters select").selectOption("browser-saved");
    await expect.poll(() => page.locator("#search").inputValue()).toBe("ua:curl");
    const remove = page.locator('#saved-filters button:has-text("Delete")');
    await expect.poll(() => remove.count()).toBe(1);
    await remove.click();
    await expect.poll(() => page.locator("#saved-filters select option", { hasText: "browser-saved" }).count(), { timeout: 5_000 }).toBe(0);
    await page.close();
  });

  /**
   * Moving saved filters to the listener must not lose what the browser used to keep.
   *
   * A listener with no file comes up empty after a restart. The browser keeps a copy for
   * exactly that case and hands it back, so the default is at least as durable as the old
   * browser-only design was. Simulated here by an empty listener and a copy in storage.
   */
  it("hands this browser's copy back to a listener that came up empty", async () => {
    const base = url.replace(/\/$/, "");
    const listed = async (): Promise<string[]> =>
      ((await (await fetch(`${base}/api/filters`)).json()) as { filters: Array<{ name: string }> }).filters.map((entry) => entry.name);
    for (const name of await listed()) {
      await fetch(`${base}/api/filters`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "delete", name }) });
    }
    expect(await listed()).toEqual([]);

    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.addInitScript(() => {
      localStorage.setItem("bothandler.filters", JSON.stringify([{ name: "from-before-the-restart", query: "ua:curl", filter: "all" }]));
    });
    await page.goto(url);
    await page.waitForSelector("tbody tr.row");
    await expect.poll(listed, { timeout: 5_000 }).toEqual(["from-before-the-restart"]);
    await expect.poll(() => page.locator("#saved-filters select option", { hasText: "from-before-the-restart" }).count()).toBe(1);

    await fetch(`${base}/api/filters`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "delete", name: "from-before-the-restart" }) });
    await page.close();
  });

  it("does not push the saved-filter controls out of the bar while naming one", async () => {
    const page = await open(1024);
    await page.locator('#saved-filters button:has-text("Save")').click();
    const bar = (await page.locator("#saved-filters").boundingBox()) ?? { x: 0, width: 0 };
    const confirm = (await page.locator("#saved-filters .saved-confirm").boundingBox()) ?? { x: 0, width: 1e9 };
    const nameBox = (await page.locator("#saved-filters input.saved-name").boundingBox()) ?? { width: 1e9 };
    expect(nameBox.width, "the name box is its own size, not the bar's").toBeLessThan(300);
    expect(confirm.x + confirm.width).toBeLessThanOrEqual(bar.x + bar.width + 1);
    await page.locator("#saved-filters input.saved-name").press("Escape");
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

  /**
   * Read once the window has something in it, rather than whenever the page happened to
   * finish opening.
   *
   * An empty ring labels itself "this window · empty", which is the honest thing to say
   * and carries no count — so asserting a count without first ensuring there is traffic
   * was a race the local machine won and CI lost. The property being tested is that every
   * window-scoped panel says how much window it is counting, and the case worth pinning
   * is the one with a number in it.
   */
  it("says how much window every window-scoped panel is counting", async () => {
    await handler.handle(createFacts({ method: "GET", url: "/windowed", headers: { host: "shop.test", "user-agent": "curl/8.4.0", accept: "*/*" }, ip: "203.0.113.95" }));
    const page = await open(1440, "#stats", "#view-stats");
    const labels = (): Promise<string[]> => page.locator("#view-stats .win").allInnerTexts();
    await expect.poll(async () => (await labels()).length, { timeout: 15_000 }).toBeGreaterThan(0);
    await expect.poll(async () => (await labels()).every((text) => /last [\d,]+ requests/.test(text)), { timeout: 15_000 }).toBe(true);
    // One label, on every one of them: the panels that count the ring must not be
    // distinguishable from each other, only from the ones counting since start.
    expect(new Set(await labels()).size).toBe(1);
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

/**
 * Paging, on its own handler and its own listener.
 *
 * These tests need hundreds of requests and dozens of actors to have anything to page
 * through, and the shared feed is read by every other test in this file — a thousand rows
 * pushes theirs off the first page, and forty actors turns "one fewer than before" into
 * "still a full page". Same reason the policy editor has a listener of its own.
 */
describe("paging through more than fits", () => {
  let pagedHandler: BotHandler;
  let pagedDashboard: DashboardServer;
  let pagedUrl: string;

  const openPaged = async (): Promise<Page> => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(pagedUrl);
    await page.waitForSelector("tbody tr.row");
    return page;
  };

  beforeAll(async () => {
    pagedHandler = new BotHandler({ preset: "protect-content" });
    // A cap of one per second, so that a burst is *certainly* thinned. Whether the stream
    // skips anything at the default hundred depends on how fast the machine gets through
    // the requests, and the catch-up test below waited on a badge that sometimes never
    // appeared — a test that needs a gap has to be given one rather than hope for it.
    pagedDashboard = await pagedHandler.serveDashboard({ port: 0, auth: false, controls: { reset: true }, maxEventsPerSecond: 1 });
    pagedUrl = `http://127.0.0.1:${pagedDashboard.port}/`;
    // One request so the page has a row to settle on before each test adds its own.
    await pagedHandler.handle(
      createFacts({ method: "GET", url: "/seed", headers: { host: "shop.test", "user-agent": "curl/8.4.0", accept: "*/*" }, ip: "203.0.113.1" }),
    );
  });

  afterAll(async () => {
    await pagedDashboard.close();
  });

  /**
   * The feed pages, and a page that is not the newest holds still.
   *
   * A reader on page two is standing on ground that moves: the list is newest-first and
   * grows at that end, so one arriving request pushes every row down by one and they are
   * reading different rows than the ones they were looking at, silently. Leaving the front
   * page freezes the list; returning thaws it.
   */
  it("pages the feed, and holds a page still while requests arrive", async () => {
    const page = await openPaged();
    // Enough to fill more than one page, then everything the stream skipped.
    for (let i = 0; i < 130; i++) {
      await pagedHandler.handle(
        createFacts({ method: "GET", url: `/paged/${i}`, headers: { host: "shop.test", "user-agent": "curl/8.4.0", accept: "*/*" }, ip: `198.51.100.${i % 250}` }),
      );
    }
    await expect.poll(() => page.locator("#rows tr.row").count(), { timeout: 15_000 }).toBeGreaterThan(0);
    // The opening replay is droppable, so an unknown share of those 130 may not have
    // arrived — and the badge offering them appears whenever the server gets round to
    // saying so. Asking once raced it: on a run where the replay happened to be complete
    // enough for one page and no more, there was no second page to step to and the poll
    // below waited out its timeout. Press it until there is nothing left to press.
    const loadThem = page.locator("#feed-load-skipped");
    await expect
      .poll(
        async () => {
          // Every step bounded and allowed to fail. The button disappears the moment the
          // load succeeds, so an unbounded click issued just before that raced it and then
          // sat waiting for a control that was never coming back — which is what was
          // running the whole test out of time, rather than any assertion in it.
          if (await loadThem.isVisible().catch(() => false)) {
            await loadThem.click({ timeout: 2_000 }).catch(() => undefined);
          }
          // Waiting on the *pager*, not on a row count. Fifty rows is satisfied by a
          // single page of exactly fifty, and a single page renders no pager at all — so
          // every `.where` read after this sat waiting for an element that was never
          // going to be attached. `count()` answers immediately instead of waiting.
          return page.locator("#feed-pager .where").count();
        },
        { timeout: 20_000 },
      )
      .toBe(1);

    const where = page.locator("#feed-pager .where");
    await expect.poll(() => where.textContent(), { timeout: 15_000 }).toContain("1–50");
    expect(await page.locator("#rows tr.row").count()).toBe(50);
    // Nothing newer than the newest page.
    expect(await page.locator('#feed-pager button[aria-label="Previous page"]').isDisabled()).toBe(true);

    await page.locator('#feed-pager button[aria-label="Next page"]').click();
    await expect.poll(() => where.textContent()).toContain("51–100");
    expect(await page.locator("#feed-pager .held").count()).toBe(1);
    const topRow = await page.locator("#rows tr.row").first().textContent();

    // Requests arriving now must not move the page under the reader.
    for (let i = 0; i < 12; i++) {
      await pagedHandler.handle(
        createFacts({ method: "GET", url: `/late/${i}`, headers: { host: "shop.test", "user-agent": "curl/8.4.0", accept: "*/*" }, ip: "198.51.100.251" }),
      );
    }
    await page.waitForTimeout(2500);
    expect(await page.locator("#rows tr.row").first().textContent()).toBe(topRow);
    expect(await where.textContent()).toContain("51–100");

    // And they are waiting at the front when the reader comes back.
    await page.locator('#feed-pager button[aria-label="Previous page"]').click();
    await expect.poll(() => where.textContent()).toContain("1–50");
    expect(await page.locator("#feed-pager .held").count()).toBe(0);

    // Both ends of the table, because fifty rows is taller than the window and a pager
    // only at the bottom means scrolling to the end to reach the top of the next page.
    expect(await page.locator("#feed-pager-top .where").textContent()).toBe(await where.textContent());
    // The size chooser sits on one of the two, not both: one setting, one control.
    expect(await page.locator("#feed-pager-top select").count()).toBe(1);
    expect(await page.locator("#feed-pager select").count()).toBe(0);

    const newest = await page.locator("#rows tr.row").first().textContent();
    await page.selectOption("#feed-pager-top select", "100");
    // More than a page of fifty, rather than exactly a hundred. How many requests survive
    // to reach this browser is not fixed — the opening replay is droppable and the rate cap
    // thins a burst — so the total here varies from run to run, and asserting a range like
    // "1–100 of 131" made the test depend on a number nothing guarantees. Worse, when the
    // total happened to land at or under a hundred the whole list became one page, the
    // pager stopped being rendered at all, and reading it waited for an element that was
    // never coming back.
    await expect.poll(() => page.locator("#rows tr.row").count(), { timeout: 10_000 }).toBeGreaterThan(50);
    // Changing the size returns to the front: page four of fifty is not page four of a
    // hundred, and keeping the number while changing what it counts moves the reader.
    expect(await page.locator("#rows tr.row").first().textContent()).toBe(newest);
    await page.close();
    // A minute rather than the default half: this one drives 142 requests through a real
    // handler, waits out a rate cap, and then settles the page twice. It was not failing
    // on an assertion, it was running out of budget.
  }, 60_000);

  /**
   * The Actors screen is the widest table in the dashboard and the one nobody had
   * measured narrow. A grid item will not shrink below its content unless it is told it
   * may, so the panel pushed the whole document sideways instead of letting the scroller
   * inside it do its job.
   */
  it("does not push the page sideways at any width, on any screen", async () => {
    for (const width of [1440, 820, 600, 390, 375]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await page.goto(pagedUrl);
      await page.waitForSelector("tbody tr.row");
      for (const tab of ["live", "actors", "stats", "policy"] as const) {
        await page.click(`#tab-${tab}`);
        await page.waitForTimeout(400);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow, `${tab} at ${width}px`).toBeLessThanOrEqual(0);
      }
      await page.close();
    }
  });

  /**
   * The entries the stream never delivered are still in the ring, and now there is a
   * button that goes and gets them. The opening replay is droppable, so a first load of a
   * busy dashboard can arrive missing most of its backlog — which is what this is for.
   */
  it("loads the entries the stream skipped", async () => {
    const page = await openPaged();
    for (let i = 0; i < 200; i++) {
      await pagedHandler.handle(
        createFacts({ method: "GET", url: `/skipped/${i}`, headers: { host: "shop.test", "user-agent": "python-requests/2.32.3", accept: "*/*" }, ip: `203.0.113.${i % 250}` }),
      );
    }
    await expect.poll(() => page.locator("#rows tr.row").count(), { timeout: 15_000 }).toBeGreaterThan(0);

    const badge = page.locator("#feed-skipped");
    const loadThem = page.locator("#feed-load-skipped");
    await expect.poll(() => badge.isVisible(), { timeout: 15_000 }).toBe(true);
    // The badge no longer just states the gap; the button beside it closes it.
    await expect.poll(() => loadThem.isVisible()).toBe(true);
    const before = await page.locator("#rows tr.row").count();

    await loadThem.click();
    // Everything the ring holds is now on the page, and the badge has nothing left to say.
    await expect.poll(() => badge.isVisible(), { timeout: 15_000 }).toBe(false);
    await expect.poll(() => loadThem.isVisible()).toBe(false);
    expect(await page.evaluate(() => document.querySelectorAll("#rows tr.row").length + Number((document.getElementById("feed-pager") as HTMLElement).hidden ? 0 : 1))).toBeGreaterThan(before);
    await page.close();
  });

  /**
   * The registry holds far more clients than the feed's ring holds requests, and the
   * dashboard could only ever see the busiest page of them — the wrong half, since the
   * feed already shows what is loudest.
   */
  it("pages the Actors table past the busiest", async () => {
    const page = await openPaged();
    for (let actor = 0; actor < 40; actor++) {
      for (let request = 0; request < 40 - actor; request++) {
        await pagedHandler.handle(
          createFacts({ method: "GET", url: `/a/${request}`, headers: { host: "shop.test", "user-agent": "curl/8.4.0", accept: "*/*" }, ip: `192.0.2.${actor}` }),
        );
      }
    }
    await page.locator("#tab-actors").click();
    await expect.poll(() => page.locator("#actor-rows tr").count(), { timeout: 15_000 }).toBeGreaterThan(0);

    const where = page.locator("#actors-pager .where");
    await expect.poll(() => where.textContent(), { timeout: 15_000 }).toContain("1–25");
    expect(await page.locator('#actors-pager button[aria-label="Previous page"]').isDisabled()).toBe(true);
    const busiest = await page.locator("#actor-rows tr td.who").first().textContent();

    await page.locator('#actors-pager button[aria-label="Next page"]').click();
    await expect.poll(() => where.textContent(), { timeout: 15_000 }).toContain("26–");
    // A different set of actors, further down the ranking.
    expect(await page.locator("#actor-rows tr td.who").first().textContent()).not.toBe(busiest);

    await page.locator('#actors-pager button[aria-label="Previous page"]').click();
    await expect.poll(() => where.textContent(), { timeout: 15_000 }).toContain("1–25");
    expect(await page.locator("#actor-rows tr td.who").first().textContent()).toBe(busiest);
    await page.close();
  });

});

/**
 * `<bot-dashboard>` in somebody else's page.
 *
 * Everything the element does that is worth asserting only exists in a browser: a shadow
 * root, a custom-element upgrade, tokens inheriting across a shadow boundary. It is
 * driven here against the real handler rather than a stub, because the thing most likely
 * to break is the seam between them.
 */
describe("the embeddable element", () => {
  // The built bundle, not the source: what a page loads is what should be tested, and it
  // is served to the browser below as `/element.js`.
  //
  // `pretest:browser` runs `tsup` for exactly this reason. It used to run only
  // `client:build`, which meant the suite passed on any machine that happened to have a
  // `dist/` lying around from an earlier build and failed on CI, where the browser job is
  // separate from the one that builds and starts from a clean checkout. The error was an
  // ENOENT on this line, thirty lines from anything that explains it.
  const bundle = readFileSync(new URL("../../dist/element/index.js", import.meta.url), "utf8");
  let embedUrl: string;
  let embedServer: ReturnType<typeof createServer>;
  let embedHandler: BotHandler;
  let embedStreams = 0;
  let editableUrl: string;
  let editableHandler: BotHandler;
  let editableServer: ReturnType<typeof createServer>;

  beforeAll(async () => {
    embedHandler = new BotHandler({ preset: "protect-content" });
    const mounted = createDashboardHandler(embedHandler, { basePath: "/_bots", auth: false, title: "shop.example" });
    // A second listener over the same handler with less to show, so the element can be
    // checked against server-side `sections` and `redact` rather than only its own config.
    const analystMounted = createDashboardHandler(embedHandler, { basePath: "/_analyst", auth: false, sections: { evidence: false, policy: false }, redact: { maskIp: true } });
    const hostPage = `<!doctype html><html lang="en"><head><title>Admin</title></head><body>
<header><h1 id="ours">Our admin page</h1></header>
<main><div id="slot"><bot-dashboard id="d" src="/_bots"></bot-dashboard></div></main>
<script type="module">
import { defineBotDashboard } from "/element.js";
document.getElementById("d").config = {
  tabs: [{ id: "stats", label: "Overview" }, { id: "live", label: "Traffic" }],
  theme: { scheme: "light", density: "compact", tokens: { accent: "#7c3aed" } },
  panels: [{ id: "extra", screen: "stats", title: "Checkout health", source: () => ({ rows: [{ label: "Orders", value: 42 }] }) }],
};
defineBotDashboard();
</script></body></html>`;
    const strictPage = hostPage.replace("</body>", "</body>");
    embedServer = createServer((request, response) => {
      const path = (request.url ?? "").split("?")[0];
      if (path === "/_bots/api/stream") {
        embedStreams++;
        response.on("close", () => {
          embedStreams--;
        });
      }
      if (path === "/strict") {
        // An external module script, so the policy under test is purely about styles.
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'" });
        response.end(strictPage.replace(/<script type="module">[\s\S]*?<\/script>/, '<script type="module" src="/boot.js"></script>'));
        return;
      }
      if (path === "/boot.js") {
        response.writeHead(200, { "content-type": "text/javascript" });
        response.end('import { defineBotDashboard } from "/element.js"; defineBotDashboard();');
        return;
      }
      if (path === "/nosrc") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end('<!doctype html><html><body><bot-dashboard id="d"></bot-dashboard><script type="module" src="/boot.js"></script></body></html>');
        return;
      }
      if (path === "/analyst") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end('<!doctype html><html lang="en"><body><bot-dashboard id="d" src="/_analyst"></bot-dashboard><script type="module" src="/boot.js"></script></body></html>');
        return;
      }
      if (path === "/crossorigin") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end('<!doctype html><html lang="en"><body><bot-dashboard id="d" src="http://127.0.0.1:1/_bots"></bot-dashboard><script type="module" src="/boot.js"></script></body></html>');
        return;
      }
      if (path === "/strictmode") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(`<!doctype html><html lang="en"><body><div id="slot"></div>
<script type="module">
import { defineBotDashboard } from "/element.js";
defineBotDashboard();
const slot = document.getElementById("slot");
const make = () => { const node = document.createElement("bot-dashboard"); node.id = "d"; node.setAttribute("src", "/_bots"); return node; };
const first = make();
slot.append(first);
first.remove();
slot.append(make());
</script></body></html>`);
        return;
      }
      if (path === "/two") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(`<!doctype html><html lang="en"><body><bot-dashboard id="a" src="/_bots"></bot-dashboard><bot-dashboard id="b" src="/_bots"></bot-dashboard>
<script type="module">
import { defineBotDashboard } from "/element.js";
defineBotDashboard();
globalThis.handOver = () => {
  const b = document.getElementById("b");
  document.getElementById("a").remove();
  b.remove();
  document.body.append(b);
};
</script></body></html>`);
        return;
      }
      if (path === "/customname") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end('<!doctype html><html lang="en"><body><ops-dash id="b" src="/_bots"></ops-dash><script type="module">import { defineBotDashboard } from "/element.js"; defineBotDashboard(); defineBotDashboard("ops-dash");</script></body></html>');
        return;
      }
      if (path === "/narrow") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end('<!doctype html><html lang="en"><body><div style="width:320px"><bot-dashboard id="d" src="/_bots"></bot-dashboard></div><script type="module" src="/boot.js"></script></body></html>');
        return;
      }
      if (path === "/ticker") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(`<!doctype html><html lang="en"><body><div id="slot"><bot-dashboard id="d" src="/_bots"></bot-dashboard></div>
<script type="module">
import { defineBotDashboard } from "/element.js";
let n = 0;
const config = { panels: [{ id: "t", screen: "live", title: "Ticker", refreshMs: 1000, source: () => ({ rows: [{ label: "tick", value: ++n }] }) }] };
document.getElementById("d").config = config;
defineBotDashboard();
globalThis.remount = () => { const slot = document.getElementById("slot"); slot.innerHTML = ""; const fresh = document.createElement("bot-dashboard"); fresh.id = "d"; fresh.setAttribute("src", "/_bots"); fresh.config = config; slot.append(fresh); };
</script></body></html>`);
        return;
      }
      // Two ways of being framed. `localhost` and `127.0.0.1` reach this same server and
      // are nonetheless different origins, which is exactly the distinction the element
      // has to draw: an admin app framing its own pages is ordinary, another site framing
      // them is the clickjacking setup.
      if (path === "/framed-same" || path === "/framed-cross") {
        const inner = path === "/framed-cross" ? embedUrl.replace("127.0.0.1", "localhost") : embedUrl;
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(`<!doctype html><html lang="en"><body><iframe src="${inner}" width="900" height="600"></iframe></body></html>`);
        return;
      }
      if (path === "/vocab" || path === "/vocab-tab" || path === "/vocab-ok") {
        const config =
          path === "/vocab" ? '{ hide: { live: true } }' : path === "/vocab-tab" ? '{ tabs: [{ id: "stats", label: "Overview" }, { id: "stat", label: "Typo" }] }' : '{ hide: { feed: true } }';
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(`<!doctype html><html lang="en"><body><bot-dashboard id="d" src="/_bots"></bot-dashboard>
<script type="module">
import { defineBotDashboard } from "/element.js";
document.getElementById("d").config = ${config};
defineBotDashboard();
</script></body></html>`);
        return;
      }
      if (path === "/theming") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(`<!doctype html><html lang="en"><body><bot-dashboard id="d" src="/_bots"></bot-dashboard>
<script type="module">
import { defineBotDashboard } from "/element.js";
const node = document.getElementById("d");
node.config = { theme: { scheme: "dark", tokens: { "--accent": "rgb(1, 2, 3)", "--bg": "rgb(4, 5, 6)" } } };
defineBotDashboard();
globalThis.dropToken = () => { node.config = { theme: { scheme: "dark", tokens: { "--accent": "rgb(1, 2, 3)" } } }; };
globalThis.badScheme = () => { for (let i = 0; i < 4; i++) node.config = { theme: { scheme: "Dark" } }; };
globalThis.badDensity = () => { node.config = { theme: { density: "cozy" } }; };
globalThis.goodDensity = () => { node.config = { theme: { density: "compact" } }; };
</script></body></html>`);
        return;
      }
      if (path === "/adopt") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(`<!doctype html><html lang="en"><body><div id="slot"></div>
<script type="module">
import { defineBotDashboard } from "/element.js";
defineBotDashboard();
const slot = document.getElementById("slot");
const mount = (id, panelId, screen) => {
  const node = document.createElement("bot-dashboard");
  node.id = id;
  node.setAttribute("src", "/_bots");
  node.config = { panels: [{ id: panelId, screen, title: panelId, source: () => ({ rows: [{ label: panelId, value: 1 }] }) }] };
  slot.append(node);
};
mount("a", "alpha", "live");
globalThis.swap = () => { document.getElementById("a").remove(); mount("b", "beta", "live"); };
globalThis.moveScreen = () => { document.getElementById("b").remove(); mount("c", "beta", "stats"); };
</script></body></html>`);
        return;
      }
      if (path === "/rerender") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(`<!doctype html><html lang="en"><body><bot-dashboard id="d" src="/_bots"></bot-dashboard>
<script type="module">
import { defineBotDashboard } from "/element.js";
const make = () => ({ theme: { scheme: "dark" }, panels: [{ id: "p", screen: "live", title: "P", source: () => ({ rows: [{ label: "a", value: 1 }] }) }] });
document.getElementById("d").config = make();
defineBotDashboard();
globalThis.rerender = () => { document.getElementById("d").config = make(); };
globalThis.retheme = () => { document.getElementById("d").config = { ...make(), theme: { scheme: "light" } }; };
globalThis.addPanel = () => {
  const next = make();
  next.panels.push({ id: "q", screen: "live", title: "Q", source: () => ({ rows: [] }) });
  document.getElementById("d").config = next;
};
</script></body></html>`);
        return;
      }
      if (path === "/withheld" || path === "/withheld-hidden") {
        // The analyst mount has `sections: { policy: false }` on the server. Asking for the
        // policy screen anyway is the case; asking for it while also hiding it is the case
        // that must stay quiet.
        const config = path === "/withheld"
          ? '{ tabs: [{ id: "live", label: "T" }, { id: "policy", label: "R" }] }'
          : '{ tabs: [{ id: "live", label: "T" }, { id: "policy", label: "R" }], hide: { policy: true } }';
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(`<!doctype html><html lang="en"><body><bot-dashboard id="d" src="/_analyst"></bot-dashboard>
<script type="module">
import { defineBotDashboard } from "/element.js";
document.getElementById("d").config = ${config};
defineBotDashboard();
</script></body></html>`);
        return;
      }
      if (path === "/srcquery" || path === "/srcfragment") {
        const src = path === "/srcquery" ? "/_bots?token=abc" : "/_bots#top";
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(`<!doctype html><html lang="en"><body><bot-dashboard id="d" src="${src}"></bot-dashboard>
<script type="module">import { defineBotDashboard } from "/element.js"; defineBotDashboard();</script></body></html>`);
        return;
      }
      if (path === "/panel-json") {
        response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ rows: [{ label: "Pending", value: 7, note: "queue" }] }));
        return;
      }
      if (path === "/panel-missing") {
        response.writeHead(404, { "content-type": "text/plain" });
        response.end("nope");
        return;
      }
      if (path === "/stringsource") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(`<!doctype html><html lang="en"><body><bot-dashboard id="d" src="/_bots"></bot-dashboard>
<script type="module">
import { defineBotDashboard } from "/element.js";
document.getElementById("d").config = { panels: [
  { id: "ok", screen: "live", title: "Checkout", source: "/panel-json" },
  { id: "missing", screen: "live", title: "Missing", source: "/panel-missing" }
]};
defineBotDashboard();
</script></body></html>`);
        return;
      }
      if (path === "/plain") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(`<!doctype html><html lang="en"><body><bot-dashboard id="d" src="/_bots"></bot-dashboard>
<script type="module">import { defineBotDashboard } from "/element.js"; defineBotDashboard();</script></body></html>`);
        return;
      }
      if (path === "/nameclash") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(`<!doctype html><html lang="en"><body><bot-dashboard id="d" src="/_bots"></bot-dashboard>
<script type="module">
customElements.define("bot-dashboard", class extends HTMLElement {});
import("/element.js").then((mod) => { mod.defineBotDashboard(); mod.defineBotDashboard(); });
</script></body></html>`);
        return;
      }
      if (path === "/duplicate") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(`<!doctype html><html lang="en"><body><bot-dashboard id="d" src="/_bots"></bot-dashboard>
<script type="module">
import { defineBotDashboard } from "/element.js";
document.getElementById("d").config = { panels: [
  { id: "p", screen: "live", title: "First", refreshMs: 1000, source: () => ({ rows: [{ label: "first", value: 1 }] }) },
  { id: "p", screen: "live", title: "Second", refreshMs: 1000, source: () => ({ rows: [{ label: "second", value: 2 }] }) }
]};
defineBotDashboard();
</script></body></html>`);
        return;
      }
      if (path === "/panelids") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(`<!doctype html><html lang="en"><body><bot-dashboard id="d" src="/_bots"></bot-dashboard>
<script type="module">
import { defineBotDashboard } from "/element.js";
globalThis.ready = false;
document.getElementById("d").addEventListener("bot-dashboard-ready", () => { globalThis.ready = true; });
document.getElementById("d").config = { panels: [
  { id: 'we"ird', screen: "live", title: "Quoted id", source: () => ({ rows: [{ label: "a", value: 1 }] }) },
  { id: "after", screen: "live", title: "After it", source: () => ({ rows: [{ label: "b", value: 2 }] }) },
  { id: "typo", screen: "nosuchscreen", title: "Typo", source: () => ({ rows: [{ label: "c", value: 3 }] }) },
]};
defineBotDashboard();
</script></body></html>`);
        return;
      }
      if (path === "/panels") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(`<!doctype html><html lang="en"><body><bot-dashboard id="d" src="/_bots"></bot-dashboard>
<script type="module">
import { defineBotDashboard } from "/element.js";
document.getElementById("d").config = { panels: [
  { id: "a", screen: "live", title: "Null", source: () => null },
  { id: "b", screen: "live", title: "String rows", source: () => ({ rows: "nope" }) },
  { id: "c", screen: "live", title: "Missing fields", source: () => ({ rows: [{}, { label: "ok", value: 1 }] }) },
  { id: "d", screen: "live", title: "Throws", source: () => { throw new Error("boom"); } },
  { id: "e", screen: "live", title: "Object value", source: () => ({ rows: [{ label: "x", value: { deep: 1 } }] }) },
  { id: "f", screen: "live", title: "Markup", source: () => ({ rows: [{ label: "l", value: "<img src=x onerror=alert(1)>" }] }) },
]};
defineBotDashboard();
</script></body></html>`);
        return;
      }
      if (path === "/huge") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(`<!doctype html><html><body><bot-dashboard id="d" src="/_bots"></bot-dashboard>
<script type="module">
import { defineBotDashboard } from "/element.js";
document.getElementById("d").config = { panels: [{ id: "big", screen: "live", title: "Huge", source: () => ({ rows: Array.from({ length: 50000 }, (_, i) => ({ label: "row " + i, value: i })) }) }] };
defineBotDashboard();
</script></body></html>`);
        return;
      }
      if (path === "/element.js") {
        response.writeHead(200, { "content-type": "text/javascript" });
        response.end(bundle);
        return;
      }
      if ((request.url ?? "").startsWith("/_analyst")) {
        void analystMounted(request, response);
        return;
      }
      if ((request.url ?? "").startsWith("/_bots")) {
        void mounted(request, response);
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(hostPage);
    });
    await new Promise<void>((resolve) => embedServer.listen(0, "127.0.0.1", () => resolve()));
    embedUrl = `http://127.0.0.1:${(embedServer.address() as { port: number }).port}/`;

    // Its own handler and listener, because this one can rewrite a live policy and the
    // other tests read the feed it would be changing underneath them.
    editableHandler = new BotHandler({ preset: "protect-content" });
    const editable = createDashboardHandler(editableHandler, {
      basePath: "/_bots",
      auth: { username: "ops", password: "a-long-enough-password-here" },
      controls: { editPolicy: true },
    });
    editableServer = createServer((request, response) => {
      const path = (request.url ?? "").split("?")[0];
      if (path === "/element.js") {
        response.writeHead(200, { "content-type": "text/javascript" });
        response.end(bundle);
        return;
      }
      if (path === "/boot.js") {
        response.writeHead(200, { "content-type": "text/javascript" });
        response.end('import { defineBotDashboard } from "/element.js"; defineBotDashboard();');
        return;
      }
      if ((request.url ?? "").startsWith("/_bots")) {
        void editable(request, response);
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end('<!doctype html><html lang="en"><body><bot-dashboard id="d" src="/_bots"></bot-dashboard><script type="module" src="/boot.js"></script></body></html>');
    });
    await new Promise<void>((resolve) => editableServer.listen(0, "127.0.0.1", () => resolve()));
    editableUrl = `http://127.0.0.1:${(editableServer.address() as { port: number }).port}/`;
  });

  afterAll(() => {
    embedServer?.close();
    editableServer?.close();
  });

  async function openEmbed(): Promise<Page> {
    const page = await browser.newPage({ viewport: { width: 1280, height: 950 } });
    await page.goto(embedUrl);
    await page.waitForFunction(() => (document.getElementById("d") as HTMLElement | null)?.shadowRoot?.querySelector("#rows") != null, undefined, { timeout: 15_000 });
    return page;
  }

  it("renders the whole dashboard into a shadow root inside the host page", async () => {
    const page = await openEmbed();
    const state = await page.evaluate(() => {
      const host = document.getElementById("d") as HTMLElement;
      const shadow = host.shadowRoot as ShadowRoot;
      return {
        brand: shadow.querySelector(".brand")?.textContent?.trim(),
        placeholders: /__[A-Z_]+__/.test(shadow.innerHTML),
        // The host document must be untouched: no stray table, no stray panel, and its
        // own heading still its own.
        leaked: document.querySelectorAll("table, .panel, .tabs").length,
        hostHeading: document.getElementById("ours")?.textContent,
      };
    });
    expect(state.brand).toContain("shop.example");
    // The title is the one placeholder the markup carries and the element substitutes it;
    // without that the header read "__TITLE__" to everyone.
    expect(state.placeholders).toBe(false);
    expect(state.leaked).toBe(0);
    expect(state.hostHeading).toBe("Our admin page");
    await page.close();
  });

  it("shows the tabs it was configured with, relabelled and reordered", async () => {
    const page = await openEmbed();
    const tabs = await page.evaluate(() =>
      Array.from(((document.getElementById("d") as HTMLElement).shadowRoot as ShadowRoot).querySelectorAll(".tab:not([hidden])")).map((tab) => tab.textContent?.trim()),
    );
    expect(tabs).toEqual(["Overview", "Traffic"]);
    await page.close();
  });

  /**
   * Custom properties set on the host inherit into the shadow tree, which is the whole
   * reason the token blocks name `:host`. Without that the element renders unthemed.
   */
  it("takes its theme from the host element", async () => {
    const page = await openEmbed();
    const theme = await page.evaluate(() => {
      const host = document.getElementById("d") as HTMLElement;
      const panel = (host.shadowRoot as ShadowRoot).querySelector(".panel") as HTMLElement;
      return {
        accent: getComputedStyle(host).getPropertyValue("--accent").trim(),
        density: host.getAttribute("data-density"),
        scheme: host.getAttribute("data-theme"),
        panelPainted: getComputedStyle(panel).backgroundColor,
      };
    });
    expect(theme.accent).toBe("#7c3aed");
    expect(theme.density).toBe("compact");
    expect(theme.scheme).toBe("light");
    expect(theme.panelPainted).not.toBe("rgba(0, 0, 0, 0)");
    await page.close();
  });

  it("renders a developer's own panel as text", async () => {
    const page = await openEmbed();
    const rows = await page.evaluate(() =>
      Array.from(((document.getElementById("d") as HTMLElement).shadowRoot as ShadowRoot).querySelectorAll(".bd-extra .row")).map((row) => row.textContent?.replace(/\s+/g, " ").trim()),
    );
    expect(rows).toEqual(["Orders42"]);
    await page.close();
  });

  /**
   * Everything below is about being a guest in somebody else's document. The dashboard
   * was written to own a page, and each of these was it still behaving as though it did.
   */
  it("leaves the host page's keyboard alone", async () => {
    const page = await openEmbed();
    const selected = (): Promise<string | undefined> =>
      page.evaluate(() =>
        Array.from(((document.getElementById("d") as HTMLElement).shadowRoot as ShadowRoot).querySelectorAll(".tab"))
          .find((tab) => tab.getAttribute("aria-selected") === "true")
          ?.textContent?.trim(),
      );
    const before = await selected();
    // A digit pressed while the host page has focus switched a tab in here, which is
    // somebody else's keyboard being taken.
    await page.locator("#ours").click();
    await page.keyboard.press("3");
    await page.waitForTimeout(200);
    expect(await selected()).toBe(before);
    await page.close();
  });

  it("leaves the host page's URL alone", async () => {
    const page = await openEmbed();
    // The standalone page writes its tab and filter into the hash so a link lands on a
    // view. Embedded, that is the host's address bar, and its back button would walk
    // through somebody's tab changes on the way out.
    await page.evaluate(() => {
      const shadow = (document.getElementById("d") as HTMLElement).shadowRoot as ShadowRoot;
      (shadow.querySelector("#tab-stats") as HTMLElement).click();
    });
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => location.hash)).toBe("");
    await page.close();
  });

  it("gives a keyboard a way past the header, which a fragment cannot do here", async () => {
    const page = await openEmbed();
    // `href="#view-live"` is inert inside a shadow root: fragment navigation does not
    // cross the boundary, so the one affordance that skips the header did nothing.
    const focused = await page.evaluate(async () => {
      const shadow = (document.getElementById("d") as HTMLElement).shadowRoot as ShadowRoot;
      (shadow.querySelector("a.skip") as HTMLAnchorElement).click();
      await new Promise((resolve) => setTimeout(resolve, 150));
      return { id: (shadow.activeElement as HTMLElement | null)?.id, hash: location.hash };
    });
    expect(focused.id).toBe("view-live");
    expect(focused.hash).toBe("");
    await page.close();
  });

  /**
   * What a router does on every navigation. The first version refused the second mount
   * outright, which made the element unusable in React, Vue or anything else with one.
   */
  it("survives being unmounted and mounted again, with its history", async () => {
    const page = await openEmbed();
    await embedHandler.handle(
      createFacts({ method: "GET", url: "/products", headers: { host: "shop.test", "user-agent": "curl/8.4.0", accept: "*/*" }, ip: "203.0.113.71" }),
    );
    await expect
      .poll(() => page.evaluate(() => ((document.getElementById("d") as HTMLElement).shadowRoot as ShadowRoot).querySelectorAll("tbody tr.row").length), { timeout: 10_000 })
      .toBeGreaterThan(0);

    await page.evaluate(() => {
      const slot = document.getElementById("d")?.parentElement as HTMLElement;
      slot.innerHTML = "";
      const fresh = document.createElement("bot-dashboard");
      fresh.id = "d";
      fresh.setAttribute("src", "/_bots");
      slot.append(fresh);
    });
    await page.waitForTimeout(1200);

    const after = await page.evaluate(() => {
      const shadow = (document.getElementById("d") as HTMLElement).shadowRoot as ShadowRoot;
      return {
        refused: shadow.textContent?.includes("already running") === true,
        rows: shadow.querySelectorAll("tbody tr.row").length,
        tiles: shadow.querySelectorAll(".tile").length,
      };
    });
    expect(after.refused).toBe(false);
    expect(after.tiles).toBeGreaterThan(0);
    // The feed it had built is still there rather than starting empty.
    expect(after.rows).toBeGreaterThan(0);

    // And it is still live, not a corpse of the previous mount.
    await embedHandler.handle(
      createFacts({ method: "GET", url: "/products", headers: { host: "shop.test", "user-agent": "python-requests/2.32.3", accept: "*/*" }, ip: "203.0.113.72" }),
    );
    await expect
      .poll(() => page.evaluate(() => ((document.getElementById("d") as HTMLElement).shadowRoot as ShadowRoot).querySelectorAll("tbody tr.row").length), { timeout: 10_000 })
      .toBeGreaterThan(after.rows);
    await page.close();
  });

  /**
   * A host page with a strict Content-Security-Policy, which is what an admin page ought
   * to have — and therefore the page this element is most likely to be mounted on.
   *
   * An injected `<style>` element is inline style, so `style-src 'self'` blocks it and the
   * dashboard renders with no colours, no radii and no layout at all. A constructable
   * stylesheet built by script that has already satisfied `script-src` is not inline style
   * and is not blocked.
   */
  it("styles itself under a strict style-src", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const violations: string[] = [];
    page.on("console", (message) => {
      if (/Content Security Policy|Refused/.test(message.text())) violations.push(message.text());
    });
    await page.goto(`${embedUrl}strict`);
    await page.waitForFunction(() => (document.getElementById("d") as HTMLElement | null)?.shadowRoot?.querySelector(".panel") != null, undefined, { timeout: 15_000 });
    const painted = await page.evaluate(() => {
      const shadow = (document.getElementById("d") as HTMLElement).shadowRoot as ShadowRoot;
      const panel = shadow.querySelector(".panel") as HTMLElement;
      return { radius: getComputedStyle(panel).borderRadius, background: getComputedStyle(panel).backgroundColor, adopted: shadow.adoptedStyleSheets.length };
    });
    expect(painted.adopted).toBeGreaterThan(0);
    expect(painted.radius).not.toBe("0px");
    expect(painted.background).not.toBe("rgba(0, 0, 0, 0)");
    expect(violations).toEqual([]);
    await page.close();
  });

  it("closes its stream when it is removed, and picks it up again", async () => {
    const page = await openEmbed();
    await expect.poll(() => embedStreams, { timeout: 10_000 }).toBe(1);

    await page.evaluate(() => {
      (document.getElementById("d")?.parentElement as HTMLElement).innerHTML = "";
    });
    // Left open it holds a server connection and keeps drawing into a tree nobody can
    // see, for as long as the page lives.
    await expect.poll(() => embedStreams, { timeout: 10_000 }).toBe(0);

    // Traffic while it is away, which resuming should collect rather than miss.
    await embedHandler.handle(
      createFacts({ method: "GET", url: "/products", headers: { host: "shop.test", "user-agent": "curl/8.4.0", accept: "*/*" }, ip: "203.0.113.81" }),
    );
    await page.evaluate(() => {
      const slot = document.getElementById("slot") as HTMLElement;
      const fresh = document.createElement("bot-dashboard");
      fresh.id = "d";
      fresh.setAttribute("src", "/_bots");
      slot.append(fresh);
    });
    await expect.poll(() => embedStreams, { timeout: 10_000 }).toBe(1);
    await expect
      .poll(() => page.evaluate(() => ((document.getElementById("d") as HTMLElement).shadowRoot as ShadowRoot).querySelectorAll("tbody tr.row").length), { timeout: 10_000 })
      .toBeGreaterThan(0);
    await page.close();
  });

  it("bounds what a panel can put on the page", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(`${embedUrl}huge`);
    await page.waitForFunction(() => ((document.getElementById("d") as HTMLElement | null)?.shadowRoot?.querySelectorAll(".bd-extra .row").length ?? 0) > 0, undefined, { timeout: 15_000 });
    const rows = await page.evaluate(() => {
      const shadow = (document.getElementById("d") as HTMLElement).shadowRoot as ShadowRoot;
      const all = Array.from(shadow.querySelectorAll(".bd-extra .row"));
      return { count: all.length, last: all.at(-1)?.textContent?.trim() };
    });
    // A panel is a summary. Laying out fifty thousand rows locks up somebody's admin page.
    expect(rows.count).toBeLessThan(300);
    expect(rows.last).toContain("more not shown");
    await page.close();
  });

  it("says what is wrong when it has nowhere to fetch from", async () => {
    const page = await browser.newPage();
    await page.goto(`${embedUrl}nosrc`);
    await page.waitForFunction(() => ((document.getElementById("d") as HTMLElement | null)?.shadowRoot?.textContent ?? "").length > 0, undefined, { timeout: 15_000 });
    const shown = await page.evaluate(() => ((document.getElementById("d") as HTMLElement).shadowRoot as ShadowRoot).textContent ?? "");
    // Without `src` it asks its own origin, is handed the host page's HTML, and the
    // parser's account of that — "Unexpected token '<'" — tells a developer nothing about
    // the attribute they forgot.
    expect(shown).toContain("src");
    expect(shown).not.toContain("Unexpected token");
    await page.close();
  });

  /**
   * The element is a second rendering context and had never been audited as one. Three
   * things only went wrong inside a shadow root:
   *
   * - A shadow root has no `body`, so nothing set the base colour or type and everything
   *   inherited the host page's. On a white page that passed for correct; in dark mode it
   *   was near-black text on a near-black surface.
   * - The page's own `<main>` is a landmark, and a second one inside a host page that
   *   already has one gives a screen reader user two "main" landmarks to choose between.
   * - Re-roling that `<main>` to a region silences those and earns `aria-allowed-role`
   *   instead, because `<main>` permits no role but its own.
   */
  for (const scheme of ["light", "dark"] as const) {
    it(`has nothing for axe to report inside a host page, in ${scheme}`, async () => {
      const page = await browser.newPage({ viewport: { width: 1280, height: 950 }, colorScheme: scheme });
      await page.goto(embedUrl);
      await page.waitForFunction(() => (document.getElementById("d") as HTMLElement | null)?.shadowRoot?.querySelector(".panel") != null, undefined, { timeout: 15_000 });
      await page.evaluate(axeSource);
      const result = (await page.evaluate(async () => {
        const axe = (globalThis as unknown as { axe: { run: (context: unknown, options: unknown) => Promise<unknown> } }).axe;
        return await axe.run(document, { resultTypes: ["violations"] });
      })) as { violations: Array<{ id: string; impact: string | null; nodes: Array<{ target: unknown[] }> }> };
      expect(result.violations.map((violation) => `${violation.id} (${violation.impact})`).join("\n")).toBe("");
      await page.close();
    });
  }

  it("paints its own ink and surface rather than inheriting the page's", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 950 }, colorScheme: "dark" });
    await page.goto(embedUrl);
    await page.waitForFunction(() => (document.getElementById("d") as HTMLElement | null)?.shadowRoot?.querySelector(".panel") != null, undefined, { timeout: 15_000 });
    const painted = await page.evaluate(() => {
      const host = document.getElementById("d") as HTMLElement;
      const panel = (host.shadowRoot as ShadowRoot).querySelector(".panel") as HTMLElement;
      return { surface: getComputedStyle(host).backgroundColor, ink: getComputedStyle(panel).color };
    });
    // In dark mode the inherited value was black, on a near-black surface.
    expect(painted.ink).not.toBe("rgb(0, 0, 0)");
    expect(painted.surface).not.toBe("rgba(0, 0, 0, 0)");
    await page.close();
  });

  it("does not add a second main landmark to the host page", async () => {
    const page = await openEmbed();
    const landmarks = await page.evaluate(() => {
      const shadow = (document.getElementById("d") as HTMLElement).shadowRoot as ShadowRoot;
      return {
        inShadow: shadow.querySelectorAll("main").length,
        region: shadow.querySelector('[role="region"]')?.getAttribute("aria-label"),
      };
    });
    expect(landmarks.inShadow).toBe(0);
    expect(landmarks.region).toContain("bot dashboard");
    await page.close();
  });

  /**
   * A panel's source is somebody else's endpoint, so what it returns is data rather than a
   * contract. Each of these was drawn as-is before it was checked — `{ rows: "nope" }`
   * most memorably, because a string is iterable and it rendered one row per character,
   * every one of them reading "undefined".
   */
  it("survives whatever a panel source returns", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const dialogs: string[] = [];
    page.on("dialog", (dialog) => {
      dialogs.push(dialog.message());
      void dialog.dismiss();
    });
    await page.goto(`${embedUrl}panels`);
    await page.waitForFunction(() => ((document.getElementById("d") as HTMLElement | null)?.shadowRoot?.querySelectorAll("[data-bd-panel]").length ?? 0) >= 5, undefined, { timeout: 15_000 });
    await page.waitForTimeout(600);

    const panels = await page.evaluate(() => {
      const shadow = (document.getElementById("d") as HTMLElement).shadowRoot as ShadowRoot;
      const read = (id: string): { rows: number; text: string } => {
        const section = shadow.querySelector(`[data-bd-panel="${id}"]`) as HTMLElement;
        return { rows: section.querySelectorAll(".bd-extra .row").length, text: (section.querySelector(".bd-extra") as HTMLElement).textContent ?? "" };
      };
      return { a: read("a"), b: read("b"), c: read("c"), d: read("d"), e: read("e") };
    });

    expect(panels.a.text).toContain("no rows");        // null
    expect(panels.b.rows).toBe(0);                     // rows is a string, not an array
    expect(panels.b.text).not.toContain("undefined");
    expect(panels.c.rows).toBe(1);                     // one row was unusable, one was not
    expect(panels.c.text).not.toContain("undefined");
    expect(panels.d.text).toContain("Could not load"); // the source threw
    expect(panels.e.text).toContain('{"deep":1}');     // an object, said rather than "[object Object]"

    // And markup in a value stays a value.
    const injected = await page.evaluate(() => {
      const section = ((document.getElementById("d") as HTMLElement).shadowRoot as ShadowRoot).querySelector('[data-bd-panel="f"]') as HTMLElement;
      return { images: section.querySelectorAll("img").length, text: section.textContent ?? "" };
    });
    expect(injected.images).toBe(0);
    expect(injected.text).toContain("<img src=x");
    expect(dialogs).toEqual([]);
    await page.close();
  });

  /**
   * The two-column grid used to ask the *viewport* how much room it had, which is the
   * same wrong-box mistake the feed table's own breakpoints made one level down. Embedded
   * in a 320px sidebar on a 1280px screen the media query never fired, the right-hand
   * column held its 280px minimum, and the feed was squeezed to twenty-two pixels.
   */
  it("lays out against its container, not the window", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(`${embedUrl}narrow`);
    await page.waitForFunction(() => (document.getElementById("d") as HTMLElement | null)?.shadowRoot?.querySelector("#rows") != null, undefined, { timeout: 15_000 });
    const measured = await page.evaluate(() => {
      const shadow = (document.getElementById("d") as HTMLElement).shadowRoot as ShadowRoot;
      const wrap = shadow.querySelector(".feed-scroll") as HTMLElement;
      return { host: (document.getElementById("d") as HTMLElement).clientWidth, feed: wrap.clientWidth };
    });
    expect(measured.host).toBeLessThan(400);
    // The feed gets essentially the whole column rather than what is left after a
    // second one it has no room for.
    expect(measured.feed).toBeGreaterThan(measured.host * 0.8);
    await page.close();
  });

  it("keeps a refreshing panel refreshing after a route change", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(`${embedUrl}ticker`);
    await page.waitForFunction(() => (document.getElementById("d") as HTMLElement | null)?.shadowRoot?.querySelector('[data-bd-panel="t"] .bd-extra b') != null, undefined, { timeout: 15_000 });
    const tick = async (): Promise<number> =>
      Number(await page.evaluate(() => ((document.getElementById("d") as HTMLElement).shadowRoot as ShadowRoot).querySelector('[data-bd-panel="t"] .bd-extra b')?.textContent ?? "0"));

    await page.evaluate(() => (globalThis as unknown as { remount: () => void }).remount());
    await page.waitForTimeout(600);
    const afterRemount = await tick();
    // `disconnectedCallback` clears the interval, and the remount path reused the existing
    // section without re-arming it — so the panel froze on whatever it last drew.
    await expect.poll(() => tick(), { timeout: 10_000 }).toBeGreaterThan(afterRemount);
    await page.close();
  });

  /**
   * What React 18 in development does to every component: mount, unmount, mount again,
   * synchronously. A custom element that assumes its first connect is its only one breaks
   * here, and breaks only for people running a dev build.
   */
  /**
   * The environment where saving was broken outright. An embedded dashboard never touches
   * the host page's storage, so under the old browser-only design nothing it saved was
   * kept anywhere. The listener keeps it now.
   */
  it("saves a filter from inside a host page", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(embedUrl);
    await page.waitForFunction(() => (document.getElementById("d") as HTMLElement | null)?.shadowRoot?.querySelector("#saved-filters button") != null, undefined, { timeout: 15_000 });
    await page.locator("#search").fill("path:/embedded");
    await page.locator('#saved-filters button:has-text("Save")').click();
    await page.locator("#saved-filters input.saved-name").fill("embedded-saved");
    await page.locator("#saved-filters input.saved-name").press("Enter");
    await expect.poll(() => page.locator("#saved-filters select option", { hasText: "embedded-saved" }).count(), { timeout: 5_000 }).toBe(1);
    // And nothing was written into the host page's storage, which is not ours to write.
    expect(await page.evaluate(() => localStorage.getItem("bothandler.filters"))).toBeNull();

    await page.locator("#saved-filters select").selectOption("embedded-saved");
    await page.locator('#saved-filters button:has-text("Delete")').click();
    await expect.poll(() => page.locator("#saved-filters select option", { hasText: "embedded-saved" }).count(), { timeout: 5_000 }).toBe(0);
    await page.close();
  });

  it("survives a synchronous mount, unmount, mount", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const failures: string[] = [];
    page.on("pageerror", (error) => failures.push(String(error)));
    // Every API call the page makes, so the assertion below can be about *where* it
    // asked rather than about whether anything happened to throw on the way.
    const asked: string[] = [];
    page.on("request", (request) => {
      const { pathname } = new URL(request.url());
      if (pathname.includes("/api/")) asked.push(pathname);
    });
    await page.goto(`${embedUrl}strictmode`);
    await page.waitForFunction(() => (document.getElementById("d") as HTMLElement | null)?.shadowRoot?.querySelector("#rows") != null, undefined, { timeout: 15_000 });
    const state = await page.evaluate(() => {
      const shadow = (document.getElementById("d") as HTMLElement).shadowRoot as ShadowRoot;
      return { elements: document.querySelectorAll("bot-dashboard").length, refused: shadow.textContent?.includes("already running") === true, panels: shadow.querySelectorAll(".panel").length };
    });
    expect(state.elements).toBe(1);
    expect(state.refused).toBe(false);
    expect(state.panels).toBeGreaterThan(0);
    expect(failures).toEqual([]);

    // The assertion this test needed and did not have.
    //
    // `disconnectedCallback` imports `stream.js` to close the stream, `stream.js` imports
    // `boot.js`, and `boot.js` used to read the mount path off the global once, when it
    // was first evaluated. Removing the element before its bootstrap fetch returned
    // evaluated it early, with nothing on the global yet, so the base froze at "" — and
    // every subsequent request went to the *host page's* origin root rather than to
    // `src`. Nothing threw. The dashboard simply drew no traffic while posting
    // `/api/stream` at somebody else's router, and the only outward sign was an
    // EventSource complaining about a MIME type on whichever engine reported it.
    await expect.poll(() => asked.some((path) => path.endsWith("/api/stream")), { timeout: 10_000 }).toBe(true);
    const astray = asked.filter((path) => !path.startsWith("/_bots/"));
    expect(astray, "every call belongs under the mount path the element was given").toEqual([]);
    await page.close();
  });

  /**
   * Two on one page: the second says so rather than fighting the first for the client's
   * module state. But the refusal is about the moment, not about the element — a router
   * that mounts the replacement before unmounting the old one produces exactly this race,
   * and the loser has to be able to take over once it is alone. It could not: the refusal
   * latched, so the survivor stayed dead for the life of the instance.
   */
  it("refuses the second of two, and hands over when the first leaves", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const failures: string[] = [];
    page.on("pageerror", (error) => failures.push(String(error)));
    await page.goto(`${embedUrl}two`);
    const state = (id: string): Promise<{ running: boolean; refused: boolean }> =>
      page.evaluate((which) => {
        const shadow = (document.getElementById(which) as HTMLElement | null)?.shadowRoot;
        return {
          running: shadow?.querySelector("#rows") != null,
          refused: shadow?.textContent?.includes("already running") === true,
        };
      }, id);
    await expect.poll(async () => (await state("a")).running, { timeout: 15_000 }).toBe(true);
    expect(await state("b")).toEqual({ running: false, refused: true });

    await page.evaluate(() => (globalThis as unknown as { handOver: () => void }).handOver());
    // The one that lost the race now owns the page, and the message from the attempt it
    // lost is gone rather than sitting above a working dashboard.
    await expect.poll(async () => (await state("b")).running, { timeout: 15_000 }).toBe(true);
    expect((await state("b")).refused).toBe(false);
    expect(failures).toEqual([]);
    await page.close();
  });

  /**
   * Panel ids and screens are strings from somebody's config, and both were interpolated
   * into selectors. An id with a quote in it threw `SyntaxError` out of `querySelector`
   * from outside the per-panel guard, so no panel was built at all, the ready event never
   * fired, and the only trace was a complaint about a selector nobody had written. A typo
   * in `screen` was the opposite failure: perfectly silent.
   */
  it("survives an awkward panel id, and says so when a screen does not exist", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const failures: string[] = [];
    const warnings: string[] = [];
    page.on("pageerror", (error) => failures.push(String(error)));
    page.on("console", (message) => {
      if (message.type() === "error") failures.push(message.text());
      if (message.type() === "warning") warnings.push(message.text());
    });
    await page.goto(`${embedUrl}panelids`);
    await page.waitForFunction(() => (globalThis as unknown as { ready: boolean }).ready === true, undefined, { timeout: 15_000 });

    const panels = await page.evaluate(() =>
      Array.from(((document.getElementById("d") as HTMLElement).shadowRoot as ShadowRoot).querySelectorAll("[data-bd-panel]")).map((node) => node.getAttribute("data-bd-panel")),
    );
    // The quoted id renders, and — the part that was actually broken — so does the panel
    // declared after it.
    expect(panels).toContain('we"ird');
    expect(panels).toContain("after");
    expect(failures).toEqual([]);
    // And the one pointing at a screen that does not exist names the ones that do, rather
    // than disappearing.
    expect(warnings.join(" ")).toContain("nosuchscreen");
    expect(warnings.join(" ")).toContain("live");
    await page.close();
  });

  /**
   * A framework re-renders by assigning `config` again, with a freshly built object every
   * time. `theme` is meant to take effect; `tabs` and `panels` are read once and are meant
   * to say so rather than doing nothing quietly, the way `src` already did. Both halves
   * have a way to be wrong, and both were: nothing was said about panels at all, and the
   * first attempt at saying it fired on the ordinary mount — because `connectedCallback`
   * replays a pre-upgrade config through the setter, which looked exactly like a change.
   */
  it("takes a theme change on re-render, and warns only when the panels really differ", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const warnings: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "warning") warnings.push(message.text());
    });
    await page.goto(`${embedUrl}rerender`);
    await page.waitForFunction(() => (document.getElementById("d") as HTMLElement | null)?.shadowRoot?.querySelector("#rows") != null, undefined, { timeout: 15_000 });
    expect(warnings).toEqual([]);

    for (let i = 0; i < 5; i++) await page.evaluate(() => (globalThis as unknown as { rerender: () => void }).rerender());
    expect(warnings).toEqual([]);

    await page.evaluate(() => (globalThis as unknown as { retheme: () => void }).retheme());
    expect(await page.evaluate(() => (document.getElementById("d") as HTMLElement).getAttribute("data-theme"))).toBe("light");
    expect(warnings).toEqual([]);

    await page.evaluate(() => (globalThis as unknown as { addPanel: () => void }).addPanel());
    expect(warnings.join(" ")).toContain("read once");
    await page.close();
  });

  /**
   * The rendered tree outlives the element that built it — that is what makes a remount
   * keep its history — but on a route change it is adopted by a *different* element with a
   * different config. Without a sweep the new dashboard drew the old one's panels next to
   * its own, and drew them frozen, because the timer feeding them died with the element
   * that registered it.
   */
  it("does not inherit the panels of the element it replaced", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const failures: string[] = [];
    page.on("pageerror", (error) => failures.push(String(error)));
    await page.goto(`${embedUrl}adopt`);
    await page.waitForFunction(() => (document.getElementById("a") as HTMLElement | null)?.shadowRoot?.querySelector("#rows") != null, undefined, { timeout: 15_000 });

    const panelsOf = (id: string): Promise<string[]> =>
      page.evaluate((which) => {
        const shadow = (document.getElementById(which) as HTMLElement | null)?.shadowRoot;
        const found: string[] = [];
        shadow?.querySelectorAll("[data-bd-panel]").forEach((node) => found.push(`${node.getAttribute("data-bd-panel")}@${node.getAttribute("data-bd-screen")}`));
        return found;
      }, id);

    await page.evaluate(() => (globalThis as unknown as { swap: () => void }).swap());
    await expect.poll(() => panelsOf("b"), { timeout: 15_000 }).toEqual(["beta@live"]);

    // And a panel that moved to another screen is on the new one only, rather than drawn
    // in both because the reuse lookup is scoped per screen.
    await page.evaluate(() => (globalThis as unknown as { moveScreen: () => void }).moveScreen());
    await expect.poll(() => panelsOf("c"), { timeout: 15_000 }).toEqual(["beta@stats"]);
    expect(failures).toEqual([]);
    await page.close();
  });

  /**
   * The standalone dashboard is served by this package and refuses to be framed —
   * `frame-ancestors 'none'` is on its response. The element renders into a document this
   * package does not serve and cannot put a header on, so that protection simply does not
   * come along, and an operator can be shown a control they cannot see. It cannot be fixed
   * from here; it can stop being silent.
   */
  it("says so when the page it is embedded in is framed by another origin", async () => {
    const framingWarnings = async (path: string): Promise<string[]> => {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      const warnings: string[] = [];
      page.on("console", (message) => {
        if (message.type() === "warning" && message.text().includes("framed")) warnings.push(message.text());
      });
      await page.goto(`${embedUrl}${path}`);
      // The warning is raised by the dashboard inside the frame, once it has drawn.
      await page.waitForTimeout(3000);
      await page.close();
      return warnings;
    };

    // An admin app framing its own pages is legitimate and stays quiet.
    expect(await framingWarnings("framed-same")).toEqual([]);

    const crossOrigin = await framingWarnings("framed-cross");
    expect(crossOrigin.length).toBe(1);
    expect(crossOrigin[0]).toContain("frame-ancestors");
  });

  /**
   * Three ways a theme could be wrong in silence. A token dropped from the config stayed
   * painted on the element for ever, so switching themes accumulated the union of every
   * theme ever set. A mis-typed `scheme` did nothing. A mis-typed `density` was worse than
   * nothing: it was written on as `data-density="cozy"`, matched no rule, and looked like
   * an element ignoring its own configuration.
   */
  it("drops tokens the theme stopped asking for, and refuses values it does not have", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const warnings: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "warning") warnings.push(message.text());
    });
    await page.goto(`${embedUrl}theming`);
    await page.waitForFunction(() => (document.getElementById("d") as HTMLElement | null)?.shadowRoot?.querySelector("#rows") != null, undefined, { timeout: 15_000 });

    const style = (): Promise<string> => page.evaluate(() => (document.getElementById("d") as HTMLElement).getAttribute("style") ?? "");
    expect(await style()).toContain("--bg");

    await page.evaluate(() => (globalThis as unknown as { dropToken: () => void }).dropToken());
    const after = await style();
    expect(after).not.toContain("--bg");
    // The token it still asks for stays, and so does the one the client set for itself —
    // removal is by name rather than by clearing the attribute, which would take the
    // sticky header's measured height with it.
    expect(after).toContain("--accent");
    expect(after).toContain("--header-h");

    await page.evaluate(() => (globalThis as unknown as { badScheme: () => void }).badScheme());
    // Four assignments, one warning: `applyTheme` runs on every re-render, and a typo
    // repeated a hundred times is a typo the console has stopped conveying.
    expect(warnings.filter((line) => line.includes("scheme")).length).toBe(1);

    await page.evaluate(() => (globalThis as unknown as { badDensity: () => void }).badDensity());
    expect(await page.evaluate(() => (document.getElementById("d") as HTMLElement).getAttribute("data-density"))).toBeNull();
    expect(warnings.filter((line) => line.includes("density")).length).toBe(1);

    await page.evaluate(() => (globalThis as unknown as { goodDensity: () => void }).goodDensity());
    expect(await page.evaluate(() => (document.getElementById("d") as HTMLElement).getAttribute("data-density"))).toBe("compact");
    await page.close();
  });

  /**
   * `tabs` names screens and `hide` names sections, and the two lists are not the same
   * words — the live feed is the `live` tab and the `feed` section. TypeScript refuses the
   * wrong one; plain JavaScript did not, and `hide: { live: true }` — the obvious thing to
   * write after reading about `tabs` — hid nothing at all and said nothing about it. A
   * screen listed in `tabs` under a name that does not exist was dropped just as quietly,
   * so asking for two screens and getting one looked like the element deciding for itself.
   */
  it("says which of `tabs` and `hide` a misplaced name belongs to", async () => {
    const visit = async (path: string): Promise<{ tabs: string[]; warnings: string[] }> => {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      const warnings: string[] = [];
      page.on("console", (message) => {
        if (message.type() === "warning") warnings.push(message.text());
      });
      await page.goto(`${embedUrl}${path}`);
      await page.waitForFunction(() => (document.getElementById("d") as HTMLElement | null)?.shadowRoot?.querySelector('[role="tab"]') != null, undefined, { timeout: 15_000 });
      const tabs = await page.evaluate(() => {
        const found: string[] = [];
        (document.getElementById("d") as HTMLElement).shadowRoot?.querySelectorAll('[role="tab"]').forEach((node) => {
          if ((node as HTMLElement).getClientRects().length > 0) found.push(node.id.replace("tab-", ""));
        });
        return found;
      });
      await page.close();
      return { tabs, warnings };
    };

    // A tab name in `hide` hides nothing, and is told which section name to use instead.
    const wrongList = await visit("vocab");
    expect(wrongList.tabs).toContain("live");
    expect(wrongList.warnings.join(" ")).toContain("hide.feed");

    // A screen name that does not exist at all, in `tabs`.
    const typo = await visit("vocab-tab");
    expect(typo.tabs).toEqual(["stats"]);
    expect(typo.warnings.join(" ")).toContain('"stat"');

    // And the name that is actually right stays silent and works.
    const right = await visit("vocab-ok");
    expect(right.tabs).not.toContain("live");
    expect(right.warnings).toEqual([]);
  });

  /**
   * Windows High Contrast and the rest. The browser repaints text, backgrounds and borders
   * from the user's palette and leaves SVG fill and stroke alone — which is what keeps the
   * two series tellable apart rather than collapsing them into one system colour — but it
   * also leaves the gridlines in `--grid`, a colour chosen to recede against this
   * dashboard's own background. Against a forced black one it recedes to 1.4:1, measured,
   * which is not recessive; it is gone, and the charts lose the frame they are read
   * against.
   */
  it("keeps the chart gridlines visible under forced colours", async () => {
    const contrast = (a: string, b: string): number => {
      const channel = (colour: string): number[] => (colour.match(/\d+(\.\d+)?/g) ?? ["0", "0", "0"]).map(Number);
      const luminance = (colour: string): number => {
        const [r = 0, g = 0, blue = 0] = channel(colour).map((value) => {
          const scaled = value / 255;
          return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * blue;
      };
      const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
      return (high + 0.05) / (low + 0.05);
    };

    const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, forcedColors: "active", colorScheme: "dark" });
    const page = await context.newPage();
    await embedHandler.handle(
      createFacts({ method: "GET", url: "/x", headers: { host: "shop.test", "user-agent": "curl/8.4.0", accept: "*/*" }, ip: "203.0.113.88" }),
    );
    await page.goto(embedUrl);
    await page.waitForFunction(() => (document.getElementById("d") as HTMLElement | null)?.shadowRoot?.querySelector("#rows tr") != null, undefined, { timeout: 15_000 });
    // Explicitly dark, because that is the half of the problem. The light palette's
    // gridline is a pale grey and lands on the forced black background at 18:1 by luck —
    // asserting against it passes whatever the stylesheet says. The dark palette's is
    // near-black, which is the combination that disappeared.
    await page.evaluate(() => (document.getElementById("d") as HTMLElement).setAttribute("scheme", "dark"));
    await page.evaluate(() => ((document.getElementById("d") as HTMLElement).shadowRoot as ShadowRoot).querySelector<HTMLElement>("#tab-stats")?.click());

    await expect
      .poll(() => page.evaluate(() => ((document.getElementById("d") as HTMLElement).shadowRoot as ShadowRoot).querySelectorAll("svg .gridline").length), { timeout: 15_000 })
      .toBeGreaterThan(0);

    const measured = await page.evaluate(() => {
      const shadow = (document.getElementById("d") as HTMLElement).shadowRoot as ShadowRoot;
      const background = (node: Element): string => {
        let walk: Element | null = node;
        while (walk !== null) {
          const colour = getComputedStyle(walk).backgroundColor;
          if (colour !== "rgba(0, 0, 0, 0)" && colour !== "transparent") return colour;
          walk = walk.parentElement;
        }
        return "rgb(255, 255, 255)";
      };
      const lines = Array.from(shadow.querySelectorAll("svg .gridline"));
      const svg = shadow.querySelector("svg") as SVGElement;
      return { strokes: Array.from(new Set(lines.map((line) => getComputedStyle(line).stroke))), background: background(svg) };
    });

    expect(measured.strokes.length).toBeGreaterThan(0);
    for (const stroke of measured.strokes) {
      expect(contrast(stroke, measured.background)).toBeGreaterThan(3);
    }
    await context.close();
  });

  /**
   * An id identifies a panel, and two panels claiming one landed on a single section: the
   * first built it, the second painted over it, and then both refresh timers wrote into
   * the same body once a second. The section kept the first panel's heading while showing
   * the second one's rows, so the screen described itself wrongly and then changed its mind
   * every second.
   */
  it("ignores a second panel claiming an id that is already taken", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const warnings: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "warning") warnings.push(message.text());
    });
    await page.goto(`${embedUrl}duplicate`);
    await page.waitForFunction(() => (document.getElementById("d") as HTMLElement | null)?.shadowRoot?.querySelector('[data-bd-panel="p"] .bd-extra') != null, undefined, { timeout: 15_000 });

    const read = (): Promise<{ count: number; title: string; body: string }> =>
      page.evaluate(() => {
        const sections = Array.from(((document.getElementById("d") as HTMLElement).shadowRoot as ShadowRoot).querySelectorAll('[data-bd-panel="p"]'));
        return {
          count: sections.length,
          title: sections[0]?.querySelector("h2")?.textContent ?? "",
          body: (sections[0]?.querySelector(".bd-extra")?.textContent ?? "").trim(),
        };
      });

    const first = await read();
    expect(first.count).toBe(1);
    // The heading and the rows come from the same panel.
    expect(first.title).toBe("First");
    expect(first.body).toContain("first");

    // And it stays that way rather than alternating with the other panel's timer.
    await page.waitForTimeout(2600);
    expect(await read()).toEqual(first);
    expect(warnings.join(" ")).toContain("share the id");
    await page.close();
  });

  /**
   * Somebody else's element already holds the name. `customElements.define` would throw,
   * so the guard returned early — and returned early in silence, which meant the call did
   * nothing, every `<bot-dashboard>` on the page belonged to the other library, and the
   * blank space where the dashboard should be said nothing about why. Calling this
   * function twice is ordinary and still says nothing; a name held by something else is
   * not.
   */
  it("says when its element name is already taken by something else", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const warnings: string[] = [];
    const failures: string[] = [];
    page.on("pageerror", (error) => failures.push(String(error)));
    page.on("console", (message) => {
      if (message.type() === "warning") warnings.push(message.text());
    });
    await page.goto(`${embedUrl}nameclash`);
    await page.waitForTimeout(2500);

    // No dashboard, because the name is not ours — but a reason for it.
    expect(await page.evaluate(() => (document.getElementById("d") as HTMLElement).shadowRoot?.querySelector("#rows") != null)).toBe(false);
    const clash = warnings.filter((line) => line.includes("already registered"));
    // Said once, though `defineBotDashboard` was called twice.
    expect(clash.length).toBe(1);
    expect(clash[0]).toContain("defineBotDashboard(");
    expect(failures).toEqual([]);
    await page.close();
  });

  /**
   * A screen can be missing for two different reasons, and only one of them is on this
   * page. `sections` on the handler withholds the data itself — that is the point of it,
   * and the element neither can nor should override it. But the developer configuring
   * `tabs` sees one screen where they asked for two, and the file to go and fix is a
   * different one on the server, which nothing said.
   */
  it("names the server as the reason a listed screen is missing", async () => {
    const visit = async (path: string): Promise<{ tabs: string[]; warnings: string[] }> => {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      const warnings: string[] = [];
      page.on("console", (message) => {
        if (message.type() === "warning") warnings.push(message.text());
      });
      await page.goto(`${embedUrl}${path}`);
      await page.waitForFunction(() => (document.getElementById("d") as HTMLElement | null)?.shadowRoot?.querySelector('[role="tab"]') != null, undefined, { timeout: 15_000 });
      const tabs = await page.evaluate(() => {
        const found: string[] = [];
        (document.getElementById("d") as HTMLElement).shadowRoot?.querySelectorAll('[role="tab"]').forEach((node) => {
          if ((node as HTMLElement).getClientRects().length > 0) found.push(node.id.replace("tab-", ""));
        });
        return found;
      });
      await page.close();
      return { tabs, warnings };
    };

    const asked = await visit("withheld");
    expect(asked.tabs).not.toContain("policy");
    expect(asked.warnings.join(" ")).toContain("sections");
    expect(asked.warnings.join(" ")).toContain("createDashboardHandler");

    // Hidden on purpose as well: they already know, so nothing is said.
    const deliberate = await visit("withheld-hidden");
    expect(deliberate.tabs).not.toContain("policy");
    expect(deliberate.warnings).toEqual([]);
  });

  /**
   * The element asks for `<src>/api/bootstrap`, so a query string or fragment on `src`
   * cannot survive the concatenation and never could. Left on, it produced "it answered
   * text/html — is createDashboardHandler mounted at /_bots?token=abc?", which sends
   * somebody off to check the one part of their setup that was correct.
   */
  it("ignores a query or fragment on src, and says it did", async () => {
    for (const [path, what] of [["srcquery", "query string"], ["srcfragment", "fragment"]] as const) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      const warnings: string[] = [];
      page.on("console", (message) => {
        if (message.type() === "warning") warnings.push(message.text());
      });
      await page.goto(`${embedUrl}${path}`);
      // It works rather than failing — the path was always the meaningful part.
      await page.waitForFunction(() => (document.getElementById("d") as HTMLElement | null)?.shadowRoot?.querySelector("#rows") != null, undefined, { timeout: 15_000 });
      expect(warnings.join(" ")).toContain(what);
      await page.close();
    }
  });

  /**
   * A panel `source` may be a URL rather than a function — it is the first example in the
   * documentation, and it had no test at all. Both halves matter: the endpoint that answers
   * with rows, and the one that does not, which has to say so in the panel rather than
   * leaving an empty box that reads as "nothing to report".
   */
  it("draws a panel whose source is a URL, and reports one that fails", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const failures: string[] = [];
    page.on("pageerror", (error) => failures.push(String(error)));
    await page.goto(`${embedUrl}stringsource`);
    await page.waitForFunction(() => (document.getElementById("d") as HTMLElement | null)?.shadowRoot?.querySelector('[data-bd-panel="ok"] .bd-extra') != null, undefined, { timeout: 15_000 });

    const read = (id: string): Promise<string> =>
      page.evaluate(
        (which) => (((document.getElementById("d") as HTMLElement).shadowRoot as ShadowRoot).querySelector(`[data-bd-panel="${which}"] .bd-extra`)?.textContent ?? "").trim(),
        id,
      );

    await expect.poll(() => read("ok"), { timeout: 10_000 }).toContain("Pending");
    expect(await read("ok")).toContain("queue");
    await expect.poll(() => read("missing"), { timeout: 10_000 }).toContain("Could not load");
    expect(failures).toEqual([]);
    await page.close();
  });

  /**
   * The same control inside somebody else's page, where two things could go wrong: the
   * shadow root, and the host's URL. Switching screens must work and must leave the host
   * page's address bar alone — the element does not own it.
   *
   * And where the Actors screen does not exist, the tile must not offer to go there. A
   * control that navigates nowhere is worse than no control.
   */
  it("goes to the Actors screen from the tile, and does not offer to when there is none", async () => {
    const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
    const failures: string[] = [];
    page.on("pageerror", (error) => failures.push(String(error)));
    await page.goto(`${embedUrl}plain`);
    await page.waitForFunction(() => ((document.getElementById("d") as HTMLElement | null)?.shadowRoot?.querySelectorAll("#tiles .tile").length ?? 0) > 0, undefined, { timeout: 15_000 });

    const clicked = await page.evaluate(() => {
      const shadow = (document.getElementById("d") as HTMLElement).shadowRoot as ShadowRoot;
      const tile = Array.from(shadow.querySelectorAll("#tiles .tile")).find((node) => node.querySelector(".k")?.textContent === "Actors tracked");
      (tile as HTMLButtonElement).click();
      return tile?.tagName;
    });
    expect(clicked).toBe("BUTTON");
    await expect
      .poll(() => page.evaluate(() => ((document.getElementById("d") as HTMLElement).shadowRoot as ShadowRoot).getElementById("view-actors")?.hidden === false), { timeout: 10_000 })
      .toBe(true);
    // The host page's own address bar is untouched, embedded.
    expect(await page.evaluate(() => location.hash)).toBe("");
    await page.close();

    // The suite's own host page lists only `stats` and `live` in `tabs`, so it has no
    // Actors screen at all — the ordinary way a developer ends up without one, rather
    // than a case invented for this test.
    const gated = await browser.newPage({ viewport: { width: 1400, height: 950 } });
    await gated.goto(embedUrl);
    await gated.waitForFunction(() => ((document.getElementById("d") as HTMLElement | null)?.shadowRoot?.querySelectorAll("#tiles .tile").length ?? 0) > 0, undefined, { timeout: 15_000 });
    const inert = await gated.evaluate(() => {
      const shadow = (document.getElementById("d") as HTMLElement).shadowRoot as ShadowRoot;
      const tile = Array.from(shadow.querySelectorAll("#tiles .tile")).find((node) => node.querySelector(".k")?.textContent === "Actors tracked");
      return { tag: tile?.tagName, actorsTab: shadow.getElementById("tab-actors")?.hidden !== false };
    });
    expect(inert.tag).toBe("DIV");
    expect(inert.actorsTab).toBe(true);
    expect(failures).toEqual([]);
    await gated.close();
  });

  it("can be registered under a name of your own", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const failures: string[] = [];
    page.on("pageerror", (error) => failures.push(String(error)));
    await page.goto(`${embedUrl}customname`);
    await page.waitForFunction(() => (document.getElementById("b") as HTMLElement | null)?.shadowRoot?.querySelector("#rows") != null, undefined, { timeout: 15_000 });
    // A constructor may be registered once per registry, so a second name needs a fresh
    // subclass — otherwise `define` throws NotSupportedError out of the one function whose
    // job is to register a name.
    expect(failures).toEqual([]);
    await page.close();
  });

  /**
   * The whole point of `controls.editPolicy`, exercised through the element rather than
   * assumed to survive the move. The write path is guarded by a same-origin check that
   * reads `Sec-Fetch-Site`, and embedded the request now originates from the host page —
   * so whether it still passes is a question rather than a given.
   */
  it("can still change the live policy from inside the host page", async () => {
    const page = await browser.newPage({ viewport: { width: 1400, height: 950 }, httpCredentials: { username: "ops", password: "a-long-enough-password-here" } });
    const writes: string[] = [];
    page.on("response", (response) => {
      if (response.request().method() === "POST") writes.push(`${response.status()} ${new URL(response.url()).pathname}`);
    });
    await page.goto(`${editableUrl}`);
    await page.waitForFunction(() => (document.getElementById("d") as HTMLElement | null)?.shadowRoot?.querySelector("#rows") != null, undefined, { timeout: 15_000 });

    const before = editableHandler.policy.rules.length;
    await page.locator("#tab-policy").click();
    await page.waitForTimeout(900);
    await page.locator("#view-policy button", { hasText: /^Remove$/ }).last().click();
    await page.waitForTimeout(300);
    await page.locator("#policy-preview").click();
    await page.waitForTimeout(700);
    await page.locator("#policy-apply").click();
    await page.waitForTimeout(600);
    const confirm = page.locator("#view-policy button.danger");
    if ((await confirm.count()) > 0) {
      await confirm.first().click();
      await page.waitForTimeout(900);
    }

    expect(writes.some((entry) => entry.startsWith("200") && entry.endsWith("/api/policy/apply"))).toBe(true);
    expect(editableHandler.policy.rules.length).toBe(before - 1);
    await page.close();
  });

  it("honours what the server withheld, and its redaction", async () => {
    const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
    await page.goto(`${embedUrl}analyst`);
    await page.waitForFunction(() => ((document.getElementById("d") as HTMLElement | null)?.shadowRoot?.querySelectorAll("tbody tr.row").length ?? 0) > 0, undefined, { timeout: 15_000 });
    const state = await page.evaluate(() => {
      const shadow = (document.getElementById("d") as HTMLElement).shadowRoot as ShadowRoot;
      return {
        tabs: Array.from(shadow.querySelectorAll(".tab:not([hidden])")).map((tab) => tab.textContent?.trim()),
        row: shadow.querySelector("tbody tr.row")?.textContent ?? "",
      };
    });
    // `sections` and `redact` are server-side, and the element is a different renderer
    // rather than a different dashboard — both have to survive the move.
    expect(state.tabs).not.toContain("Policy");
    expect(state.row).toContain("203.0.113.0/24");
    expect(state.row).not.toContain("203.0.113.88");
    await page.close();
  });

  it("says why a cross-origin src cannot work", async () => {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    await page.goto(`${embedUrl}crossorigin`);
    await page.waitForFunction(() => ((document.getElementById("d") as HTMLElement | null)?.shadowRoot?.textContent ?? "").length > 0, undefined, { timeout: 15_000 });
    const shown = await page.evaluate(() => ((document.getElementById("d") as HTMLElement).shadowRoot as ShadowRoot).textContent ?? "");
    // Correct behaviour — the dashboard sends no CORS headers, which is what stops another
    // site reading your traffic through a logged-in browser. "Failed to fetch" does not
    // say that to whoever configured it.
    expect(shown).toContain("same-origin");
    expect(shown).not.toContain("Failed to fetch");
    await page.close();
  });

  /**
   * A boot can fail for reasons that stop being true: the handler had not finished
   * starting, the `src` was wrong and someone corrected it. The element has to be able to
   * try again, and the first version could not — every early exit released ownership but
   * left the internal `booted` latch set, so `connectedCallback` returned immediately ever
   * after and the remount drew the old error over a handler that now works.
   */
  it("boots on a later mount after a failed one, and drops the old error", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(`${embedUrl}crossorigin`);
    await page.waitForFunction(() => (((document.getElementById("d") as HTMLElement | null)?.shadowRoot?.textContent ?? "").length > 0), undefined, { timeout: 15_000 });

    await page.evaluate(() => {
      const node = document.getElementById("d") as HTMLElement;
      node.remove();
      node.setAttribute("src", "/_bots");
      document.body.append(node);
    });
    await page.waitForFunction(() => (document.getElementById("d") as HTMLElement | null)?.shadowRoot?.querySelector("#rows") != null, undefined, { timeout: 15_000 });

    const text = await page.evaluate(() => ((document.getElementById("d") as HTMLElement).shadowRoot as ShadowRoot).textContent ?? "");
    expect(text).not.toContain("could not start");
    await page.close();
  });

  it("draws traffic that arrives after it is watching", async () => {
    const page = await openEmbed();
    // A marker of its own, and asserted as *present* rather than first: these tests share
    // one handler and one feed, so whichever ran last owns the top row. Asserting the
    // position made this fail the moment a later test sent a request of its own, which is
    // a fact about the suite rather than about the dashboard.
    await embedHandler.handle(
      createFacts({ method: "GET", url: "/products", headers: { host: "shop.test", "user-agent": "sqlmap/1.7.2#embedtest", accept: "*/*" }, ip: "203.0.113.44" }),
    );
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            Array.from(((document.getElementById("d") as HTMLElement).shadowRoot as ShadowRoot).querySelectorAll("tbody tr.row")).some((row) =>
              (row.textContent ?? "").includes("sqlmap/1.7.2#embedtest"),
            ),
          ),
        { timeout: 10_000 },
      )
      .toBe(true);
    await page.close();
  });
});

describe("the challenge interstitial", () => {
  let challengeUrl: string;
  let challengeServer: ReturnType<typeof createServer>;
  let gestureUrl: string;
  let gestureServer: ReturnType<typeof createServer>;
  /** What the page last posted to the verification endpoint. */
  interface PostedInteraction {
    via?: string;
    path?: Array<[number, number, number]>;
    layoutHeight?: number;
  }
  let lastPostedInteraction: PostedInteraction | undefined;
  // Read through a function: assigning `undefined` at the top of a test narrows the
  // variable for the rest of it, and the value arrives from a socket the checker cannot
  // see.
  const posted = (): PostedInteraction | undefined => lastPostedInteraction;

  beforeAll(async () => {
    const service = new ChallengeService({ secrets: ["a-secret-long-enough-for-the-service"] });
    challengeServer = createServer((_request, response) => {
      const issued = service.issue("203.0.113.9");
      response.writeHead(issued.status, issued.headers);
      response.end(issued.body);
    });
    await new Promise<void>((resolve) => challengeServer.listen(0, "127.0.0.1", () => resolve()));
    challengeUrl = `http://127.0.0.1:${(challengeServer.address() as { port: number }).port}/`;

    // The same page with the interaction challenge switched on. It adds the only
    // interactive control this library ever shows the public, so it gets its own audit.
    //
    // At difficulty 6 rather than the shipped 16, and the reason is scheduling rather
    // than speed. The page hashes in 60ms slices with `setTimeout(…, 0)` between them, so
    // it does not freeze a slow device — and a browser that treats the page as
    // backgrounded throttles those timers to about one a second. Difficulty 16 was
    // measured here at 487ms of hashing, which is eight or so slices and therefore eight
    // yields; on a CI runner several times slower that is dozens of yields, and throttled
    // it stops fitting in any sane timeout. Difficulty 6 finishes inside the first slice,
    // so there are no yields to throttle.
    //
    // Nothing in these tests is about what the puzzle costs — they are about the control
    // it puts on screen once it is solved. The puzzle at its shipped cost, under its real
    // CSP, is still exercised by the plain challenge page.
    const withGesture = new ChallengeService({ secrets: ["a-secret-long-enough-for-the-service"], interaction: true, difficulty: 6 });
    gestureServer = createServer((request, response) => {
      // The verification endpoint, so a test can read what the page actually posted
      // rather than inferring it from the page's own state.
      if (request.method === "POST") {
        let body = "";
        request.on("data", (chunk) => {
          body += chunk;
        });
        request.on("end", () => {
          try {
            lastPostedInteraction = JSON.parse(body).interaction as PostedInteraction;
          } catch {
            lastPostedInteraction = undefined;
          }
          response.writeHead(200, { "content-type": "application/json" });
          response.end("{}");
        });
        return;
      }
      const issued = withGesture.issue("203.0.113.9");
      response.writeHead(issued.status, issued.headers);
      response.end(issued.body);
    });
    await new Promise<void>((resolve) => gestureServer.listen(0, "127.0.0.1", () => resolve()));
    gestureUrl = `http://127.0.0.1:${(gestureServer.address() as { port: number }).port}/`;
  });

  afterAll(() => {
    challengeServer?.close();
    gestureServer?.close();
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

  /**
   * The interaction challenge, which is the only control this library asks a member of
   * the public to operate. A checkbox was chosen over a slider, a puzzle or a
   * press-and-hold precisely because every way of using a computer can work one — so
   * these tests are the claim, and without them it is only an intention.
   */
  for (const scheme of ["light", "dark"] as const) {
    it(`has nothing for axe to report with the gesture asked for, in ${scheme}`, async () => {
      const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, colorScheme: scheme });
      await page.goto(gestureUrl);
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

  it("can be completed with the keyboard alone", async () => {
    lastPostedInteraction = undefined;
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    await page.goto(gestureUrl);
    await page.waitForSelector("#confirm");

    // The page moves focus to the control once the puzzle is done, so somebody who
    // cannot use a pointer is put on the one thing left to do rather than having to go
    // looking for it. Asserted rather than assumed: the first draft of this test pressed
    // Tab first and moved focus *off* the control, which is what a person would do if
    // the page had not already placed it.
    // Generous, because the proof of work runs at the shipped difficulty and this machine
    // may be building a bundle at the same time. The default poll timeout was not enough
    // under load, and a focus race is not what this test is about.
    await expect.poll(() => page.evaluate(() => document.activeElement?.id), { timeout: 15_000 }).toBe("confirm");

    // No pointer is used anywhere in this test. Space is how a screen reader, switch
    // access and voice control all reach a checkbox, and if it does not work here the
    // page is a wall for them.
    await page.keyboard.press("Space");

    // Watched at the verification endpoint rather than on the page, because what the page
    // shows afterwards does not stay still long enough to assert on. Ticking submits
    // immediately, a successful verify reloads, and the reloaded page solves the puzzle
    // again and returns to *the same words it started with* — "Ready. Tick the box below
    // to continue." So "the box is ticked, or the status has moved on" is true only
    // inside the gap between the tick and the reload, and it fails whenever the round
    // trip wins the race. Making the puzzle cheap for the sake of the focus assertion
    // above shrank that gap and turned an occasional failure into a frequent one.
    //
    // The POST does not evaporate. It is the same signal the activation-device test next
    // door reads, and it says the keypress reached the control rather than that the page
    // happened to still be showing the consequence.
    await expect.poll(() => posted() !== undefined, { timeout: 10_000 }).toBe(true);
    expect(posted()?.via, "a space bar on a checkbox is a keyboard activation").toBe("keyboard");
    await page.close();
  });

  it("keeps the control in the tab order rather than only focusable by script", () => {
    // Asserted as a property rather than by pressing Tab: after a blur, Chromium keeps
    // the sequential-navigation starting point where it was, so a synthetic Tab steps
    // *past* the control and proves nothing. What matters is that the element is a real
    // tabbable control, which is what somebody arriving by keyboard depends on.
    return (async () => {
      const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
      await page.goto(gestureUrl);
      await page.waitForSelector("#confirm");
      const control = await page.evaluate(() => {
        const box = document.getElementById("confirm") as HTMLInputElement | null;
        return { tag: box?.tagName, type: box?.type, tabIndex: box?.tabIndex, disabled: box?.disabled, hidden: box?.hidden };
      });
      expect(control).toEqual({ tag: "INPUT", type: "checkbox", tabIndex: 0, disabled: false, hidden: false });
      await page.close();
    })();
  });

  /**
   * The instruction beside the control, actually attached to it.
   *
   * Without aria-describedby a screen reader announces "I am a person, checkbox" and
   * never reads the sentence sitting next to it — which is the sentence explaining that
   * the space bar works.
   */
  it("attaches the instruction to the control", async () => {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    await page.goto(gestureUrl);
    const described = await page.evaluate(() => {
      const box = document.getElementById("confirm");
      const id = box?.getAttribute("aria-describedby") ?? "";
      return { id, text: document.getElementById(id)?.textContent?.trim() ?? "" };
    });
    expect(described.id).not.toBe("");
    expect(described.text.length).toBeGreaterThan(0);
    // And it must not tell people to press Tab: the page focuses the control itself as
    // soon as the puzzle finishes, so Tab moves focus away from it again.
    expect(described.text).not.toMatch(/\bTab\b/);
    await page.close();
  });

  /**
   * The window of movement kept is the most recent, not the earliest.
   *
   * Capping the buffer by refusing to push once full kept the *first* 128 samples and
   * discarded everything after, so for anybody who moved the mouse while reading the page
   * the analysis measured their idle wandering and never saw the approach to the control —
   * which is the movement it exists to recognise.
   */
  it("keeps the movement leading up to the click, not the movement at page load", async () => {
    lastPostedInteraction = undefined;
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
    await page.goto(gestureUrl);
    await page.waitForSelector("#confirm");

    // Overfill the buffer with wandering in one band, then approach the control in steps
    // an order of magnitude smaller. Which movement survives is then unambiguous.
    for (let index = 0; index < 200; index++) await page.mouse.move(100 + (index % 40) * 6, 60 + (index % 15) * 6);
    const box = await page.locator("#confirm").boundingBox();
    for (let index = 1; index <= 30; index++) {
      await page.mouse.move(300 + ((box as { x: number }).x - 300) * (index / 30), 500 + ((box as { y: number }).y - 500) * (index / 30));
    }
    await page.locator("#confirm").click();
    await expect.poll(() => posted() !== undefined, { timeout: 5000 }).toBe(true);

    const path = posted()?.path ?? [];
    expect(path.length).toBeLessThanOrEqual(128);
    expect(path.length).toBeGreaterThan(20);

    // The approach steps are small; the wandering steps are large. If the window kept the
    // earliest samples, the tail of the path would be wandering.
    const tail = path.slice(-10).map(([dx, dy]: [number, number, number]) => Math.hypot(dx, dy));
    expect(Math.max(...tail)).toBeLessThan(20);
    await page.close();
  });

  it("reports the activation device it actually saw", async () => {
    lastPostedInteraction = undefined;
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
    await page.goto(gestureUrl);
    await page.waitForSelector("#confirm");
    // Wait for the page to finish the puzzle and focus the control; pressing Space before
    // that lands on the document and does nothing.
    await expect.poll(() => page.evaluate(() => document.activeElement?.id), { timeout: 15_000 }).toBe("confirm");
    await page.keyboard.press("Space");
    await expect.poll(() => posted() !== undefined, { timeout: 5000 }).toBe(true);

    expect(posted()?.via).toBe("keyboard");
    expect(posted()?.layoutHeight).toBeGreaterThan(0);
    await page.close();
  });

  /**
   * The nonce-bound probe, answered by a browser that really did lay the block out.
   *
   * The expected value is derived under the signing secret, so this test cannot compute
   * it — which is the property being demonstrated. What it can check is that the page
   * renders a real block and measures it, rather than reporting a number it worked out.
   */
  it("measures the layout probe rather than computing it", async () => {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    await page.goto(gestureUrl);
    await page.waitForSelector("#probe-boxes i");
    const measured = await page.evaluate(() => {
      const boxes = document.getElementById("probe-boxes");
      const items = boxes?.querySelectorAll("i") ?? [];
      const one = items[0]?.getBoundingClientRect().height ?? 0;
      return { count: items.length, one, total: boxes?.getBoundingClientRect().height ?? 0 };
    });
    // Rendered server-side: the elements are in the markup, not built by the script.
    expect(measured.count).toBeGreaterThanOrEqual(4);
    expect(measured.one).toBeGreaterThanOrEqual(3);
    // And the whole is the sum of its parts, which is what the server checks.
    expect(measured.total).toBeCloseTo(measured.count * measured.one, 1);
    await page.close();
  });

  it("gives the control a name a screen reader can announce", async () => {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    await page.goto(gestureUrl);
    const named = await page.evaluate(() => {
      const box = document.getElementById("confirm");
      const label = box === null ? null : document.querySelector('label[for="confirm"]');
      return { hasLabel: label !== null, text: label?.textContent?.trim() ?? "" };
    });
    expect(named.hasLabel).toBe(true);
    expect(named.text.length).toBeGreaterThan(0);
    await page.close();
  });

  /**
   * The capability probes, run against a browser that genuinely has the capabilities.
   * If these report false in real Chromium they would refuse real people, which is the
   * expensive direction for this feature to be wrong in.
   */
  it("reports the browser capabilities truthfully in a real browser", async () => {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    await page.goto(gestureUrl);
    await page.waitForTimeout(300);
    const probes = await page.evaluate(() => {
      const css = document.getElementById("probe-css");
      const hidden = document.getElementById("probe-hidden");
      const a = document.getElementById("probe-a");
      const b = document.getElementById("probe-b");
      const main = document.querySelector("main");
      return {
        cssApplied: css !== null && getComputedStyle(css).letterSpacing === "3px",
        layout: main !== null && main.getBoundingClientRect().width > 0,
        hiddenIsHidden: hidden !== null && hidden.getBoundingClientRect().width === 0,
        fontMetrics:
          a !== null && b !== null && Math.abs(a.getBoundingClientRect().width - b.getBoundingClientRect().width) > 0.5,
        mediaQuery: window.matchMedia("(min-width: 1px)").matches,
      };
    });
    expect(probes).toEqual({ cssApplied: true, layout: true, hiddenIsHidden: true, fontMetrics: true, mediaQuery: true });
    await page.close();
  });

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

/**
 * These run last on purpose.
 *
 * The handler, its feed ring and its actor registry are shared by every test in this
 * file, so anything that sends traffic changes what the tests after it see — a new
 * address becomes an actor, and an actor near the top reorders a table somebody else is
 * reading the first row of. Adding to the end is the cheap way to stay out of that.
 */
describe("the feed's column headers", () => {
  /**
   * They stick under the page header while the rows scroll past.
   *
   * Guarded in a browser because this is a property no unit test can see and one CSS
   * keyword can silently destroy. It already had been: the table collapsed its borders,
   * and WebKit ignores `position: sticky` on a cell in a collapsed table — so in Safari
   * the header scrolled away with the rows while Chromium and Firefox both held it, which
   * is why it was reported as the header "having position absolute".
   */
  it("hold under the page header while the rows scroll", async () => {
    const page = await open();
    // Spread across addresses on purpose. The handler is shared with every other test in
    // this file, and thirty requests from one address makes it the busiest actor — which
    // reorders the Actors table under the tests that read its first row.
    for (let i = 0; i < 30; i++) {
      await handler.handle(createFacts({ method: "GET", url: `/sticky/${i}`, headers: { host: "shop.test", "user-agent": "curl/8.4.0", accept: "*/*" }, ip: `203.0.114.${100 + i}` }));
    }
    await expect.poll(() => page.locator("#rows tr.row").count(), { timeout: 15_000 }).toBeGreaterThan(5);

    const readings = await page.evaluate(`(async () => {
      const table = document.querySelector("#rows").closest("table");
      const th = [...table.querySelectorAll("thead th")].filter((cell) => cell.getBoundingClientRect().height > 0)[0];
      const headerH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--header-h")) || 0;
      const tops = [];
      for (const y of [400, 900]) {
        window.scrollTo(0, y);
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        tops.push({ scrolled: Math.round(window.scrollY), top: Math.round(th.getBoundingClientRect().top) });
      }
      window.scrollTo(0, 0);
      return { headerH: Math.round(headerH), tops, collapse: getComputedStyle(table).borderCollapse };
    })()`) as { headerH: number; tops: Array<{ scrolled: number; top: number }>; collapse: string };

    // The keyword itself, because it is the thing that breaks it.
    expect(readings.collapse).toBe("separate");
    for (const reading of readings.tops) {
      // Only meaningful where the page actually scrolled — a short page cannot show it.
      if (reading.scrolled === 0) continue;
      expect(reading.top, `at scrollY ${reading.scrolled}`).toBeGreaterThanOrEqual(readings.headerH - 2);
    }
    await page.close();
  });
});

describe("the Actors screen", () => {
  /**
   * The registry answers "who is hitting me hardest". Once a filter is on, the question
   * in somebody's head is usually the other one — "who is in *this*" — and until this
   * toggle existed the screen could not answer it.
   */
  it("switches between the registry and the actors in the feed", async () => {
    const page = await open();
    await handler.handle(createFacts({ method: "GET", url: "/scoped", headers: { host: "shop.test", "user-agent": "curl/8.4.0", accept: "*/*" }, ip: "203.0.113.77" }));

    await page.click("#tab-actors");
    await expect.poll(() => page.locator("#view-actors").isVisible()).toBe(true);
    await expect.poll(() => page.locator("#actor-rows tr").count(), { timeout: 15_000 }).toBeGreaterThan(0);
    expect(await page.locator("#actors-scope-tracked").getAttribute("aria-pressed")).toBe("true");

    await page.click("#actors-scope-feed");
    await expect.poll(() => page.locator("#actors-scope-feed").getAttribute("aria-pressed")).toBe("true");
    await expect.poll(() => page.locator("#actors-count").textContent()).toContain("in the feed you are looking at");
    // The columns the feed cannot honestly answer say so rather than showing a zero.
    await expect.poll(() => page.locator("#actor-rows tr").first().textContent(), { timeout: 10_000 }).toContain("—");
    // Server paging belongs to the registry; a list built from rows on screen has none.
    expect(await page.locator("#actors-pager").isVisible()).toBe(false);

    await page.click("#actors-scope-tracked");
    await expect.poll(() => page.locator("#actors-count").textContent()).toContain("tracked");
    await page.close();
  });

  /**
   * The two scopes are two different screens under one tab name. A link that cannot say
   * which one you meant is a link to the wrong one half the time — and the reflex when a
   * live screen looks stuck is to reload, which used to throw the choice away.
   */
  it("keeps the scope in the URL, through a reload and the back button", async () => {
    const page = await open();
    await handler.handle(createFacts({ method: "GET", url: "/urlscope", headers: { host: "shop.test", "user-agent": "curl/8.4.0", accept: "*/*" }, ip: "203.0.113.91" }));

    await page.click("#tab-actors");
    await expect.poll(() => page.locator("#view-actors").isVisible()).toBe(true);
    // The default is absent from the URL rather than spelled out in it.
    expect(new URL(page.url()).hash).not.toContain("a=");

    await page.click("#actors-scope-feed");
    await expect.poll(() => new URL(page.url()).hash).toContain("a=feed");

    await page.reload();
    await expect.poll(() => page.locator("#actors-scope-feed").getAttribute("aria-pressed"), { timeout: 15_000 }).toBe("true");
    await expect.poll(() => page.locator("#actors-count").textContent()).toContain("in the feed you are looking at");

    // Back walks to the entry before the toggle, which is the tracked registry.
    await page.goBack();
    await expect.poll(() => page.locator("#actors-scope-tracked").getAttribute("aria-pressed"), { timeout: 15_000 }).toBe("true");
    await page.close();
  });

  /**
   * Labelling used to call `prompt()`, which a sandboxed iframe blocks outright — so on
   * an embedded dashboard the button did nothing at all, silently. It edits in place now.
   */
  it("names an actor from an input in the row", async () => {
    const page = await open();
    await handler.handle(createFacts({ method: "GET", url: "/named", headers: { host: "shop.test", "user-agent": "curl/8.4.0", accept: "*/*" }, ip: "203.0.113.78" }));
    await page.click("#tab-actors");
    await expect.poll(() => page.locator("#actor-rows tr").count(), { timeout: 15_000 }).toBeGreaterThan(0);

    await page.click('#actor-rows tr:first-child button:has-text("Label")');
    const input = page.locator("#actor-rows .label-input").first();
    await expect.poll(() => input.count()).toBe(1);
    await input.fill("the noisy one");
    await input.press("Enter");

    await expect.poll(() => page.locator("#actor-rows").textContent(), { timeout: 15_000 }).toContain("the noisy one");
    await page.close();
  });

  /**
   * Save and Cancel, where a `prompt()` used to put them.
   *
   * Three earlier attempts put the two buttons beside the row's existing four, and the
   * cell does not wrap: the row grew wider than the panel and Save came to rest past its
   * right edge, underneath the page — visible, and impossible to click. So the assertion
   * is not that the buttons exist. It is that they are inside the panel, and that
   * pressing Save saves.
   */
  it("saves a name from a button that is inside the panel", async () => {
    const page = await open();
    await handler.handle(createFacts({ method: "GET", url: "/buttoned", headers: { host: "shop.test", "user-agent": "curl/8.4.0", accept: "*/*" }, ip: "203.0.113.92" }));
    await page.click("#tab-actors");
    await expect.poll(() => page.locator("#actor-rows tr").count(), { timeout: 15_000 }).toBeGreaterThan(0);

    await page.click('#actor-rows tr:first-child button:has-text("Label")');
    const input = page.locator("#actor-rows .label-input").first();
    await expect.poll(() => input.count()).toBe(1);

    // The row's other actions stand aside while the editor is open, which is where the
    // room comes from.
    expect(await page.locator('#actor-rows tr:first-child button:has-text("Allowlist")').isVisible()).toBe(false);

    const save = page.locator("#actor-rows .label-save").first();
    expect(await save.isVisible()).toBe(true);
    const button = (await save.boundingBox()) ?? { x: 0, width: 1e9 };
    const panel = (await page.locator("#view-actors .panel").first().boundingBox()) ?? { x: 0, width: 0 };
    expect(button.x + button.width, "Save is inside the panel, not hanging off the end of it").toBeLessThanOrEqual(panel.x + panel.width + 1);

    await input.fill("named by button");
    await save.click();
    await expect.poll(() => page.locator("#actor-rows").textContent(), { timeout: 15_000 }).toContain("named by button");
    await page.close();
  });

  /**
   * The same two buttons from the keyboard. An earlier version bound them to
   * `pointerdown`, which never fires for a keyboard activation — so Save worked with a
   * mouse and silently did nothing with Tab and Enter. Tabbing out of the input also
   * has to not read as clicking away, which would cancel before the button was reached.
   */
  it("saves a name reached with the Tab key", async () => {
    const page = await open();
    await handler.handle(createFacts({ method: "GET", url: "/tabbed", headers: { host: "shop.test", "user-agent": "curl/8.4.0", accept: "*/*" }, ip: "203.0.113.93" }));
    await page.click("#tab-actors");
    await expect.poll(() => page.locator("#actor-rows tr").count(), { timeout: 15_000 }).toBeGreaterThan(0);

    await page.click('#actor-rows tr:first-child button:has-text("Label")');
    const input = page.locator("#actor-rows .label-input").first();
    await expect.poll(() => input.count()).toBe(1);
    await input.fill("named by keyboard");

    await input.press("Tab");
    await page.keyboard.press("Enter");
    await expect.poll(() => page.locator("#actor-rows").textContent(), { timeout: 15_000 }).toContain("named by keyboard");
    await page.close();
  });

  it("abandons a name from the Cancel button", async () => {
    const page = await open();
    await handler.handle(createFacts({ method: "GET", url: "/cancelled", headers: { host: "shop.test", "user-agent": "curl/8.4.0", accept: "*/*" }, ip: "203.0.113.94" }));
    await page.click("#tab-actors");
    await expect.poll(() => page.locator("#actor-rows tr").count(), { timeout: 15_000 }).toBeGreaterThan(0);

    await page.click('#actor-rows tr:first-child button:has-text("Label")');
    const input = page.locator("#actor-rows .label-input").first();
    await expect.poll(() => input.count()).toBe(1);
    await input.fill("thought better of it");
    await page.locator('#actor-rows .label-edit button:has-text("Cancel")').first().click();

    await expect.poll(() => page.locator("#actor-rows .label-input").count()).toBe(0);
    expect(await page.locator("#actor-rows").textContent()).not.toContain("thought better of it");
    // And the row has its own actions back.
    await expect.poll(() => page.locator('#actor-rows tr:first-child button:has-text("Allowlist")').isVisible()).toBe(true);
    await page.close();
  });

  /**
   * The Actors table repaints on the counters frame — every two seconds — and a repaint
   * rebuilds every row. With the editor open that does not merely reset a control: it
   * removes the input and takes whatever had been typed into it, on a timer, while
   * somebody is still typing. The table already held still for a half-pressed
   * confirmation; the editor had simply never been counted as an interaction.
   */
  it("does not repaint the editor away while a name is being typed", async () => {
    await handler.handle(createFacts({ method: "GET", url: "/typing", headers: { host: "shop.test", "user-agent": "curl/8.4.0", accept: "*/*" }, ip: "203.0.113.82" }));
    const page = await open();
    await page.click("#tab-actors");
    await expect.poll(() => page.locator("#actor-rows tr").count(), { timeout: 15_000 }).toBeGreaterThan(0);

    await page.click('#actor-rows tr:first-child button:has-text("Label")');
    const input = page.locator("#actor-rows .label-input").first();
    await expect.poll(() => input.count()).toBe(1);
    await input.fill("half typed and still thinking");

    // Comfortably past two repaint frames.
    await page.waitForTimeout(5_000);
    expect(await input.count(), "the editor survived the repaint").toBe(1);
    expect(await input.inputValue()).toBe("half typed and still thinking");

    await input.press("Escape");
    await expect.poll(() => page.locator("#actor-rows .label-input").count()).toBe(0);
    await page.close();
  });

  /**
   * The same editor, in the other place it appears.
   *
   * The Actors table was taught to hold still while somebody is typing into it. The
   * drill-down above the feed offers the identical three controls and was not: it is
   * rebuilt from scratch by every redraw, and a redraw happens on every request that
   * arrives. On a live feed that is a name box which vanishes about a second after it
   * opens, taking whatever had been typed with it.
   */
  it("does not repaint the drill-down editor away while a name is being typed", async () => {
    const page = await open();
    await handler.handle(createFacts({ method: "GET", url: "/drilled", headers: { host: "shop.test", "user-agent": "curl/8.4.0", accept: "*/*" }, ip: "203.0.113.96" }));
    await page.locator("tbody tr.row").first().click();
    await page.waitForSelector("tr.detail");
    await page.locator('tr.detail .tools button', { hasText: "Show this actor" }).click();
    await expect.poll(() => page.locator("#actor-panel").isVisible(), { timeout: 15_000 }).toBe(true);
    // Whichever actor the row that was open belongs to. Not assumed: the feed holds
    // traffic from every test before this one, so the top row is not reliably the request
    // made above — and hard-coding a key made this pass on one engine and not the other.
    const key = (await page.locator("#actor-key").innerText()).trim();

    await page.locator('#actor-actions button:has-text("Label")').click();
    const input = page.locator("#actor-actions .label-input");
    await expect.poll(() => input.count()).toBe(1);
    await input.fill("named from the drill-down");

    // Traffic keeps arriving while somebody is typing, which is the whole point.
    for (let i = 0; i < 4; i++) {
      await handler.handle(createFacts({ method: "GET", url: `/noise/${i}`, headers: { host: "shop.test", "user-agent": "curl/8.4.0", accept: "*/*" }, ip: "203.0.113.97" }));
      await page.waitForTimeout(400);
    }

    expect(await input.count(), "the editor survived the redraws").toBe(1);
    expect(await input.inputValue()).toBe("named from the drill-down");

    await page.locator("#actor-actions .label-save").click();
    await expect.poll(() => page.locator("#actor-actions .label-input").count(), { timeout: 15_000 }).toBe(0);
    // Checked against the handler rather than against the Actors table: the registry is
    // paged, and by the time the whole suite has run this actor is not on the first page.
    await expect.poll(() => handler.registry.peek(key)?.label, { timeout: 15_000 }).toBe("named from the drill-down");
    await page.close();
  });

  /**
   * The same fault, in the two other panels that rebuild themselves and contain inputs.
   *
   * `drawRanges` and `drawGuard` clear their panel and build it again, which is fine for
   * a list of numbers and destructive for a text box. Both are reached from `draw()`, and
   * `draw()` runs on every request that arrives — so on a dashboard watching live traffic
   * an address being typed into the allowlist disappeared about a second in, along with a
   * guard threshold being edited beside it.
   */
  it("does not repaint an address out of the allowlist box while it is being typed", async () => {
    const page = await open();
    await page.click("#tab-policy");
    await expect.poll(() => page.locator("#view-policy").isVisible(), { timeout: 15_000 }).toBe(true);
    const address = page.locator('#ranges-body input[aria-label="Address or CIDR to add"]');
    await expect.poll(() => address.count(), { timeout: 15_000 }).toBeGreaterThan(0);

    await address.first().click();
    await address.first().fill("203.0.113.0/24");

    for (let i = 0; i < 4; i++) {
      await handler.handle(createFacts({ method: "GET", url: `/policy-noise/${i}`, headers: { host: "shop.test", "user-agent": "curl/8.4.0", accept: "*/*" }, ip: "203.0.113.98" }));
      await page.waitForTimeout(400);
    }

    expect(await address.first().inputValue(), "still there, and still what was typed").toBe("203.0.113.0/24");

    // And once focus leaves, the panel is free to redraw again rather than staying frozen.
    await page.locator("#tab-policy").click();
    await handler.handle(createFacts({ method: "GET", url: "/policy-noise/after", headers: { host: "shop.test", "user-agent": "curl/8.4.0", accept: "*/*" }, ip: "203.0.113.99" }));
    await expect.poll(() => address.first().inputValue(), { timeout: 15_000 }).toBe("");
    await page.close();
  });

  /**
   * A name reaches the requests already on screen.
   *
   * Given here from code, standing in for another operator on another dashboard: nothing
   * on this page asked for it, so the only way it can arrive is the stats frame every
   * open dashboard receives. The rows it changes were drawn before the name existed —
   * that is the "retroactive" part — and a row belonging to anybody else must be left
   * exactly as it was.
   */
  it("shows a name given elsewhere on the rows already in the feed", async () => {
    const page = await open();
    const named = "203.0.114.201";
    const other = "203.0.114.202";
    for (const ip of [named, other]) {
      await handler.handle(createFacts({ method: "GET", url: `/retro/${ip}`, headers: { host: "shop.test", "user-agent": "curl/8.4.0", accept: "*/*" }, ip }));
    }
    const rowOf = (ip: string) => page.locator("#rows tr.row", { hasText: `/retro/${ip}` });
    await expect.poll(() => rowOf(named).count(), { timeout: 15_000 }).toBeGreaterThan(0);
    const otherBefore = await rowOf(other).first().evaluate((node) => node.outerHTML);

    handler.labelActor(named, "retro office");

    await expect.poll(() => rowOf(named).first().locator(".ua a").textContent(), { timeout: 15_000 }).toBe("retro office");
    // The address is still there to be found: on hover, and in the row detail.
    expect(await rowOf(named).first().locator(".ua a").getAttribute("title")).toContain(named);
    // Nobody else's row was rebuilt, which is what keeps a selection alive on a busy feed.
    expect(await rowOf(other).first().evaluate((node) => node.outerHTML)).toBe(otherBefore);

    await rowOf(named).first().click();
    await expect.poll(() => page.locator("tr.detail .label-note").textContent(), { timeout: 10_000 }).toContain("retro office");
    expect(await page.locator("tr.detail .label-note").textContent()).toContain(named);

    // And the drill-down puts the name beside the key.
    await page.locator("tr.detail .tools button", { hasText: "Show this actor" }).click();
    await expect.poll(() => page.locator("#actor-label").textContent(), { timeout: 10_000 }).toBe("retro office");
    expect(await page.locator("#actor-key").textContent()).toBe(named);

    // And the filter answers to the name.
    await page.locator("#actor-close").click();
    await page.locator("#search").fill('actor:$in("retro office")');
    await expect.poll(async () => (await page.locator("#rows").textContent()) ?? "", { timeout: 10_000 }).toContain(`/retro/${named}`);
    expect(await page.locator("#rows").textContent()).not.toContain(`/retro/${other}`);
    await page.close();
  });

  /**
   * The person who gives a name sees it at once, rather than on the next stats frame.
   *
   * The toast says "shown as X wherever it appears", and for the two seconds until the
   * frame arrived that was untrue on the page that said it.
   */
  it("shows a name in the feed the moment it is saved", async () => {
    const page = await open();
    const ip = "203.0.114.203";
    await handler.handle(createFacts({ method: "GET", url: "/instant-name", headers: { host: "shop.test", "user-agent": "curl/8.4.0", accept: "*/*" }, ip }));
    const row = page.locator("#rows tr.row", { hasText: "/instant-name" }).first();
    await expect.poll(() => row.count(), { timeout: 15_000 }).toBe(1);
    await row.click();
    await page.locator("tr.detail .tools button", { hasText: "Show this actor" }).click();
    await page.locator('#actor-actions button:has-text("Label")').click();
    await page.locator("#actor-actions .label-input").fill("named just now");
    const saved = Date.now();
    await page.locator("#actor-actions .label-save").click();
    await expect.poll(() => row.locator(".ua a").textContent(), { timeout: 1_500 }).toBe("named just now");
    expect(Date.now() - saved, "well inside one stats frame").toBeLessThan(1_500);
    await page.close();
  });

  /**
   * Hiding an actor from the feed, from the label editor.
   *
   * The rows go, and the feed says how many it is hiding and can show them again — hidden
   * traffic is still being judged and acted on, and a feed that hides part of what is
   * happening must never look like a quieter one. Nobody else's rows are touched.
   */
  it("hides an actor's requests from the feed by label, and says how many", async () => {
    const hiddenIp = "203.0.114.210";
    const shownIp = "203.0.114.211";
    try {
      const page = await open();
      for (let i = 0; i < 3; i++) await handler.handle(createFacts({ method: "GET", url: `/hideme/${i}`, headers: { host: "shop.test", "user-agent": "curl/8.4.0", accept: "*/*" }, ip: hiddenIp }));
      await handler.handle(createFacts({ method: "GET", url: "/keepme", headers: { host: "shop.test", "user-agent": "curl/8.4.0", accept: "*/*" }, ip: shownIp }));
      const feed = async (): Promise<string> => (await page.locator("#rows").textContent()) ?? "";
      await expect.poll(feed, { timeout: 15_000 }).toContain("/hideme/0");

      await page.locator("#rows tr.row", { hasText: "/hideme/0" }).first().click();
      await page.locator("tr.detail .tools button", { hasText: "Show this actor" }).click();
      await page.locator('#actor-actions button:has-text("Label")').click();
      await page.locator("#actor-actions .label-input").fill("noisy monitor");
      await page.locator("#actor-actions .label-option", { hasText: "Hide from feed" }).locator("input").check();
      await page.locator("#actor-actions .label-save").click();

      await expect.poll(feed, { timeout: 5_000 }).not.toContain("/hideme/");
      expect(await feed(), "somebody else's requests stay").toContain("/keepme");
      await expect.poll(() => page.locator("#feed-hidden").textContent()).toBe("3 hidden by label");

      // And back, without touching the label.
      await page.locator("#feed-show-hidden").click();
      await expect.poll(feed).toContain("/hideme/0");
      expect(handler.actorLabelEntries().get(hiddenIp)).toEqual({ name: "noisy monitor", hideFromFeed: true });
      await page.close();
    } finally {
      handler.labelActor(hiddenIp, undefined);
    }
  });

  /**
   * Switching analysis off, from the label editor.
   *
   * The consequence is said in words the moment the box is ticked, as the allowlist button
   * does before it acts. After that the actor is treated exactly like an allowlisted
   * address: its next request is not judged, does not enter the feed, and is counted on
   * the Statistics screen instead — which is where skipped traffic has always shown up.
   */
  it("stops analysing an actor by label, and says so on its requests", async () => {
    const ip = "203.0.114.212";
    try {
      const page = await open();
      await handler.handle(createFacts({ method: "GET", url: "/skipme/0", headers: { host: "shop.test", "user-agent": "curl/8.4.0", accept: "*/*" }, ip }));
      await expect.poll(async () => (await page.locator("#rows").textContent()) ?? "", { timeout: 15_000 }).toContain("/skipme/0");

      await page.locator("#rows tr.row", { hasText: "/skipme/0" }).first().click();
      await page.locator("tr.detail .tools button", { hasText: "Show this actor" }).click();
      await page.locator('#actor-actions button:has-text("Label")').click();
      await page.locator("#actor-actions .label-input").fill("uptime check");
      expect(await page.locator("#actor-actions .label-warn").isVisible(), "no warning before it is ticked").toBe(false);
      await page.locator("#actor-actions .label-option", { hasText: "Don't analyse" }).locator("input").check();
      expect(await page.locator("#actor-actions .label-warn").textContent()).toContain("same as allowlisting");
      await page.locator("#actor-actions .label-save").click();
      await expect.poll(() => handler.actorLabelEntries().get(ip)?.skipAnalysis, { timeout: 5_000 }).toBe(true);

      const before = handler.metrics()?.bypassed.label ?? 0;
      const next = await handler.handle(createFacts({ method: "GET", url: "/skipme/1", headers: { host: "shop.test", "user-agent": "curl/8.4.0", accept: "*/*" }, ip }));
      expect(next.assessment.bypass).toBe("label");
      expect(next.assessment.evidence, "not judged").toEqual([]);
      expect(handler.metrics()?.bypassed.label).toBe(before + 1);

      // Not in the feed, like allowlisted traffic — and counted where skipped traffic is.
      await page.waitForTimeout(800);
      expect(await page.locator("#rows").textContent()).not.toContain("/skipme/1");
      await page.click("#tab-stats");
      await expect.poll(() => page.locator("#stat-health").textContent(), { timeout: 15_000 }).toContain("Bypassed — labelled not to analyse");
      await page.close();
    } finally {
      handler.labelActor(ip, undefined);
    }
  });

  /**
   * The editor grew a second line, and it lives in a table cell that does not wrap — the
   * place Save ended up off the edge of the panel three times before. Every control in it
   * has to be inside the panel, not merely present.
   */
  it("keeps the label editor's switches inside the panel", async () => {
    const page = await open();
    await handler.handle(createFacts({ method: "GET", url: "/editor-fit", headers: { host: "shop.test", "user-agent": "curl/8.4.0", accept: "*/*" }, ip: "203.0.114.213" }));
    await page.click("#tab-actors");
    await expect.poll(() => page.locator("#actor-rows tr").count(), { timeout: 15_000 }).toBeGreaterThan(0);
    await page.click('#actor-rows tr:first-child button:has-text("Label")');
    await expect.poll(() => page.locator("#actor-rows .label-input").count()).toBe(1);
    await page.locator("#actor-rows .label-option", { hasText: "Don't analyse" }).locator("input").check();

    const panel = (await page.locator("#view-actors .panel").first().boundingBox()) ?? { x: 0, width: 0 };
    for (const selector of [".label-save", '.label-option:has-text("Hide from feed")', '.label-option:has-text("Don\'t analyse")', ".label-warn"]) {
      const box = (await page.locator(`#actor-rows ${selector}`).first().boundingBox()) ?? { x: 0, width: 1e9 };
      expect(box.x + box.width, `${selector} is inside the panel`).toBeLessThanOrEqual(panel.x + panel.width + 1);
    }
    await page.locator('#actor-rows .label-edit button:has-text("Cancel")').first().click();
    await page.close();
  });

  it("abandons a label on Escape", async () => {
    await handler.handle(createFacts({ method: "GET", url: "/escape", headers: { host: "shop.test", "user-agent": "curl/8.4.0", accept: "*/*" }, ip: "203.0.113.81" }));
    const page = await open();
    await page.click("#tab-actors");
    await expect.poll(() => page.locator("#actor-rows tr").count(), { timeout: 15_000 }).toBeGreaterThan(0);
    const before = await page.locator("#actor-rows").textContent();

    await page.click('#actor-rows tr:first-child button:has-text("Label")');
    const input = page.locator("#actor-rows .label-input").first();
    await expect.poll(() => input.count()).toBe(1);
    await input.fill("never saved");
    await input.press("Escape");

    await expect.poll(() => page.locator("#actor-rows .label-input").count()).toBe(0);
    expect(await page.locator("#actor-rows").textContent()).not.toContain("never saved");
    expect(before).not.toContain("never saved");
    await page.close();
  });
});
