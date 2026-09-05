import { describe, expect, it } from "vitest";
import { clientScriptSource, parseClientSignals, renderClientScript } from "../src/client/index.js";
import { clientSignalsDetector } from "../src/detectors/client-signals.js";
import { collect, makeContext } from "./helpers.js";
import type { ClientSignals } from "../src/client/index.js";

/**
 * The page script, run rather than read.
 *
 * It is emitted as a string, so nothing typechecks it and nothing else in this suite
 * executes it. That is how a check for a *standard* property ended up in a list of
 * automation markers: every browser has `navigator.webdriver`, so every visitor was
 * reported as carrying an automation global. Running the script against a stand-in
 * for an ordinary browser is the only thing that catches that.
 */

const CHROME_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

function run(overrides: { navigator?: Record<string, unknown>; window?: Record<string, unknown> } = {}): ClientSignals {
  const sent: string[] = [];
  const navigator: Record<string, unknown> = {
    // Standard, present in every current browser, and false unless driven.
    webdriver: false,
    languages: ["en-GB", "en"],
    userAgent: CHROME_UA,
    sendBeacon: (_url: string, body: { parts: string[] }) => {
      sent.push(body.parts[0]!);
      return true;
    },
    ...overrides.navigator,
  };
  const window: Record<string, unknown> = {
    navigator,
    screen: { width: 1920, height: 1080 },
    addEventListener: () => {},
    ...overrides.window,
  };
  window["window"] = window;

  const sandbox = {
    window,
    navigator,
    setTimeout: (fn: () => void) => {
      fn();
      return 0;
    },
    Blob: class {
      constructor(readonly parts: string[]) {}
    },
    fetch: () => undefined,
    Date,
  };
  const source = clientScriptSource({ endpoint: "/signals", interactionWindowMs: 0 });
  new Function(...Object.keys(sandbox), source)(...Object.values(sandbox));
  expect(sent, "the script must report something").toHaveLength(1);
  return JSON.parse(sent[0]!) as ClientSignals;
}

describe("the page script on an ordinary browser", () => {
  it("reports no automation markers at all", () => {
    const signals = run();
    expect(signals.automationGlobals, "navigator.webdriver exists in every browser; its presence is not a marker").toEqual([]);
    expect(signals.webdriver).toBe(false);
    expect(signals.noLanguages).toBe(false);
    expect(signals.zeroDimensions).toBe(false);
    expect(signals.inconsistentPlatform).toBe(false);
  });

  it("produces no evidence in either direction", async () => {
    const evidence = await collect(clientSignalsDetector(), makeContext({ extra: { clientSignals: run() } }));
    expect(evidence).toEqual([]);
  });
});

describe("the page script on a driven browser", () => {
  it("reports the driver's own globals and the webdriver flag", () => {
    const signals = run({
      navigator: { webdriver: true },
      window: { __selenium_unwrapped: true, cdc_adoQpoasnfa76pfcZLmcfl_Array: [] },
    });
    expect(signals.webdriver).toBe(true);
    expect(signals.automationGlobals).toEqual(["__selenium_unwrapped", "cdc_adoQpoasnfa76pfcZLmcfl_Array"]);
  });

  it("reads as automation, and no more strongly than that", async () => {
    const signals = run({ navigator: { webdriver: true }, window: { _phantom: true } });
    const evidence = await collect(clientSignalsDetector(), makeContext({ extra: { clientSignals: signals } }));
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.direction).toBe("bot");
    // The payload comes from the one place an adversary fully controls.
    expect(evidence[0]?.certainty).toBe("moderate");
  });

  it("notices a headless-shaped environment", () => {
    const signals = run({ navigator: { languages: [] }, window: { screen: { width: 0, height: 0 } } });
    expect(signals.noLanguages).toBe(true);
    expect(signals.zeroDimensions).toBe(true);
  });
});

describe("parseClientSignals", () => {
  // Every field crossed the network from a client, so nothing may be coerced.
  it("drops anything of the wrong type rather than interpreting it", () => {
    expect(parseClientSignals({ webdriver: "true", interacted: 1, msToInteraction: "5" })).toBeUndefined();
    expect(parseClientSignals(null)).toBeUndefined();
    expect(parseClientSignals("webdriver")).toBeUndefined();
    expect(parseClientSignals({})).toBeUndefined();
  });

  it("bounds what it keeps", () => {
    const signals = parseClientSignals({
      automationGlobals: [...Array(50)].map(() => "x".repeat(200)),
      msToInteraction: 99_999_999,
      webdriver: true,
    })!;
    expect(signals.automationGlobals).toHaveLength(16);
    expect(signals.automationGlobals?.[0]).toHaveLength(64);
    expect(signals.msToInteraction).toBe(3_600_000);
  });

  it("refuses a negative interaction time", () => {
    expect(parseClientSignals({ interacted: true, msToInteraction: -1 })?.msToInteraction).toBeUndefined();
  });
});

describe("renderClientScript", () => {
  it("strips anything that could break out of the nonce attribute", () => {
    const html = renderClientScript({ endpoint: "/signals", nonce: 'abc"><script>alert(1)</script>' });
    const attribute = /nonce="([^"]*)"/.exec(html)?.[1] ?? "";
    // Base64url characters survive, which is what a real nonce is made of; nothing
    // that could close the attribute or open a tag does.
    expect(attribute).not.toMatch(/["'<>\s]/);
    expect(html.indexOf("<script")).toBe(html.lastIndexOf("<script"));
  });

  it("emits no nonce attribute when none was asked for", () => {
    expect(renderClientScript({ endpoint: "/signals" })).not.toContain("nonce=");
  });
});
