import { browser, plain } from "./headers.js";
import { bot, human } from "./schema.js";
import type { TrafficCase } from "./schema.js";

/**
 * Address reputation and prior clearance.
 *
 * Two mechanisms that only work when you have configured them, and that behave very
 * differently from everything else in the corpus:
 *
 * **Address ranges** are operator data. The library ships none, because an
 * address-to-operator mapping goes stale within weeks and a stale mapping is a false
 * positive with a long half-life. A denylist entry is `certain` — not because we
 * deduced anything, but because you decided it — while a datacenter match is capped
 * at `moderate` forever, since consumer VPNs, corporate gateways, Tor exits and
 * privacy relays all live in the same address space as the scrapers.
 *
 * **Clearance** is the only source of human-pointing evidence the library has, and
 * the levels are not interchangeable. A solved proof of work shows that a JavaScript
 * engine ran and CPU was spent — a headless Chrome does both. Only `operator`
 * clearance, which your own application issues on evidence the request does not
 * carry, is treated as conclusive.
 */

export const REPUTATION_CASES: TrafficCase[] = [
  bot({
    id: "denylist-hit",
    title: "An address the operator has denied",
    audience: "hostile",
    category: "address-reputation",
    provenance: "An explicit local decision, not an inference",
    notes:
      "`certain`, and the justification is about responsibility rather than technology: nothing was deduced, an instruction was carried out. It also means a bad denylist entry blocks real people with no probabilistic guard to catch it — which is the argument for reviewing the list rather than growing it.",
    requires: ["denylist"],
    requests: [{ ...browser("chromeWindows"), ip: "203.0.113.244" }],
    expect: { verdict: "confirmed-bot", certain: true, detectors: ["ip-intelligence"] },
  }),
  bot({
    id: "datacenter-scraper",
    title: "A scraper from hosting-provider address space",
    audience: "unwanted-bot",
    category: "address-reputation",
    provenance: "Where bulk extraction is actually run from",
    notes: "The corroborating case: a datacenter address alongside a bare library client is a different proposition from either alone.",
    requires: ["datacenter-ranges"],
    requests: [{ ...plain("python-requests/2.32.3"), ip: "192.0.2.180" }],
    expect: { verdict: "confirmed-bot", botClass: "http-client", certain: true, detectors: ["ip-intelligence", "self-identified"] },
  }),
  human({
    id: "datacenter-human-with-ranges",
    title: "A person on a VPN, with datacenter ranges configured",
    category: "address-reputation",
    provenance: "The same address space, a completely different client",
    notes:
      "The whole reason the datacenter signal is capped at `moderate`. With ranges loaded this person now carries a bot-pointing observation on every request, and it must never be enough to deny them.",
    requires: ["datacenter-ranges"],
    requests: [{ ...browser("firefoxWindows"), ip: "192.0.2.190" }],
    expect: { certain: false, detectors: ["ip-intelligence"] },
    tags: ["known-cost"],
  }),

  human({
    id: "cleared-by-proof-of-work",
    title: "A person who already solved the challenge",
    category: "clearance",
    provenance: "A signed clearance cookie from a completed proof of work",
    notes:
      "Only `moderate` human evidence. Proof of work demonstrates a JavaScript engine and spent CPU; it does not demonstrate a person, and treating it as though it did would be the mirror image of the mistake this library exists to avoid.",
    clearance: "pow",
    requests: [browser("chromeWindows")],
    expect: { detectors: ["clearance"], neverAction: ["block", "drop", "redirect"] },
  }),
  human({
    id: "cleared-by-operator",
    title: "A signed-in customer your application vouches for",
    category: "clearance",
    provenance: "`grantClearance(facts, 'operator')` after a successful login",
    notes:
      "The only conclusive human signal in the library, and it does not come from the request. Your application knows this session is authenticated; the library cannot see that and does not try to guess it.",
    clearance: "operator",
    requests: [browser("chromeWindows")],
    expect: { verdict: "human", certain: true, detectors: ["clearance"], action: ["allow", "log", "tag"] },
  }),
  human({
    id: "cleared-by-interaction",
    title: "A person who ticked the box on the interaction challenge",
    category: "clearance",
    provenance: "A signed clearance cookie granted after a trusted activation on a browser that passed the capability probes",
    notes:
      "`strong` human evidence rather than `certain`, and the gap is the whole point. A trusted gesture in a rendering browser is a real cost imposed and it is still not proof of a person: a browser driven through the DevTools protocol dispatches genuine input events and renders genuine CSS. It outranks a bare proof of work because it costs more, and it stops short of `operator` because that assertion comes from the application and this one comes from the client.",
    clearance: "interaction",
    requests: [browser("chromeWindows")],
    expect: { detectors: ["clearance"], neverAction: ["block", "drop", "redirect"] },
  }),
  human({
    id: "cleared-by-interaction-on-a-phone",
    title: "A person who tapped the box on a phone",
    category: "clearance",
    provenance: "A tap emits almost no pointermove, so the report carries no path at all",
    notes:
      "Kept because the absence of a pointer path used to be scored as a mark against the client, which graded every phone — and every screen reader, switch and voice-control user — down to the weaker clearance for the way they use a computer. A tap is reported as touch and graded on its capabilities.",
    clearance: "interaction",
    requests: [browser("safariIos")],
    expect: { detectors: ["clearance"], neverAction: ["block", "drop", "redirect"] },
  }),
  bot({
    id: "cleared-but-proven-bot",
    title: "A proven bot presenting a valid clearance token",
    audience: "unwanted-bot",
    category: "clearance",
    provenance: "A headless browser solves a proof of work as readily as a laptop does",
    notes:
      "Proven bot evidence outranks clearance, deliberately. This is also the shape that used to livelock: passing a challenge cannot undo a `certain` verdict, so a client that could run JavaScript was challenged, solved, reloaded and was challenged again forever. The action layer now refuses to re-issue a challenge to an actor that already holds one.",
    clearance: "pow",
    requests: [plain("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/152.0.0.0 Safari/537.36")],
    // Asserted on the *outcome*, not the decision: a policy is free to decide
    // "challenge" here, and the action layer is required to refuse to issue it.
    expect: { verdict: "confirmed-bot", botClass: "automation", certain: true, outcome: "continue" },
    tags: ["regression"],
  }),
];
