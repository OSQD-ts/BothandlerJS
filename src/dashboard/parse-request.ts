/**
 * Turns whatever somebody pasted into a request the engine can assess.
 *
 * Three shapes, because those are the three things people have to hand when they want
 * to ask "why is this client being challenged?": a `curl` command copied out of a
 * terminal or a browser's devtools, a raw header block copied out of a log, or just a
 * User-Agent string copied out of a support ticket. Guessing between them is safe —
 * they are unambiguous — and asking somebody to pick would be asking them to know.
 *
 * Everything here is pure and DOM-free so it can be tested by calling it. The parsing
 * is deliberately forgiving: this is a paste box for a person in a hurry, not a
 * protocol parser, and a header it cannot make sense of is dropped rather than fatal.
 */

export interface ParsedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  ip: string;
  /** Fields the paste did not carry, which had to be invented to make a request at all. */
  assumed: string[];
}

/** Documentation range (TEST-NET-3). Never routable, so it cannot match a real reputation list. */
const DEFAULT_IP = "203.0.113.1";
const DEFAULT_HOST = "test.invalid";
const MAX_INPUT = 8000;
const MAX_HEADERS = 40;

export interface ParseOptions {
  /** Overrides for what the paste did not say. The tester's own fields. */
  method?: string | undefined;
  url?: string | undefined;
  ip?: string | undefined;
}

export function parseRequest(input: string, options: ParseOptions = {}): ParsedRequest {
  const text = input.slice(0, MAX_INPUT).trim();
  if (text === "") throw new Error("Nothing to test. Paste a User-Agent, a curl command, or a block of request headers.");

  const parsed = looksLikeCurl(text) ? fromCurl(text) : looksLikeHeaders(text) ? fromHeaders(text) : fromUserAgent(text);

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed.headers).slice(0, MAX_HEADERS)) {
    if (name.trim() === "") continue;
    headers[name.toLowerCase()] = value;
  }

  const assumed: string[] = [];
  const method = (options.method ?? parsed.method ?? "GET").toUpperCase();
  const url = options.url ?? parsed.url ?? "/";
  const ip = options.ip ?? DEFAULT_IP;
  if (options.ip === undefined) assumed.push(`client address ${DEFAULT_IP}`);
  if (headers["host"] === undefined) {
    headers["host"] = DEFAULT_HOST;
    assumed.push(`Host: ${DEFAULT_HOST}`);
  }
  if (parsed.method === undefined && options.method === undefined) assumed.push("method GET");
  if (parsed.url === undefined && options.url === undefined) assumed.push("path /");

  return { method, url, headers, ip, assumed };
}

interface Partial_ {
  method?: string | undefined;
  url?: string | undefined;
  headers: Record<string, string>;
}

/**
 * `curl` followed by a space, and not merely a string starting with those four letters.
 *
 * `curl/8.4.0` is a User-Agent — and the single most likely thing anybody pastes into
 * this box, since it is what an operator sees in the feed next to the request they came
 * to ask about. Reading it as a command produced a request with no User-Agent at all
 * and an assessment of "unknown", which is the most misleading answer available: it
 * looks like an answer.
 */
function looksLikeCurl(text: string): boolean {
  return /^curl\s/.test(text);
}

/** A line of the form `Name: value`, which neither a curl command nor a User-Agent has. */
function looksLikeHeaders(text: string): boolean {
  return text.split("\n").some((line) => /^[A-Za-z][A-Za-z0-9-]*:\s/.test(line.trim()));
}

/**
 * A `curl` command, as devtools' "Copy as cURL" writes it.
 *
 * Handles the flags that carry a request's identity — `-H`, `-A`, `-X`, `-b` and the
 * URL — and ignores the rest, which are about how curl behaves rather than about what
 * the server sees.
 */
function fromCurl(text: string): Partial_ {
  const tokens = tokenize(text.replace(/\\\r?\n/g, " "));
  const headers: Record<string, string> = {};
  let method: string | undefined;
  let url: string | undefined;

  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i] ?? "";
    if (token === "-H" || token === "--header") {
      const header = tokens[++i] ?? "";
      const colon = header.indexOf(":");
      if (colon > 0) headers[header.slice(0, colon).trim()] = header.slice(colon + 1).trim();
    } else if (token === "-A" || token === "--user-agent") {
      headers["user-agent"] = tokens[++i] ?? "";
    } else if (token === "-b" || token === "--cookie") {
      headers["cookie"] = tokens[++i] ?? "";
    } else if (token === "-X" || token === "--request") {
      method = tokens[++i] ?? "";
    } else if (token === "-e" || token === "--referer") {
      headers["referer"] = tokens[++i] ?? "";
    } else if (!token.startsWith("-") && url === undefined) {
      url = token;
    }
  }

  if (url !== undefined) {
    try {
      const parsed = new URL(url);
      headers["host"] ??= parsed.host;
      url = parsed.pathname + parsed.search;
    } catch {
      // Not absolute. A path is a perfectly good answer and needs no rewriting.
    }
  }

  return { method, url, headers };
}

/** Whitespace-separated, honouring single and double quotes the way a shell does. */
function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: string | undefined;
  let started = false;

  for (const character of text) {
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      else current += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (current !== "" || started) tokens.push(current);
      current = "";
      started = false;
      continue;
    }
    current += character;
  }
  if (current !== "" || started) tokens.push(current);
  return tokens;
}

/**
 * A raw header block, optionally led by a request line.
 *
 * The order is kept exactly as pasted, and that is the point: `header-order` reads the
 * order a browser sends its headers in, so a block reordered on the way in would be
 * assessed as a different client from the one somebody is asking about.
 */
function fromHeaders(text: string): Partial_ {
  const headers: Record<string, string> = {};
  let method: string | undefined;
  let url: string | undefined;

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;

    const requestLine = /^([A-Z]+)\s+(\S+)(\s+HTTP\/[\d.]+)?$/.exec(line);
    if (requestLine !== null && method === undefined && Object.keys(headers).length === 0) {
      method = requestLine[1];
      url = requestLine[2];
      continue;
    }

    const colon = line.indexOf(":");
    if (colon > 0) headers[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }

  return { method, url, headers };
}

/** Just a User-Agent, which is what a support ticket contains. */
function fromUserAgent(text: string): Partial_ {
  return { headers: { "user-agent": text.replace(/\s+/g, " ").trim() } };
}
