import { describe, expect, it } from "vitest";
import { matchesActor, parseActorFilter } from "../src/dashboard/actor-filter.js";
import type { FilterableActor } from "../src/dashboard/actor-filter.js";

/**
 * The feed's query language, read over actors.
 *
 * The operators, quoting, negation and precedence are the language and are tested against
 * the feed in `dashboard-client.test.ts`; what matters here is that they reach this screen
 * at all, and that the vocabulary is the one an actor has. A second dialect one tab away
 * would be worse than no filter.
 */
const actor = (overrides: Partial<FilterableActor> = {}): FilterableActor => ({
  key: "203.0.113.4",
  requests: 120,
  recentRate: 12,
  distinctPaths: 9,
  distinctUserAgents: 1,
  priorConfirmations: 0,
  unsolvedChallenges: 0,
  cadenceCv: 0.42,
  cleared: false,
  ...overrides,
});

const keep = (query: string, subject: FilterableActor): boolean => matchesActor(parseActorFilter(query), subject);

describe("filtering actors", () => {
  it("matches a bare word against what somebody would recognise", () => {
    expect(keep("203.0.113", actor())).toBe(true);
    expect(keep("office", actor({ label: "office egress" }))).toBe(true);
    // Not against the numbers: a stray digit would otherwise match half the table.
    expect(keep("120", actor())).toBe(false);
  });

  it("names the fields an actor has", () => {
    expect(keep("actor:203.0.113.4", actor())).toBe(true);
    expect(keep("label:office", actor({ label: "office egress" }))).toBe(true);
    expect(keep("label:office", actor())).toBe(false);
    expect(keep("cleared:yes", actor({ cleared: true }))).toBe(true);
    expect(keep("cleared:no", actor())).toBe(true);
  });

  it("compares the numbers as numbers", () => {
    expect(keep("requests:>100", actor())).toBe(true);
    expect(keep("requests:>200", actor())).toBe(false);
    expect(keep("requests:<200", actor())).toBe(true);
    expect(keep("paths:9", actor())).toBe(true);
    expect(keep("rate:>10", actor())).toBe(true);
    expect(keep("cadence:<0.5", actor())).toBe(true);
    // Too few gaps to say is not a zero, and must not answer a comparison as though it were.
    expect(keep("cadence:<0.5", actor({ cadenceCv: undefined }))).toBe(false);
    expect(keep("cadence:>0.5", actor({ cadenceCv: undefined }))).toBe(false);
  });

  /** An address is an identifier here too: excluding one must not exclude its neighbours. */
  it("matches a key a component at a time", () => {
    expect(keep("actor:1.2.3.4", actor({ key: "1.2.3.45" }))).toBe(false);
    expect(keep("actor:1.2.3", actor({ key: "1.2.3.45" })), "a network prefix still finds it").toBe(true);
  });

  it("takes the operators, the quotes and the negation the feed takes", () => {
    const office = actor({ label: "office egress" });
    expect(keep("label:$in(office, partner)", office)).toBe(true);
    expect(keep("label:$notin(office, partner)", office)).toBe(false);
    expect(keep('label:"office egress"', office)).toBe(true);
    expect(keep("label:“office egress”", office), "curly quotes too").toBe(true);
    expect(keep("requests:>100 $and cleared:no", actor())).toBe(true);
    expect(keep("requests:>500 $or paths:9", actor())).toBe(true);
    expect(keep("$not label:office", actor())).toBe(true);
    expect(keep("-actor:203.0.113.4", actor())).toBe(false);
  });

  it("matches everything when there is nothing to go on, and never throws", () => {
    for (const half of ["", "   ", "$", "$in(", "label:$in(", "(", ")", "$and", "-"]) {
      expect(() => keep(half, actor()), half).not.toThrow();
    }
    expect(keep("", actor())).toBe(true);
  });

  /** A name in front of a colon that means nothing here is a word, not a field. */
  it("treats an unknown field as an ordinary word", () => {
    expect(keep("verdict:human", actor())).toBe(false);
    expect(keep("verdict:human", actor({ label: "verdict:human" }))).toBe(true);
  });
});
