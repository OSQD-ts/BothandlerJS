import { afterAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ChildProcess } from "node:child_process";

/**
 * The examples, run rather than only compiled.
 *
 * `tsconfig.typecheck.json` includes `examples/`, so they cannot stop compiling without
 * somebody noticing. Compiling is not the property that matters for all of them: the edge
 * guard's entire job is to turn what this library decides into the three statuses nginx
 * understands, and a mapping can be wrong in every interesting way while type-checking
 * perfectly. It is documented as working, which is a promise worth keeping.
 *
 * Run as a subprocess rather than by importing it, because the example is a script that
 * listens — and because that is how somebody following the documentation will run it.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const running: ChildProcess[] = [];

afterAll(() => {
  // The whole group, not the child. `npx` and `tsx` each spawn the next thing along, so
  // killing what was spawned leaves the process actually holding the port alive — and an
  // orphan listening on the test's port is worse than a leak: the next run connects to
  // it, tests the *previous* code, and passes. This test did exactly that until the
  // orphan was found, reporting green while the mapping under it was deliberately broken.
  for (const child of running) {
    if (child.pid !== undefined) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
  }
});

/** Ports already serving, so a second test does not spawn a process that cannot bind. */
const listening = new Set<number>();

/** Starts an example on a port and waits for it to answer. Once per port. */
async function start(script: string, port: number): Promise<void> {
  if (listening.has(port)) return;
  listening.add(port);
  const child = spawn(join(root, "node_modules", ".bin", "tsx"), [join(root, script)], {
    cwd: root,
    env: { ...process.env, PORT: String(port) },
    stdio: "ignore",
    // Its own group, so the kill above reaches everything it started.
    detached: true,
  });
  running.push(child);
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`${script} exited with ${child.exitCode} before it listened`);
    try {
      await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) });
      return;
    } catch {
      if (Date.now() > deadline) throw new Error(`${script} did not listen on ${port} within a minute`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

describe("the edge guard example", () => {
  const PORT = 9689;

  /** A request as nginx's `auth_request` would present it: a GET, with the original in headers. */
  const ask = (headers: Record<string, string>): Promise<Response> =>
    fetch(`http://127.0.0.1:${PORT}/`, {
      headers: { "x-original-uri": "/", "x-original-method": "GET", ...headers },
    });

  it("answers in the three statuses auth_request understands", async () => {
    await start("examples/edge-auth-request.ts", PORT);

    // A real browser carries on. 2xx is the only thing `auth_request` reads as "allow",
    // and 204 rather than 200 because there is no body worth sending back per request.
    const browser = await ask({
      "x-real-ip": "203.0.113.5",
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      accept: "text/html,application/xhtml+xml",
      "accept-language": "en-GB,en;q=0.9",
    });
    expect(browser.status, "a browser is served").toBe(204);

    // A self-identified scanner is refused outright. 403 is what `auth_request` reads as
    // "do not", and there is nothing for this client to get through.
    const scanner = await ask({ "x-real-ip": "203.0.113.6", "x-original-uri": "/admin", "user-agent": "sqlmap/1.7" });
    expect(scanner.status, "a scanner is refused").toBe(403);

    // A bare HTTP client is challenged, and a challenge is the one refusal the visitor is
    // meant to get *through* — so it answers 401, which the nginx config routes to the
    // interstitial through `error_page`. Answering 403 here would leave a solvable client
    // with nothing to solve.
    const bare = await ask({ "x-real-ip": "203.0.113.7", "x-original-uri": "/api/items", "user-agent": "curl/8.4.0" });
    expect(bare.status, "a bare client is challenged rather than refused").toBe(401);
  }, 120_000);

  it("judges the request nginx was asked for, not the subrequest", async () => {
    await start("examples/edge-auth-request.ts", PORT);
    // `auth_request` sends a GET for the guard's own path whatever the real request was,
    // so the method and target travel in headers. If they were ignored, every request
    // would be judged as `GET /` and half the detectors would read the same thing about
    // everybody — which is invisible until a path-scoped rule silently stops matching.
    const posted = await ask({
      "x-real-ip": "203.0.113.8",
      "x-original-uri": "/checkout?step=2",
      "x-original-method": "POST",
      "user-agent": "sqlmap/1.7",
    });
    expect(posted.status).toBe(403);
  }, 120_000);
});
