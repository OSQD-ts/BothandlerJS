/**
 * Reads the detector and action write-ups in `docs/` into the data the dashboard's
 * Reference screen renders.
 *
 * Generated rather than written a second time. The documentation is where these are
 * explained and reviewed, and a copy kept by hand inside the client would be the version
 * that is wrong — the one describing a threshold that changed two releases ago, on the
 * screen people read while deciding whether to trust a verdict.
 *
 * The output is a structure, never markup: see `src/dashboard/client/reference-model.ts`.
 * Only the markdown these three files actually use is understood — paragraphs, lists,
 * tables, fenced code, headings, and inline code, emphasis and links — and anything else
 * arrives as plain text rather than being interpreted.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const SOURCES = {
  detectors: "docs/detection/detectors.md",
  correlation: "docs/detection/correlation.md",
  actions: "docs/policy/actions.md",
};

// ---- inline -------------------------------------------------------------------

const INLINE = /`([^`]+)`|\*\*(.+?)\*\*|\[([^\]]+)\]\([^)]+\)|(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])|(?<![\w\\])_(?!\s)(.+?)(?<!\s)_(?!\w)/g;

/** One line of markdown as runs of text. Links keep their text and lose their target. */
export function inline(source, setting = "t") {
  const out = [];
  const push = (kind, text) => {
    if (text === "") return;
    const last = out[out.length - 1];
    if (last !== undefined && last[0] === kind) last[1] += text;
    else out.push([kind, text]);
  };
  let at = 0;
  for (const match of source.matchAll(INLINE)) {
    push(setting, source.slice(at, match.index));
    const [, code, bold, link, star, underscore] = match;
    if (code !== undefined) push("code", code);
    else if (bold !== undefined) for (const [kind, text] of inline(bold, "b")) push(kind, text);
    else if (link !== undefined) for (const [kind, text] of inline(link, setting)) push(kind, text);
    else for (const [kind, text] of inline(star ?? underscore, setting === "b" ? "b" : "i")) push(kind, text);
    at = match.index + match[0].length;
  }
  push(setting, source.slice(at));
  return out;
}

const plain = (inlines) => inlines.map(([, text]) => text).join("");

// ---- blocks -------------------------------------------------------------------

function cells(line) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => inline(cell.trim()));
}

/** Markdown lines as blocks. Headings become `h` whatever their level. */
export function blocks(lines) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i++;
      continue;
    }
    const fence = /^```(\w*)/.exec(line);
    if (fence !== null) {
      const code = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) code.push(lines[i++]);
      i++;
      out.push({ kind: "code", lang: fence[1], code: code.join("\n") });
      continue;
    }
    const heading = /^#{2,6}\s+(.*)$/.exec(line);
    if (heading !== null) {
      out.push({ kind: "h", text: inline(heading[1]) });
      i++;
      continue;
    }
    if (line.startsWith("|")) {
      const rows = [];
      while (i < lines.length && lines[i].startsWith("|")) rows.push(lines[i++]);
      const body = rows.filter((row, index) => index !== 1 || !/^\|[\s:|-]+\|?$/.test(row.trim()));
      out.push({ kind: "table", head: cells(body[0]), rows: body.slice(1).map(cells) });
      continue;
    }
    if (/^(?:[-*]|\d+\.)\s/.test(line)) {
      const items = [];
      while (i < lines.length && lines[i].trim() !== "") {
        const item = /^(?:[-*]|\d+\.)\s+(.*)$/.exec(lines[i]);
        if (item !== null) items.push(item[1]);
        else items[items.length - 1] += ` ${lines[i].trim()}`;
        i++;
      }
      out.push({ kind: "list", items: items.map((item) => inline(item)) });
      continue;
    }
    const paragraph = [];
    while (i < lines.length && lines[i].trim() !== "" && !/^(```|\||#{2,6}\s)/.test(lines[i])) paragraph.push(lines[i++].replace(/^>\s?/, "").trim());
    out.push({ kind: "p", text: inline(paragraph.join(" ")) });
  }
  return out;
}

/**
 * A document cut into its headed sections. A `---` rule ends a section as well, because
 * these files use one to close each part; fenced code is skipped so a rule inside an
 * example is not mistaken for one.
 */
function sections(markdown) {
  const out = [];
  let current = { level: 0, title: "", lines: [] };
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (line.startsWith("```")) fenced = !fenced;
    const heading = fenced ? null : /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading !== null || (!fenced && line.trim() === "---")) {
      out.push(current);
      current = heading === null ? { level: 0, title: "", lines: [], rule: true } : { level: heading[1].length, title: heading[2], lines: [] };
      continue;
    }
    current.lines.push(line);
  }
  out.push(current);
  return out;
}

const idOf = (title) => /^`([a-z][a-z0-9-]*)`$/.exec(title.trim())?.[1];

/** The text between the first `---` rule and the second: each file's "how to read this" part. */
function introOf(markdown) {
  const parts = markdown.split(/^---$/m);
  return blocks((parts[1] ?? "").split("\n"));
}

/** A bold first paragraph that is only the facts line — `**cheap · always · ceiling `moderate`**`. */
function takeFacts(entryBlocks) {
  const first = entryBlocks[0];
  if (first?.kind !== "p" || first.text.some(([kind]) => kind === "t" || kind === "i")) return [];
  entryBlocks.shift();
  return plain(first.text).split(" · ").map((fact) => fact.trim()).filter(Boolean);
}

function summaryOf(entryBlocks) {
  const first = entryBlocks.find((block) => block.kind === "p");
  return first === undefined ? "" : plain(first.text);
}

// ---- detectors ------------------------------------------------------------------

function detectorEntries(markdown) {
  const entries = [];
  let group = "";
  for (const section of sections(markdown)) {
    if (section.level === 2) group = section.title;
    const id = section.level === 3 ? idOf(section.title) : undefined;
    if (id === undefined) continue;
    const entryBlocks = blocks(section.lines);
    const facts = takeFacts(entryBlocks);
    entries.push({ kind: "detector", id, group, facts, summary: summaryOf(entryBlocks), blocks: entryBlocks, source: SOURCES.detectors });
  }
  return entries;
}

/**
 * The detectors that need `probe`, `challenge` or `site`, which the catalogue lists only by
 * name and ceiling and explains in `correlation.md`.
 *
 * Their text is gathered from that file by what it is about. A paragraph that opens by
 * naming one of them — `` `path-novelty` is a self-maintaining wordlist`` — belongs to it,
 * and so does everything after it in the same section until another is named; a section
 * whose heading names one ("Identity drift, and why…") belongs to it from the start.
 */
function optionalDetectorEntries(catalogue, correlation) {
  const entries = new Map();
  const tail = catalogue.split(/^## Detectors that arrive with something else$/m)[1] ?? "";
  let needs = "";
  let needsText = [];
  for (const block of blocks(tail.split(/^---$/m)[0].split("\n"))) {
    if (block.kind === "p") {
      const named = /^With (\w+)/.exec(plain(block.text));
      if (named !== null) {
        needs = named[1];
        needsText = block.text;
      }
    }
    if (block.kind !== "table" || needs === "") continue;
    for (const row of block.rows) {
      const id = plain(row[0] ?? []);
      const ceiling = plain(row[1] ?? []);
      entries.set(id, {
        kind: "detector",
        id,
        group: `Installed with ${needs}`,
        facts: [`ceiling ${ceiling}`, `needs ${needs}`],
        summary: "",
        blocks: [{ kind: "p", text: needsText }],
        source: SOURCES.correlation,
      });
    }
  }

  for (const section of sections(correlation)) {
    const sectionBlocks = blocks(section.lines);
    for (const block of sectionBlocks) {
      if (block.kind !== "table") continue;
      const reads = block.head.findIndex((cell) => plain(cell) === "Reads");
      if (reads === -1) continue;
      for (const row of block.rows) {
        const entry = entries.get(plain(row[0] ?? []));
        if (entry === undefined) continue;
        entry.summary = plain(row[reads] ?? []);
        entry.blocks.unshift({ kind: "p", text: [["b", `Reads: `], ...row[reads]] });
      }
    }
    if (section.level !== 3) continue;
    const headingWords = section.title.toLowerCase();
    let current = [...entries.keys()].find((id) => headingWords.startsWith(id.replace(/-/g, " ")));
    const headed = new Set();
    for (const block of sectionBlocks) {
      if (block.kind === "p") {
        const lead = block.text[0]?.[0] === "code" ? block.text[0][1] : block.text[0]?.[0] === "b" && block.text[1]?.[0] === "code" && block.text[0][1].trim() === "" ? block.text[1][1] : /^`?([a-z-]+)`?/.exec(plain(block.text))?.[1];
        if (lead !== undefined && entries.has(lead)) current = lead;
      }
      if (current === undefined) continue;
      if (!headed.has(current)) {
        headed.add(current);
        entries.get(current).blocks.push({ kind: "h", text: inline(section.title) });
      }
      entries.get(current).blocks.push(block);
    }
  }
  return [...entries.values()];
}

// ---- actions ------------------------------------------------------------------------

function actionEntries(markdown) {
  const intro = introOf(markdown);
  const table = intro.find((block) => block.kind === "table");
  const facts = new Map();
  for (const row of table?.rows ?? []) {
    const terminal = plain(row[1] ?? []).trim() !== "";
    facts.set(plain(row[0] ?? []), { terminal, costs: plain(row[2] ?? []) });
  }
  const entries = [];
  for (const section of sections(markdown)) {
    const id = section.level === 2 ? idOf(section.title) : undefined;
    if (id === undefined) continue;
    const known = facts.get(id);
    const entryBlocks = blocks(section.lines);
    entries.push({
      kind: "action",
      id,
      group: known?.terminal === true ? "Ends the request" : "Serves the request",
      facts: known === undefined ? [] : [known.terminal ? "terminal" : "not terminal", `costs a person ${known.costs}`],
      summary: summaryOf(entryBlocks),
      blocks: entryBlocks,
      source: SOURCES.actions,
    });
  }
  return entries;
}

/** The whole data set, as the source of the generated module. */
export async function buildReference(root) {
  const read = (path) => readFile(join(root, path), "utf8");
  const [detectors, correlation, actions] = await Promise.all([read(SOURCES.detectors), read(SOURCES.correlation), read(SOURCES.actions)]);
  const catalogue = detectorEntries(detectors);
  const documented = new Set(catalogue.map((entry) => entry.id));
  const data = {
    intro: { detector: introOf(detectors), action: introOf(actions) },
    entries: [...catalogue, ...optionalDetectorEntries(detectors, correlation).filter((entry) => !documented.has(entry.id)), ...actionEntries(actions)],
  };
  return `/**
 * Generated by \`npm run client:build\` from ${Object.values(SOURCES).map((path) => `\`${path}\``).join(", ")}. Do not edit.
 *
 * The Reference screen's text. See scripts/build-reference.mjs.
 */

/* eslint-disable */
import type { ReferenceData } from "./reference-model.js";

export const REFERENCE: ReferenceData = ${JSON.stringify(data, null, 1)};
`;
}
