/**
 * The dashboard on a server you already have, behind your own TLS.
 *
 * ```bash
 * openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=localhost \
 *   -keyout /tmp/key.pem -out /tmp/cert.pem
 *
 * TLS_KEY=/tmp/key.pem TLS_CERT=/tmp/cert.pem npx tsx examples/dashboard-mounted.ts
 * ```
 *
 * ```bash
 * curl -k https://localhost:8443/                       # the site, assessed
 * curl -k https://localhost:8443/_bots/ -u ops:hunter2  # the dashboard
 * curl -k https://localhost:8443/_bots/                 # 401, on every path
 * ```
 *
 * `startDashboard` opens a plain HTTP listener of its own, which is right on a laptop
 * and wrong in most production networks: the certificate lives at an ingress, or
 * everything has to be reachable under one hostname, or the platform exposes exactly
 * one port. `createDashboardHandler` is the same dashboard without the socket.
 *
 * What has *not* changed is why the dashboard is separate from the application it
 * reports on. Mount it on a server that does not run your bot handler — as this file
 * does, with the handler applied to the site's routes and not to the dashboard's.
 * Serving it from inside the application means reading the dashboard shows up in the
 * dashboard, and a challenge served to your site can lock you out of the tool you are
 * using to read about it.
 */
import { createServer } from "node:https";
import { readFileSync } from "node:fs";
import { BotHandler, createDashboardHandler, createFacts } from "../src/index.js";
import type { IncomingMessage, ServerResponse } from "node:http";

const PORT = Number(process.env["PORT"] ?? 8443);
const KEY = process.env["TLS_KEY"];
const CERT = process.env["TLS_CERT"];

if (KEY === undefined || CERT === undefined) {
  console.error(
    "\n  This example needs a certificate, because its whole point is serving the\n" +
      "  dashboard over TLS you already have. Make a throwaway one:\n\n" +
      "    openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=localhost \\\n" +
      "      -keyout /tmp/key.pem -out /tmp/cert.pem\n\n" +
      "  then:\n\n    TLS_KEY=/tmp/key.pem TLS_CERT=/tmp/cert.pem npx tsx examples/dashboard-mounted.ts\n",
  );
  process.exit(1);
}

const detector = new BotHandler({ preset: "protect-content" });

/**
 * The dashboard, as a request handler.
 *
 * `auth` is required here and optional in `startDashboard`, and that is not an
 * inconsistency: the listening form may skip it on `127.0.0.1`, because the operating
 * system is then the access control. Mounted, there is no bind address to inspect, so
 * nothing can be assumed and what is assumed is "public".
 *
 * `basePath` is the path the page is served under, which is what the page needs in
 * order to build its own URLs. Routing accepts the path with or without that prefix, so
 * this works whether or not your framework strips the mount point before calling in.
 */
const dashboard = createDashboardHandler(detector, {
  basePath: "/_bots",
  title: "acme — bots",
  auth: { username: "ops", password: process.env["DASHBOARD_PASSWORD"] ?? "hunter2" },
  // A layer on top of `auth`, never a substitute for it: an address is not a person,
  // and a shared office range is not one either. Behind a load balancer this is how you
  // say "our VPN, nobody else".
  allowedClients: ["127.0.0.1/32", "::1/128"],
  // One process, one dashboard. Naming it stops a partial picture looking like a whole
  // one when there are eight of these behind a load balancer.
  instance: process.env["HOSTNAME"] ?? "local",
});

const server = createServer({ key: readFileSync(KEY), cert: readFileSync(CERT) }, (request, response) => {
  // One `if`, and it is the shape of the whole arrangement: the dashboard sees the
  // requests addressed to it, the site sees everything else, and only the site is
  // assessed.
  if (request.url?.startsWith("/_bots") === true) {
    dashboard(request, response);
    return;
  }
  void serveSite(request, response);
});

async function serveSite(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const facts = createFacts({
    method: request.method ?? "GET",
    url: request.url ?? "/",
    headers: request.headers as Record<string, string>,
    ip: detector.resolveIp(request.socket.remoteAddress, request.headers as Record<string, string | undefined>),
    protocol: "https",
    httpVersion: request.httpVersion,
  });

  const { decision } = await detector.handle(facts);

  if (decision.action === "block") {
    response.writeHead(403, { "content-type": "text/plain" });
    response.end("Automated traffic is not served here.\n");
    return;
  }
  response.writeHead(200, { "content-type": "text/plain" });
  response.end(`the site — rule "${decision.rule}" chose ${decision.action}\n`);
}

server.listen(PORT, () => {
  console.log(`\n  site        https://localhost:${PORT}/`);
  console.log(`  dashboard   https://localhost:${PORT}/_bots/   (ops / hunter2)`);
  console.log("\n  The certificate is whatever you passed in, so curl needs -k for a self-signed one.\n");
});
