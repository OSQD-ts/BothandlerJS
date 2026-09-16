import { describe, expect, it } from "vitest";
import { generateRobotsTxt, robotsFromRules } from "../src/index.js";
import { PRESETS, protectData } from "../src/policy/presets.js";

describe("robots.txt", () => {
  it("repeats global disallows inside each named group", () => {
    // RFC 9309: a crawler obeys the most specific group that names it and ignores
    // every other, so a trap path only in the wildcard group is *permitted* for a
    // crawler that has its own group.
    const text = generateRobotsTxt({ disallowBots: ["gptbot"], disallowPaths: ["/trap"] });
    const group = text.slice(text.indexOf("User-agent: GPTBot"));
    expect(group).toContain("Disallow: /trap");
    expect(group).toContain("Disallow: /");
  });

  it("expands categories and reports rules it could not read", () => {
    const result = robotsFromRules(protectData());
    expect(result.declined).toContain("gptbot");
    expect(result.declined).toContain("ahrefsbot");
    expect(result.declined.length).toBeGreaterThan(10);
    // Behavioural rules name no crawler, so they cannot be expressed in robots.txt —
    // and are reported rather than silently dropped.
    expect(result.unreadable.map((entry) => entry.rule)).toContain("scanner-block");
  });

  it("emits a wildcard group even with nothing to disallow", () => {
    expect(generateRobotsTxt()).toContain("User-agent: *\nDisallow:\n");
  });

  it("accepts several sitemaps", () => {
    const text = generateRobotsTxt({ sitemap: ["https://a.example/s.xml", "https://b.example/s.xml"] });
    expect(text).toContain("Sitemap: https://a.example/s.xml");
    expect(text).toContain("Sitemap: https://b.example/s.xml");
  });
});

describe("robots.txt derived from a policy", () => {
  // A named group gets `Disallow: /`. A rule that only denies one path therefore
  // becomes a site-wide decline, and a crawler that stops fetching everything is the
  // expensive direction to be wrong in.
  it("reports a rule it declines more broadly than the policy does", () => {
    const { unreadable, declined } = robotsFromRules([
      { id: "premium-only", match: { identity: "gptbot", path: "/premium" }, action: "block" },
    ]);
    expect(declined).toContain("gptbot");
    expect(unreadable).toHaveLength(1);
    expect(unreadable[0]!.rule).toBe("premium-only");
    expect(unreadable[0]!.reason).toContain("/premium");
  });

  it("says nothing about a rule that really is site-wide", () => {
    const { unreadable, declined } = robotsFromRules([{ id: "no-ai", match: { category: "ai" }, action: "block" }]);
    expect(unreadable).toEqual([]);
    expect(declined.length).toBeGreaterThan(0);
  });
});

describe("robots.txt follows the rule order", () => {
  // The file and the policy have to say the same thing. A crawler an earlier rule
  // serves must not be told to stay away by a later category-wide block.
  it("does not decline a crawler an earlier rule serves", () => {
    const { robotsTxt, declined, served } = robotsFromRules([
      { id: "serve-the-citation", match: { identity: "chatgpt-user" }, action: "tag" },
      { id: "decline-the-trainers", match: { category: "ai", certain: true }, action: "block" },
    ]);

    expect(declined).toContain("gptbot");
    expect(declined).not.toContain("chatgpt-user");
    expect(served).toContain("chatgpt-user");
    expect(robotsTxt).not.toContain("ChatGPT-User");
    expect(robotsTxt).toContain("GPTBot");
  });

  it("still declines the whole category when nothing is served ahead of it", () => {
    const { declined } = robotsFromRules([{ id: "decline-ai", match: { category: "ai", certain: true }, action: "block" }]);
    expect(declined).toContain("chatgpt-user");
    expect(declined).toContain("gptbot");
  });

  // A path-scoped allow does not serve a crawler across the site, and a named group in
  // robots.txt can only speak about the whole site.
  it("does not treat a path-scoped rule as serving a crawler everywhere", () => {
    const { declined } = robotsFromRules([
      { id: "allow-on-the-blog", match: { identity: "gptbot", path: "/blog/" }, action: "allow" },
      { id: "decline-ai", match: { category: "ai", certain: true }, action: "block" },
    ]);
    expect(declined).toContain("gptbot");
  });

  it("generates a file for every shipped preset without complaint", () => {
    for (const [name, preset] of Object.entries(PRESETS)) {
      const result = robotsFromRules(preset());
      expect(result.robotsTxt, name).toContain("User-agent: *");
    }
  });
});
