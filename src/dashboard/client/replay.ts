import type { DashboardEntry } from "./types.js";

/**
 * A request as a line `bothandlerjs replay` can read.
 *
 * The point of the button this backs: a verdict you disagree with on screen becomes a
 * fixture you can re-run offline, and then a corpus case that stops it coming back.
 * Values the dashboard redacted stay redacted — the shape is what replays, and a
 * session cookie is not part of the shape.
 */
export function replayLine(entry: DashboardEntry): string {
  const headers: Record<string, string> = {};
  for (const [name, value] of entry.headers ?? []) headers[name] = value;
  const query = Object.keys(entry.query)
    .map((name) => `${encodeURIComponent(name)}=${encodeURIComponent(entry.query[name] ?? "")}`)
    .join("&");
  return JSON.stringify({
    method: entry.method,
    url: entry.path + (query === "" ? "" : `?${query}`),
    headers,
    ip: entry.actor,
    timestamp: new Date(entry.at).toISOString(),
    protocol: entry.protocol ?? "https",
    httpVersion: entry.httpVersion ?? "1.1",
  });
}

/** Every shown request as replay JSONL, oldest first — the whole filtered window at once. */
export function replayFile(entries: readonly DashboardEntry[]): string {
  return entries.map(replayLine).join("\n");
}

/** The same request as a traffic-corpus case, ready to paste into a fixture file. */
export function corpusCase(entry: DashboardEntry): string {
  const headers = (entry.headers ?? []).map((pair) => `        [${JSON.stringify(pair[0])}, ${JSON.stringify(pair[1])}]`).join(",\n");
  return [
    "bot({",
    `  id: ${JSON.stringify(`case-${entry.requestId.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`)},`,
    `  title: ${JSON.stringify(`${entry.method} ${entry.path} from ${entry.userAgent.slice(0, 60)}`)},`,
    '  audience: "unwanted-bot",   // human | benign-bot | declared-bot | unwanted-bot | hostile | infrastructure',
    '  category: "observed",',
    `  provenance: "Captured from the live dashboard on ${new Date(entry.at).toISOString().slice(0, 10)}",`,
    "  requests: [",
    "    {",
    "      headers: [",
    headers,
    "      ],",
    `      protocol: ${JSON.stringify(entry.protocol ?? "https")},`,
    `      httpVersion: ${JSON.stringify(entry.httpVersion ?? "1.1")},`,
    `      path: ${JSON.stringify(entry.path)},`,
    "    },",
    "  ],",
    `  expect: { verdict: ${JSON.stringify(entry.verdict)}, certain: ${String(entry.certain)} },`,
    "}),",
  ].join("\n");
}
