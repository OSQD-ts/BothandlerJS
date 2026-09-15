import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cleanAppearance, isHexColour } from "../src/challenge/appearance.js";
import { ChallengePageStore } from "../src/dashboard/challenge-page-store.js";

/**
 * The challenge page as edited from the dashboard.
 *
 * Everything checked here comes from a form and lands on the one page a member of the
 * public sees, so the cases worth pinning are the ones that would put something on that
 * page nobody meant to: a colour that is really CSS, a language tag that is really markup,
 * and a file that changed under a running process.
 */
describe("cleaning a challenge page submission", () => {
  it("keeps what was written and drops what was cleared", () => {
    const { appearance, errors } = cleanAppearance({ title: "  One moment  ", message: "", accent: "#2F6FEB", lang: "de" });
    expect(errors).toEqual([]);
    // Empty means "use the default", so it is not kept as an empty heading.
    expect(appearance).toEqual({ title: "One moment", accent: "#2f6feb", lang: "de" });
  });

  it("refuses a colour that would write CSS", () => {
    for (const value of ["red", "#12345", "#fff; background:url(x)", "#ffffff}body{display:none"]) {
      expect(isHexColour(value), value).toBe(false);
      expect(cleanAppearance({ accent: value }).errors.length, value).toBe(1);
    }
  });

  it("refuses a language tag that is not one", () => {
    expect(cleanAppearance({ lang: 'en" onload="x' }).errors.join(" ")).toContain("not a language tag");
    expect(cleanAppearance({ translations: { "<b>": { title: "x" } } }).errors.length).toBe(1);
  });

  it("says how long is too long", () => {
    expect(cleanAppearance({ title: "x".repeat(121) }).errors.join(" ")).toContain("the most is 120");
  });

  it("keeps translations with something in them", () => {
    const { appearance, errors } = cleanAppearance({ translations: { ja: { title: "確認しています" }, fr: { title: "  " } } });
    expect(errors).toEqual([]);
    expect(appearance.translations).toEqual({ ja: { title: "確認しています" } });
  });

  it("refuses something that is not settings at all", () => {
    expect(cleanAppearance("title").errors.length).toBe(1);
    expect(cleanAppearance([]).errors.length).toBe(1);
  });
});

describe("the saved challenge page", () => {
  const directory = (): string => mkdtempSync(join(tmpdir(), "bh-challenge-page-"));

  it("survives the process restarting", () => {
    const file = join(directory(), "nested", "page.json");
    const first = new ChallengePageStore(file, () => {});
    expect(first.saved()).toBeUndefined();
    expect(first.save({ title: "Nearly there", accent: "#aa3300" })).toEqual({ persisted: true });

    const second = new ChallengePageStore(file, () => {});
    expect(second.saved()).toEqual({ title: "Nearly there", accent: "#aa3300" });
    expect(JSON.parse(readFileSync(file, "utf8")).format).toBe("bothandlerjs/challenge-page");
  });

  it("stays in memory, and says so, without a file", () => {
    const store = new ChallengePageStore(undefined, () => {});
    expect(store.save({ title: "x" })).toEqual({ persisted: false });
    expect(store.saved()).toEqual({ title: "x" });
  });

  it("does not use a file somebody edited into something unsafe", () => {
    const file = join(directory(), "page.json");
    writeFileSync(file, JSON.stringify({ format: "bothandlerjs/challenge-page", version: 1, appearance: { accent: "red;}body{" } }));
    const warnings: string[] = [];
    const store = new ChallengePageStore(file, (message) => warnings.push(message));
    expect(store.saved()).toBeUndefined();
    expect(warnings.join(" ")).toContain("was not used");
  });

  it("says so when the file is not JSON, and starts from code", () => {
    const file = join(directory(), "page.json");
    writeFileSync(file, "{ not json");
    const warnings: string[] = [];
    expect(new ChallengePageStore(file, (message) => warnings.push(message)).saved()).toBeUndefined();
    expect(warnings.join(" ")).toContain("not valid JSON");
  });
});

describe("changing the page on a running handler", () => {
  const secrets = ["a-challenge-appearance-secret-that-is-long-enough"];

  it("serves the saved page over the code's, and the code's again after a reset", async () => {
    const { BotHandler } = await import("../src/index.js");
    const handler = new BotHandler({ onWarning: () => {}, challenge: { secrets, title: "From code", accent: "#112233" } });
    const service = handler.challenge;
    if (service === undefined) throw new Error("challenge not configured");
    expect(service.issue("203.0.113.9").body).toContain("From code");

    const events: unknown[] = [];
    handler.on("challenge-change", (event) => events.push(event));
    handler.updateChallengePage({ title: "Saved on the dashboard", accentDark: "#abcdef" }, { by: "ops" });
    const saved = service.issue("203.0.113.9").body;
    expect(saved).toContain("Saved on the dashboard");
    // The code's colour survives a save that did not touch it.
    expect(saved).toContain("--accent: #112233");
    expect(saved).toContain("--accent: #abcdef");
    expect(events).toHaveLength(1);

    handler.updateChallengePage(undefined);
    expect(service.issue("203.0.113.9").body).toContain("From code");
    expect(service.savedAppearance).toBeUndefined();
  });

  it("refuses a page it cannot serve safely, and leaves the running one alone", async () => {
    const { BotHandler } = await import("../src/index.js");
    const handler = new BotHandler({ onWarning: () => {}, challenge: { secrets, title: "Kept" } });
    expect(() => handler.updateChallengePage({ title: "Changed", accent: "red;}" })).toThrow(/not a colour/);
    expect(handler.challenge?.issue("203.0.113.9").body).toContain("Kept");
  });

  it("says there is no page to change when no challenge is configured", async () => {
    const { BotHandler } = await import("../src/index.js");
    expect(() => new BotHandler({ onWarning: () => {} }).updateChallengePage({ title: "x" })).toThrow(/No challenge is configured/);
  });

  it("renders a draft, a scheme and another verify path for a preview without changing the page", async () => {
    const { BotHandler } = await import("../src/index.js");
    const handler = new BotHandler({ onWarning: () => {}, challenge: { secrets, title: "Live" } });
    const preview = handler.challenge?.issue("preview", { appearance: { title: "Draft" }, scheme: "dark", verifyPath: "/_bots/api/challenge/verify?id=x" });
    expect(preview?.body).toContain("Draft");
    expect(preview?.body).toContain("color-scheme: dark");
    expect(preview?.body).toContain("/_bots/api/challenge/verify?id=x");
    expect(handler.challenge?.issue("visitor").body).toContain("Live");
  });
});
