import { describe, expect, it } from "vitest";
import { BotHandler, createFacts } from "../src/index.js";
import { ChallengeService, parseAcceptLanguage, pickTranslation } from "../src/challenge/index.js";
import type { RequestFacts } from "../src/types.js";
import { ManualClock } from "../src/internal/clock.js";
import { MemoryStore } from "../src/stores/memory.js";
import { countLeadingZeroBits, solveProofOfWork, verifyProofOfWork } from "../src/challenge/pow.js";
import { issueToken, newClearance, verifyToken } from "../src/challenge/token.js";
import { parseCookies } from "../src/internal/http.js";
import type { ChallengeClaims, ClearanceClaims } from "../src/challenge/token.js";

const SECRET = "a".repeat(32);
const OTHER = "b".repeat(32);

/** The lowest counter that does *not* satisfy `nonce` at `difficulty`. See its one caller. */
function solutionThatMisses(nonce: string, difficulty: number): string {
  for (let counter = 0; counter < 1000; counter++) {
    if (!verifyProofOfWork(nonce, String(counter), difficulty)) return String(counter);
  }
  throw new Error("no failing solution in 1000 tries, which is impossible unless the verifier is broken");
}

function service(clock = new ManualClock(1_000_000)) {
  return { service: new ChallengeService({ secrets: [SECRET], store: new MemoryStore({ clock }), clock, difficulty: 8 }), clock };
}

describe("proof of work", () => {
  it("counts leading zero bits", () => {
    expect(countLeadingZeroBits(new Uint8Array([0, 0, 0xff]))).toBe(16);
    expect(countLeadingZeroBits(new Uint8Array([0x0f]))).toBe(4);
    expect(countLeadingZeroBits(new Uint8Array([0x80]))).toBe(0);
  });

  it("accepts a solution it produced and rejects a wrong one", () => {
    const solution = solveProofOfWork("nonce", 10);
    expect(solution).toBeDefined();
    expect(verifyProofOfWork("nonce", solution!, 10)).toBe(true);
    expect(verifyProofOfWork("different-nonce", solution!, 10)).toBe(false);
  });

  it("refuses inputs that would make the server hash arbitrary data", () => {
    expect(verifyProofOfWork("nonce", "x".repeat(500), 1)).toBe(false);
    expect(verifyProofOfWork("nonce", "not-a-number", 1)).toBe(false);
    expect(verifyProofOfWork("nonce", "", 1)).toBe(false);
  });
});

describe("tokens", () => {
  it("round-trips a valid token", () => {
    const claims = newClearance("subject", "pow", 60_000, 1000);
    const result = verifyToken<ClearanceClaims>(issueToken(claims, [SECRET]), [SECRET], 2000, "subject");
    expect(result.ok).toBe(true);
  });

  it("rejects a token signed with a different secret", () => {
    const token = issueToken(newClearance("subject", "pow", 60_000, 1000), [OTHER]);
    expect(verifyToken(token, [SECRET], 2000).ok).toBe(false);
  });

  // Reading claims from an unverified token is how a signed token becomes an
  // unsigned one, so the signature has to be checked first.
  it("rejects a tampered payload even when the claims look fine", () => {
    const token = issueToken(newClearance("subject", "pow", 60_000, 1000), [SECRET]);
    const [body, signature] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ v: 1, sub: "subject", iat: 1000, exp: 9_999_999_999_999, jti: "x", lvl: "operator" })).toString("base64url");
    expect(body).not.toBe(forged);
    expect(verifyToken(`${forged}.${signature!}`, [SECRET], 2000).ok).toBe(false);
  });

  it("rejects an expired token and a token bound to another actor", () => {
    const token = issueToken(newClearance("subject", "pow", 60_000, 1000), [SECRET]);
    expect(verifyToken(token, [SECRET], 999_999)).toEqual({ ok: false, reason: "expired" });
    expect(verifyToken(token, [SECRET], 2000, "someone-else")).toEqual({ ok: false, reason: "wrong-actor" });
  });

  it("verifies against every secret so a key can be rotated without logging anyone out", () => {
    const old = issueToken(newClearance("subject", "pow", 60_000, 1000), [OTHER]);
    expect(verifyToken(old, [SECRET, OTHER], 2000).ok).toBe(true);
  });

  it("rejects malformed input rather than throwing", () => {
    for (const bad of ["", "no-dot", "a.b.c.d", "x".repeat(5000)]) {
      expect(verifyToken(bad, [SECRET], 1000).ok).toBe(false);
    }
  });
});

describe("ChallengeService", () => {
  it("refuses to start with a weak secret", () => {
    expect(() => new ChallengeService({ secrets: ["short"] })).toThrow(/at least 32/);
    expect(() => new ChallengeService({ secrets: [] })).toThrow(/at least one secret/);
  });

  it("issues a self-contained page with a locked-down CSP", () => {
    const { service: challenge } = service();
    const response = challenge.issue("203.0.113.1");
    expect(response.status).toBe(429);
    expect(response.headers["content-security-policy"]).toMatch(/default-src 'none'/);
    expect(response.headers["content-security-policy"]).toMatch(/script-src 'nonce-/);
    // No external resource of any kind may appear on an interstitial.
    expect(response.body).not.toMatch(/src="https?:/);
    expect(response.body).toMatch(/<noscript>/);
  });

  it("accepts a correct solution and grants clearance bound to the actor", async () => {
    const { service: challenge } = service();
    const page = challenge.issue("203.0.113.1");
    const token = extractChallenge(page.body);
    const nonce = readNonce(token);
    const outcome = await challenge.verifySolution("203.0.113.1", { challenge: token, solution: solveProofOfWork(nonce, 8) });
    expect(outcome.ok).toBe(true);

    const cookies = parseCookies(outcome.ok ? outcome.setCookie.split(";")[0]! : "");
    expect(challenge.read("203.0.113.1", cookies)?.lvl).toBe("pow");
    // A clearance lifted from one actor is worthless to another.
    expect(challenge.read("198.51.100.1", cookies)).toBeUndefined();
  });

  it("refuses a replayed solution", async () => {
    const { service: challenge } = service();
    const token = extractChallenge(challenge.issue("203.0.113.1").body);
    const solution = solveProofOfWork(readNonce(token), 8);
    expect((await challenge.verifySolution("203.0.113.1", { challenge: token, solution })).ok).toBe(true);
    const replay = await challenge.verifySolution("203.0.113.1", { challenge: token, solution });
    expect(replay).toEqual({ ok: false, status: 409, reason: "challenge already solved" });
  });

  /**
   * The solution is searched for rather than written down, and it has to be.
   *
   * This used to submit the literal "1", which is a *wrong* answer to a random nonce
   * only 255 times in 256: at difficulty 8, one guess in 256 is a valid proof of work
   * by accident. So the test failed about one run in 271, at random, on a machine
   * nobody had changed — and it failed saying that a bad solution had been accepted,
   * which is the most alarming sentence this suite can produce and was not true.
   *
   * Asking for a counter that provably misses makes the assertion mean what its name
   * says whatever nonce comes up. The search ends almost immediately: all but one
   * counter in 256 is a miss.
   */
  it("refuses a solution that does not satisfy the challenge", async () => {
    const { service: challenge } = service();
    const token = extractChallenge(challenge.issue("203.0.113.1").body);
    const wrong = solutionThatMisses(readNonce(token), 8);
    expect(verifyProofOfWork(readNonce(token), wrong, 8)).toBe(false);

    const outcome = await challenge.verifySolution("203.0.113.1", { challenge: token, solution: wrong });
    expect(outcome).toMatchObject({ ok: false, status: 400 });
  });

  it("refuses a challenge issued to a different actor", async () => {
    const { service: challenge } = service();
    const token = extractChallenge(challenge.issue("203.0.113.1").body);
    const outcome = await challenge.verifySolution("198.51.100.1", { challenge: token, solution: solveProofOfWork(readNonce(token), 8) });
    expect(outcome).toMatchObject({ ok: false, status: 409 });
  });

  it("rejects a malformed body without throwing", async () => {
    const { service: challenge } = service();
    for (const body of [null, "string", {}, { challenge: 1, solution: [] }]) {
      expect((await challenge.verifySolution("203.0.113.1", body)).ok).toBe(false);
    }
  });

  it("does not put the actor key in the token", () => {
    const { service: challenge } = service();
    const cookie = challenge.grant("203.0.113.99", "operator");
    expect(cookie).not.toContain("203.0.113.99");
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Lax/);
  });
});

/**
 * Rotation, exercised through the service rather than through `verifyToken`.
 *
 * The token layer already verified against every secret; the binding did not. A
 * clearance's subject is derived under a secret, so deriving only under the newest one
 * meant that following the documented rotation procedure rejected every outstanding
 * cookie as `wrong-actor` — signature good, binding stale — and sent every visitor
 * holding valid clearance back through the interstitial at once.
 */
describe("rotating a signing secret", () => {
  function jar(setCookie: string): Record<string, string> {
    return parseCookies(setCookie.split(";")[0]!);
  }

  it("keeps outstanding clearance valid when a secret is prepended", () => {
    const before = new ChallengeService({ secrets: [OTHER] });
    const cookies = jar(before.grant("203.0.113.9", "operator"));
    expect(before.read("203.0.113.9", cookies)?.lvl).toBe("operator");

    const after = new ChallengeService({ secrets: [SECRET, OTHER] });
    expect(after.read("203.0.113.9", cookies)?.lvl).toBe("operator");
  });

  it("lets a challenge issued before the rotation still be solved after it", async () => {
    const clock = new ManualClock(1_000_000);
    const store = new MemoryStore({ clock });
    const before = new ChallengeService({ secrets: [OTHER], store, clock, difficulty: 8 });
    const token = extractChallenge(before.issue("203.0.113.1").body);

    const after = new ChallengeService({ secrets: [SECRET, OTHER], store, clock, difficulty: 8 });
    const outcome = await after.verifySolution("203.0.113.1", { challenge: token, solution: solveProofOfWork(readNonce(token), 8) });
    expect(outcome.ok).toBe(true);
  });

  // Retiring a secret is what actually ends a token's life, and it still must.
  it("stops honouring a clearance once its secret is dropped", () => {
    const before = new ChallengeService({ secrets: [OTHER] });
    const cookies = jar(before.grant("203.0.113.9", "operator"));
    expect(new ChallengeService({ secrets: [SECRET] }).read("203.0.113.9", cookies)).toBeUndefined();
  });

  // Accepting several subjects must not turn into accepting anybody's.
  it("still refuses a clearance minted for a different actor", () => {
    const service = new ChallengeService({ secrets: [SECRET, OTHER] });
    const cookies = jar(service.grant("203.0.113.9", "operator"));
    expect(service.read("203.0.113.10", cookies)).toBeUndefined();
  });
});

function extractChallenge(html: string): string {
  const match = /"challenge":"([^"]+)"/.exec(html);
  if (!match) throw new Error("no challenge in the rendered page");
  return match[1]!;
}

function readNonce(token: string): string {
  const body = token.slice(0, token.lastIndexOf("."));
  return (JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as ChallengeClaims).nonce;
}

/**
 * Which language the interstitial is written in.
 *
 * This is the only page in the library a member of the public sees, and they see it
 * because a *probabilistic* verdict went against them. Somebody who cannot read it
 * cannot find the contact link on it either, which turns a check into a wall.
 */
describe("challenging somebody in a language they read", () => {
  const service = (): ChallengeService =>
    new ChallengeService({
      secrets: ["a-secret-of-at-least-thirty-two-characters"],
      contactHtml: '<a href="mailto:help@example.com">Email us</a>',
      translations: {
        ja: { title: "ブラウザーを確認しています", message: "数秒で完了します。" },
        "pt-BR": { title: "Verificando seu navegador" },
        de: { title: "Wir prüfen Ihren Browser" },
      },
    });

  const render = (acceptLanguage?: string): { html: string; lang: string; title: string } => {
    const html = service().issue("203.0.113.1", { acceptLanguage }).body;
    return {
      html,
      lang: /<html lang="([^"]+)"/.exec(html)?.[1] ?? "",
      title: /<h1>([^<]+)<\/h1>/.exec(html)?.[1] ?? "",
    };
  };

  it("uses the visitor's language when it has one", () => {
    expect(render("ja,en;q=0.8").title).toBe("ブラウザーを確認しています");
    expect(render("pt-BR,pt;q=0.9,en;q=0.5").title).toBe("Verificando seu navegador");
  });

  /**
   * A screen reader picks its voice from the `lang` attribute, so Japanese text
   * announced as English is read aloud by an English voice and is unintelligible.
   * Getting the copy right and the attribute wrong helps nobody.
   */
  it("sets the document language to match the copy", () => {
    expect(render("ja").lang).toBe("ja");
    expect(render("pt-BR").lang).toBe("pt-BR");
    expect(render(undefined).lang).toBe("en");
  });

  it("honours q values rather than header order", () => {
    expect(render("en-GB;q=0.2,ja;q=0.9").title).toBe("ブラウザーを確認しています");
  });

  it("falls back from a region to the primary language", () => {
    expect(render("de-CH").title).toBe("Wir prüfen Ihren Browser");
  });

  /**
   * `pt-PT` is not handed `pt-BR`, and that looks unhelpful until you consider the case
   * it protects: serving Simplified Chinese to somebody who asked for Traditional is a
   * worse failure than serving English, and no rule can tell the two apart.
   */
  it("does not substitute one regional variant for another", () => {
    expect(render("pt-PT").title).toBe("Checking your browser");
  });

  it("keeps the default text for anything a translation leaves out", () => {
    // `pt-BR` supplies only a title, so the message and the contact link stay as
    // configured rather than vanishing.
    expect(render("pt-BR").html).toContain("mailto:help@example.com");
  });

  it("ignores a header it cannot read rather than failing the page", () => {
    for (const header of ["", "   ", "*", "!!!", "en;q=nonsense", "x".repeat(5000)]) {
      expect(render(header).title.length).toBeGreaterThan(0);
    }
  });

  it("treats q=0 as a refusal", () => {
    expect(parseAcceptLanguage("ja;q=0,de")).toEqual(["de"]);
  });

  it("reads a header nobody supplied as no preference at all", () => {
    expect(parseAcceptLanguage(undefined)).toEqual([]);
    expect(pickTranslation({ ja: { title: "x" } }, [])).toBeUndefined();
  });
});

/**
 * The count of challenges nobody answered.
 *
 * Outstanding rather than cumulative, and the difference is the signal: solving one
 * clears the lot, because somebody who answers has answered and carrying their earlier
 * abandoned attempts forward would keep accusing a person who just proved they are one.
 */
describe("counting challenges that were never answered", () => {
  const browser =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

  function handler(): BotHandler {
    return new BotHandler({
      rules: [{ id: "suspects", match: { verdict: "suspected-bot" }, action: "challenge" }],
      // Eight bits, so solving one in a test costs microseconds rather than seconds.
      challenge: { secrets: ["a-secret-of-at-least-thirty-two-characters"], difficulty: 8 },
    });
  }

  const request = (): RequestFacts =>
    createFacts({ method: "GET", url: "/products", headers: { host: "shop.example", "user-agent": browser }, ip: "203.0.113.9", protocol: "https", httpVersion: "1.1" });

  it("rises with each challenge that goes unanswered", async () => {
    const engine = handler();
    const counts: number[] = [];
    for (let i = 0; i < 4; i++) counts.push((await engine.handle(request())).assessment.actor.unsolvedChallenges);
    // The first request is judged before it is challenged, so the count it reports is
    // what was outstanding *before* this one.
    expect(counts).toEqual([0, 1, 2, 3]);
  });

  it("is cleared by a solution, rather than merely stopping", async () => {
    const engine = handler();
    for (let i = 0; i < 3; i++) await engine.handle(request());
    expect(engine.registry.peek("203.0.113.9")?.unsolvedChallenges).toBe(3);

    // The same route a browser takes: read the token out of the page it was served,
    // solve the puzzle in it, and post the answer back.
    const token = extractChallenge(engine.challenge!.issue("203.0.113.9").body);
    const solution = solveProofOfWork(readNonce(token), 8);
    const outcome = await engine.verifyChallenge(request(), { challenge: token, solution });
    expect(outcome.ok).toBe(true);

    expect(engine.registry.peek("203.0.113.9")?.unsolvedChallenges).toBe(0);
  });
});
