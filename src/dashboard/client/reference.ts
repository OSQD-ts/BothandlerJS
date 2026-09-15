import { $, clear, el, rootNode } from "./dom.js";
import { SECTIONS } from "./boot.js";
import { app } from "./app.js";
import { state } from "./store.js";
import { REFERENCE } from "./reference.generated.js";
import { referenceKey } from "./reference-model.js";
import type { Block, Inline, ReferenceEntry, ReferenceKind } from "./reference-model.js";

/**
 * The Reference screen: how each detector and action works, a click away from wherever
 * one is named.
 *
 * The rest of the page says *that* `cadence` fired or *that* a request was `challenge`d,
 * and until now what that meant lived in a repository somebody had to go and find, while
 * the verdict they were trying to judge sat on the screen in front of them. Every name
 * the page shows is a link here now, and the text is the documentation's own, generated
 * at build time — see `reference-model.ts` for why it arrives as data rather than markup.
 */

const BY_KEY = new Map<string, ReferenceEntry>(REFERENCE.entries.map((entry) => [referenceKey(entry.kind, entry.id), entry]));

/** `detector:cadence`, or `""` for the overview. */
let selected = "";
/** What the article and index were last drawn for, so an unchanged screen is not rebuilt every frame. */
let drawnArticle = "";
let drawnIndex = "";

export function selectedReference(): string {
  return selected;
}

/**
 * Sets the selection from a URL.
 *
 * Checked for shape rather than against the entries, because a link to a detector that is
 * the handler's own arrives before the snapshot that says it exists. One that turns out to
 * name nothing is drawn as the overview.
 */
export function setSelectedReference(value: string): void {
  selected = /^(?:detector|action):[\w.:-]{1,120}$/.test(value) ? value : "";
}

function installedDetector(key: string): { id: string; description: string; cost: string; stage: string; shadow?: true | undefined } | undefined {
  if (!key.startsWith("detector:")) return undefined;
  const id = key.slice("detector:".length);
  return state.snapshot?.detectors.find((detector) => detector.id === id);
}

/** Whether a name can be opened here: documented, or a detector this handler has installed. */
export function hasReference(kind: ReferenceKind, id: string): boolean {
  const key = referenceKey(kind, id);
  return SECTIONS.reference && (BY_KEY.has(key) || installedDetector(key) !== undefined);
}

/** Switches to the Reference screen with an entry open. */
export function openReference(kind: ReferenceKind, id: string): void {
  selected = referenceKey(kind, id);
  app.showTab("reference", { replace: false });
  const article = rootNode().querySelector<HTMLElement>("#ref-article");
  article?.scrollIntoView({ block: "start" });
  rootNode().querySelector<HTMLElement>("#ref-title")?.focus({ preventScroll: true });
}

/**
 * A name, as a link to its entry when there is one and as plain text when there is not.
 *
 * A button rather than an anchor: it changes what this page shows, and embedded it must
 * not touch the host page's URL. The click stops where it lands, because several of these
 * sit inside rows that open and close on a click of their own.
 */
export function referenceLink(kind: ReferenceKind, id: string, text: string = id, className = "ref-link"): HTMLElement {
  if (!hasReference(kind, id)) return el("span", className === "ref-link" ? null : className, text);
  const link = el("button", className, text);
  link.type = "button";
  link.title = `How ${kind === "detector" ? "the detector" : "the action"} “${id}” works`;
  link.addEventListener("click", (event) => {
    event.stopPropagation();
    openReference(kind, id);
  });
  return link;
}

// ---- rendering ------------------------------------------------------------------

function inlines(target: HTMLElement, runs: readonly Inline[], current: string): void {
  for (const [kind, text] of runs) {
    if (kind === "t") {
      target.appendChild(document.createTextNode(text));
      continue;
    }
    if (kind === "code") {
      // A name the reference knows becomes a way to it, which is most of what makes the
      // write-ups navigable: they refer to each other constantly.
      const linked = (["detector", "action"] as const).find((candidate) => referenceKey(candidate, text) !== current && BY_KEY.has(referenceKey(candidate, text)));
      const code = el("code", null, text);
      if (linked === undefined) target.appendChild(code);
      else {
        const link = referenceLink(linked, text, "", "ref-link");
        link.appendChild(code);
        target.appendChild(link);
      }
      continue;
    }
    target.appendChild(el(kind === "b" ? "strong" : "em", null, text));
  }
}

function drawBlocks(target: HTMLElement, blocks: readonly Block[], current: string): void {
  for (const block of blocks) {
    if (block.kind === "p" || block.kind === "h") {
      const node = el(block.kind === "p" ? "p" : "h3");
      inlines(node, block.text, current);
      target.appendChild(node);
    } else if (block.kind === "list") {
      const list = el("ul");
      for (const item of block.items) {
        const li = el("li");
        inlines(li, item, current);
        list.appendChild(li);
      }
      target.appendChild(list);
    } else if (block.kind === "code") {
      const pre = el("pre");
      pre.appendChild(el("code", null, block.code));
      // Scrolls sideways on a narrow screen, so it has to be reachable without a mouse.
      pre.tabIndex = 0;
      target.appendChild(pre);
    } else {
      const wrap = el("div", "ref-table");
      const table = el("table");
      const head = el("tr");
      for (const cell of block.head) {
        const th = el("th");
        inlines(th, cell, current);
        head.appendChild(th);
      }
      const thead = el("thead");
      thead.appendChild(head);
      table.appendChild(thead);
      const tbody = el("tbody");
      for (const row of block.rows) {
        const tr = el("tr");
        for (const cell of row) {
          const td = el("td");
          inlines(td, cell, current);
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      wrap.appendChild(table);
      target.appendChild(wrap);
    }
  }
}

interface IndexItem {
  key: string;
  kind: ReferenceKind;
  id: string;
  summary: string;
}

/** The index's groups, with a handler's own detectors added where the documentation has nothing to say about them. */
function groups(): Array<[title: string, items: IndexItem[]]> {
  const out = new Map<string, IndexItem[]>();
  const add = (title: string, item: IndexItem): void => {
    const list = out.get(title) ?? [];
    list.push(item);
    out.set(title, list);
  };
  for (const entry of REFERENCE.entries) {
    add(`${entry.kind === "detector" ? "Detectors" : "Actions"} · ${entry.group}`, { key: referenceKey(entry.kind, entry.id), kind: entry.kind, id: entry.id, summary: entry.summary });
  }
  for (const detector of state.snapshot?.detectors ?? []) {
    const key = referenceKey("detector", detector.id);
    if (!BY_KEY.has(key)) add("Detectors · Installed here, not part of the library", { key, kind: "detector", id: detector.id, summary: detector.description });
  }
  // Detectors first, then actions, keeping the documentation's order inside each.
  return [...out.entries()].sort(([a], [b]) => Number(a.startsWith("Actions")) - Number(b.startsWith("Actions")));
}

function drawIndex(installed: ReadonlySet<string>): void {
  const index = $("ref-index");
  clear(index);
  let count = 0;
  for (const [title, items] of groups()) {
    const group = el("div", "ref-group");
    group.appendChild(el("h3", null, title));
    const list = el("ul");
    for (const item of items) {
      const li = el("li");
      li.dataset["filter"] = `${item.kind} ${item.id} ${item.summary}`.toLowerCase();
      const button = el("button", "ref-item");
      button.type = "button";
      button.dataset["key"] = item.key;
      button.title = item.summary;
      if (item.key === selected) button.setAttribute("aria-current", "true");
      button.appendChild(el("span", "ref-id", item.id));
      if (item.kind === "detector" && installed.has(item.id)) button.appendChild(el("span", "ref-tag", "installed"));
      button.addEventListener("click", () => openReference(item.kind, item.id));
      li.appendChild(button);
      list.appendChild(li);
      count++;
    }
    group.appendChild(list);
    index.appendChild(group);
  }
  $("ref-count").textContent = `${count} entries`;
  applyFilter();
}

function applyFilter(): void {
  const query = (rootNode().querySelector<HTMLInputElement>("#ref-filter")?.value ?? "").trim().toLowerCase();
  let shown = 0;
  for (const group of Array.from($("ref-index").querySelectorAll<HTMLElement>(".ref-group"))) {
    let visible = 0;
    for (const item of Array.from(group.querySelectorAll<HTMLElement>("li"))) {
      const match = query === "" || (item.dataset["filter"] ?? "").includes(query);
      item.hidden = !match;
      if (match) visible++;
    }
    group.hidden = visible === 0;
    shown += visible;
  }
  $("ref-empty").hidden = shown > 0;
}

function fact(text: string, className = "ref-fact"): HTMLElement {
  return el("span", className, text);
}

function drawArticle(installed: ReadonlySet<string>): void {
  const article = $("ref-article");
  clear(article);
  const header = el("header");
  const body = el("div", "ref-body");
  const entry = BY_KEY.get(selected);
  const own = entry === undefined ? installedDetector(selected) : undefined;

  if (entry === undefined && own === undefined) {
    header.appendChild(el("div", "ref-kicker", "Reference"));
    const title = el("h2", null, "How detectors and actions work");
    title.id = "ref-title";
    title.tabIndex = -1;
    header.appendChild(title);
    header.appendChild(el("p", "ref-lede", "Pick one from the list, or click a detector or an action anywhere else on this dashboard to land on its entry."));
    article.appendChild(header);
    body.appendChild(el("h3", null, "Detectors"));
    drawBlocks(body, REFERENCE.intro.detector, "");
    body.appendChild(el("h3", null, "Actions"));
    drawBlocks(body, REFERENCE.intro.action, "");
    article.appendChild(body);
    return;
  }

  const kind = entry?.kind ?? "detector";
  const id = entry?.id ?? own?.id ?? "";
  header.appendChild(el("div", "ref-kicker", `${kind === "detector" ? "Detector" : "Action"}${entry === undefined ? "" : ` · ${entry.group}`}`));
  const title = el("h2", "mono", id);
  title.id = "ref-title";
  title.tabIndex = -1;
  header.appendChild(title);
  const facts = el("div", "ref-facts");
  for (const text of entry?.facts ?? []) facts.appendChild(fact(text));
  if (own !== undefined) {
    facts.appendChild(fact(own.cost));
    facts.appendChild(fact(own.stage));
  }
  // Said only once the handler has told us what it runs: before the snapshot arrives,
  // "not installed" would be a guess stated as a fact.
  if (kind === "detector" && state.snapshot !== undefined) {
    const on = installed.has(id);
    const shadowed = state.snapshot.detectors.find((detector) => detector.id === id)?.shadow === true;
    facts.appendChild(fact(on ? (shadowed ? "installed · shadowed" : "installed here") : "not installed here", `ref-fact ${on ? "on" : "off"}`));
  }
  header.appendChild(facts);
  article.appendChild(header);

  if (entry !== undefined) {
    drawBlocks(body, entry.blocks, selected);
    article.appendChild(body);
    article.appendChild(el("p", "ref-source", `From ${entry.source}, which ships with the library.`));
  } else if (own !== undefined) {
    body.appendChild(el("p", null, own.description));
    body.appendChild(el("p", "ref-source", "This detector is not one of the library's, so there is no write-up for it here. The line above is what it says about itself."));
    article.appendChild(body);
  }
}

export function initReference(): void {
  if (!SECTIONS.reference) return;
  rootNode().querySelector<HTMLInputElement>("#ref-filter")?.addEventListener("input", applyFilter);
}

export function drawReference(): void {
  if (!SECTIONS.reference) return;
  const detectors = state.snapshot?.detectors ?? [];
  const installed = new Set(detectors.map((detector) => detector.id));
  const signature = `${state.snapshot === undefined ? "?" : ""}${detectors.map((detector) => `${detector.id}${detector.shadow === true ? "~" : ""}`).join(",")}`;

  const indexKey = `${signature}|${selected}`;
  if (indexKey !== drawnIndex) {
    drawnIndex = indexKey;
    // Only the selection moved: marked in place, so the list keeps its scroll position.
    const previous = $("ref-index").querySelector("[aria-current]");
    if (previous !== null && drawnArticle.startsWith(`${signature}|`)) {
      previous.removeAttribute("aria-current");
      for (const button of Array.from($("ref-index").querySelectorAll<HTMLElement>(".ref-item"))) {
        if (button.dataset["key"] === selected) button.setAttribute("aria-current", "true");
      }
    } else drawIndex(installed);
  }
  const articleKey = `${signature}|${selected}`;
  if (articleKey !== drawnArticle) {
    drawnArticle = articleKey;
    drawArticle(installed);
  }
}
