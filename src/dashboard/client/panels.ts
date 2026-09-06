import { $, clear, el, rootNode } from "./dom.js";
import { BOOT, SECTIONS } from "./boot.js";
import { aggregate, oldestAt, state } from "./store.js";
import { drawBars, pairs } from "./bars.js";
import { clockTime, ms, n, pct, rangeLabel, uptime, windowLabel } from "./format.js";
import type { Aggregates } from "./store.js";

/**
 * The counter tiles.
 *
 * Redrawn only when the snapshot behind them changes, which is every two seconds
 * rather than every frame. They sit above the tab strip, so they are the one part of
 * the page that is on screen whichever view is showing, and they were being rebuilt on
 * every incoming request for numbers that could not have moved.
 */
let paintedSnapshot: unknown;

export function drawTiles(force = false): void {
  // The tiles are the statistics section's, and `applySections` removes the node when
  // that section is off — so this has to check before it looks.
  if (!SECTIONS.statistics) return;
  const box = $("tiles");
  const snapshot = state.snapshot;
  if (snapshot === undefined) return;
  if (!force && paintedSnapshot === snapshot) return;
  paintedSnapshot = snapshot;

  const metrics = snapshot.metrics;
  clear(box);
  if (metrics === undefined) {
    box.appendChild(el("div", "note", "Counters are switched off on this handler (metrics: false). The live feed still works."));
    return;
  }

  const actions = metrics.actions;
  const denied = actions.block + actions.drop + actions.redirect;
  const mitigated = actions.challenge + actions["rate-limit"] + actions.delay;
  const served = actions.allow + actions.tag + actions.log;
  const total = metrics.requests;
  const unremarkable = metrics.verdicts.unknown + metrics.verdicts.human;

  const tiles: Array<[string, string, string, string]> = [
    ["", n(total), "Requests", "since start"],
    ["proven", n(metrics.proven), "Proven bots", `${pct(metrics.proven, total)} of traffic`],
    ["warn", n(metrics.verdicts["suspected-bot"]), "Suspected", "never denied on this alone"],
    ["", n(unremarkable), "Unremarkable", `${pct(unremarkable, total)} of traffic`],
    ["warn", n(metrics.downgrades), "Guard stops", metrics.downgrades > 0 ? "rules asking for more than the evidence" : "no rule overreached"],
    ["crit", n(denied), "Denied", `${pct(denied, total)} of traffic`],
    [
      "",
      n(mitigated),
      "Mitigated",
      metrics.challenges.issued > 0 ? `${n(metrics.challenges.solved)} of ${n(metrics.challenges.issued)} challenges solved` : "challenged, limited or delayed",
    ],
    ["good", n(served), "Served", `${pct(served, total)} of traffic`],
    ["", n(metrics.actorsTracked), "Actors tracked", "in the registry now"],
  ];
  for (const [kind, value, key, sub] of tiles) {
    const tile = el("div", `tile ${kind}`);
    tile.appendChild(el("div", "v tnum", value));
    tile.appendChild(el("div", "k", key));
    tile.appendChild(el("div", "s", sub));
    box.appendChild(tile);
  }
}

/**
 * The configuration facts at the end of the tab strip.
 *
 * Label first, value second, every time — "suspect at 60", not "60 suspect at" — and
 * as plain text, which is the one treatment nothing else on the page uses for a
 * control.
 */
export function drawChips(): void {
  const snapshot = state.snapshot;
  if (snapshot === undefined) return;
  const box = $("chips");
  clear(box);
  const facts: Array<[string, string]> = [
    // Which process this is, first, because everything after it is a fact about this
    // process and nothing else. Behind a load balancer there are as many of these
    // dashboards as there are pods, each showing its own share of the traffic.
    ["instance", snapshot.instance],
    ["guard", snapshot.policy.falsePositivePolicy],
    ["suspect at", String(snapshot.policy.suspectThreshold)],
  ];
  if (SECTIONS.statistics) facts.push(["detectors", String(snapshot.detectors.length)]);
  if (SECTIONS.policy) facts.push(["rules", String(snapshot.rules.length)]);
  facts.push(["uptime", uptime(snapshot.now - snapshot.startedAt)]);

  for (const [label, value] of facts) {
    const fact = el("span");
    fact.appendChild(document.createTextNode(`${label} `));
    fact.appendChild(el("b", null, value));
    box.appendChild(fact);
  }
}

/**
 * Every panel that counts the retained ring says how much ring there is.
 *
 * Half the Statistics screen counts the window and half counts since the process
 * started; they were wearing the same grey subtitle, which invited exactly the
 * comparison that does not hold.
 */
export function updateWindowLabels(): void {
  const label = windowLabel(state.rows.length, oldestAt(), Date.now());
  for (const node of Array.from(rootNode().querySelectorAll<HTMLElement>(".win"))) node.textContent = label;
}

export function drawLivePanels(): void {
  if (!SECTIONS.statistics) return;
  const totals = aggregate(state.rows);
  drawBars($("live-detectors"), totals.detectors, "Nothing has fired in this window.");
  if (SECTIONS.actors) drawBars($("live-actors"), totals.actors, "No traffic in this window.");
}

export function drawStatsPanels(): void {
  const snapshot = state.snapshot;
  if (snapshot === undefined) return;
  const metrics = snapshot.metrics;

  if (metrics !== undefined) {
    drawBars($("stat-verdicts"), pairs(metrics.verdicts), "Nothing assessed yet.");
    drawBars($("stat-actions"), pairs(metrics.actions), "No decisions yet.");
    drawBars($("stat-classes"), pairs(metrics.botClasses), "Nothing classified yet.");
    drawBars($("stat-detectors"), pairs(metrics.detectorFirings), "No detector has produced evidence yet.");

    const challenges = $("stat-challenges");
    clear(challenges);
    if (!snapshot.policy.challengeEnabled) {
      challenges.appendChild(el("div", "note", "No challenge is configured, so a rule asking for one degrades to a tag. Set challenge.secrets to enable it."));
    } else {
      const funnel: Array<[string, string]> = [
        ["Issued", n(metrics.challenges.issued)],
        ["Solved", n(metrics.challenges.solved)],
        ["Rejected", n(metrics.challenges.rejected)],
        ["Solve rate", metrics.challenges.issued > 0 ? pct(metrics.challenges.solved, metrics.challenges.issued) : "—"],
      ];
      for (const [key, value] of funnel) challenges.appendChild(statRow(key, value));
    }

    const health = $("stat-health");
    clear(health);
    const bypassed = metrics.bypassed.allowlist + metrics.bypassed["ignored-path"];
    const rows: Array<[string, string]> = [
      ["Requests assessed", n(metrics.requests)],
      ["Bypassed — allowlist", n(metrics.bypassed.allowlist)],
      ["Bypassed — ignored path", n(metrics.bypassed["ignored-path"])],
      ["Detection ran on", pct(metrics.requests - bypassed, metrics.requests)],
      ["Actors tracked", n(metrics.actorsTracked)],
      ["Guard stops", n(metrics.downgrades)],
    ];
    const failures = pairs(metrics.detectorFailures);
    for (const [detector, count] of failures) rows.push([`Detector failures — ${detector}`, n(count)]);
    for (const [key, value] of rows) health.appendChild(statRow(key, value));
    if (failures.length === 0) health.appendChild(el("div", "note", "No detector has thrown or timed out."));
  }

  const totals = aggregate(state.rows);
  if (SECTIONS.actors) drawBars($("stat-identities"), totals.identities, "No client has named itself in this window.");
  drawBars($("stat-paths"), totals.paths, "No traffic in this window.");
  drawBars($("stat-denied-paths"), totals.deniedPaths, "Nothing has been denied in this window.");
  drawBars($("stat-guard"), totals.guardStops, "No rule has asked for more than its evidence supports.");
  drawBars($("stat-bypassed"), totals.bypassed, "Nothing bypassed detection.");
  drawRuleHits(totals);

  const list = $("stat-detector-list");
  clear(list);
  $("detector-count").textContent = `${snapshot.detectors.length} installed`;
  for (const detector of snapshot.detectors) {
    const row = el("div", "det");
    const left = el("div");
    left.appendChild(el("div", "mono", detector.id));
    left.appendChild(el("div", "d", detector.description));
    row.appendChild(left);
    const fires = metrics?.detectorFirings[detector.id] ?? 0;
    const timing = metrics?.detectorTimings[detector.id];
    let right = `${n(fires)} · ${detector.cost} · ${detector.stage}`;
    // Only when the operator asked for timing; the field is empty otherwise.
    if (timing !== undefined && timing.count > 0) right += ` · ${ms(timing.totalMs / timing.count)} avg`;
    row.appendChild(el("div", "n", right));
    list.appendChild(row);
  }
}

function statRow(key: string, value: string): HTMLElement {
  const line = el("div", "stat-row");
  line.appendChild(el("span", "k", key));
  line.appendChild(el("span", "v", value));
  return line;
}

/**
 * Rule hit counts, including the rules that never fire.
 *
 * The zeros are the point. A rule that has matched nothing is either dead
 * configuration or a rule sitting behind a broader one that swallows its traffic, and
 * both are invisible in a chart that only draws what happened.
 */
function drawRuleHits(totals: Aggregates): void {
  const target = $("stat-rule-hits");
  clear(target);
  const rules = state.snapshot?.rules ?? [];
  if (rules.length === 0) {
    target.appendChild(el("div", "note", "No rules configured."));
    return;
  }

  let max = 1;
  for (const rule of rules) max = Math.max(max, totals.ruleHits.get(rule) ?? 0);
  for (const rule of rules) {
    const value = totals.ruleHits.get(rule) ?? 0;
    const bar = el("div", `bar${value === 0 ? " dead" : ""}`);
    const track = el("div", "track");
    if (value > 0) {
      const fill = el("div", "fill");
      fill.style.width = `${Math.max(2, Math.round((value / max) * 100))}%`;
      track.appendChild(fill);
    }
    track.appendChild(el("div", "lbl", rule));
    bar.appendChild(track);
    bar.appendChild(el("div", "v tnum", value === 0 ? "never" : n(value)));
    target.appendChild(bar);
  }
}

/**
 * The audit panel: the window against its baseline.
 *
 * Both, side by side, because that is the only way the audit's output means anything.
 * A bot share of 60% is a number; a bot share of 60% against a baseline of 12% is an
 * incident.
 */
export function drawAudit(): void {
  const snapshot = state.snapshot;
  if (snapshot === undefined) return;
  const body = $("audit-body");
  const checks = $("audit-checks");
  clear(body);
  clear(checks);

  const audit = snapshot.audit;
  if (audit === undefined) {
    $("audit-spans").textContent = "";
    body.appendChild(
      el(
        "div",
        "note",
        "The traffic audit is switched off on this handler (audit: false). It watches the shape of your traffic rather than any one request — a spike in automation, a collapse in human traffic, a policy suddenly denying far more than usual.",
      ),
    );
    return;
  }

  const current = audit.window;
  const baseline = audit.baseline;
  $("audit-spans").textContent = `last ${rangeLabel(current.spanMs)} against the ${rangeLabel(baseline.spanMs)} before`;

  // A share is only legible next to the one it is being compared with, so every row
  // carries both. The delta is left to the reader: an arrow implying "worse" would be
  // the dashboard editorialising about traffic it cannot see the purpose of.
  const rows: Array<[string, string, string]> = [
    ["Requests", n(current.requests), n(baseline.requests)],
    ["Rate", `${current.rate.toFixed(1)}/min`, `${baseline.rate.toFixed(1)}/min`],
    ["Bot share", `${Math.round(current.botShare * 100)}%`, `${Math.round(baseline.botShare * 100)}%`],
    ["Bots", n(current.bots), n(baseline.bots)],
    ["Humans", n(current.humans), n(baseline.humans)],
    ["Denials", n(current.denials), n(baseline.denials)],
    ["Challenges", n(current.challenges), n(baseline.challenges)],
    ["Guard stops", n(current.downgrades), n(baseline.downgrades)],
    ["Detector failures", n(current.failures), n(baseline.failures)],
    ["Bypassed", n(current.bypassed), n(baseline.bypassed)],
  ];
  for (const [key, now, was] of rows) {
    const line = el("div", "stat-row");
    line.appendChild(el("span", "k", key));
    const values = el("span", "v");
    values.appendChild(el("b", null, now));
    values.appendChild(el("span", "was", ` was ${was}`));
    line.appendChild(values);
    body.appendChild(line);
  }

  if (audit.checks.length === 0) {
    checks.appendChild(el("div", "note", "No checks are installed, so nothing here will ever raise an anomaly."));
    return;
  }
  for (const check of audit.checks) {
    const row = el("div", "det");
    const left = el("div");
    left.appendChild(el("div", "mono", check.id));
    left.appendChild(el("div", "d", check.description));
    row.appendChild(left);
    checks.appendChild(row);
  }
}

/** The count on the Policy tab. Cheap, so it runs on every frame; the panel itself does not. */
export function drawNoticeBadge(): void {
  const notices = state.snapshot?.notices ?? [];
  const badge = $("notice-badge");
  badge.hidden = notices.length === 0 || !SECTIONS.notices;
  badge.textContent = String(notices.length);
}

export function drawNotices(): void {
  const box = $("stat-notices");
  const notices = state.snapshot?.notices ?? [];
  clear(box);
  $("notice-count").textContent = notices.length > 0 ? `${notices.length} total` : "";
  if (notices.length === 0) {
    box.appendChild(el("div", "note", "Nothing to report: no startup warnings, no detector errors."));
    return;
  }
  for (const notice of notices.slice().reverse().slice(0, 40)) {
    const row = el("div", `notice ${notice.kind}`);
    const when = el("div", "when");
    when.appendChild(el("div", "tag", notice.kind));
    when.appendChild(el("div", null, clockTime(notice.at)));
    row.appendChild(when);
    const body = el("div");
    body.appendChild(el("div", null, notice.message));
    if (notice.source !== undefined) body.appendChild(el("div", "ev-meta", notice.source));
    row.appendChild(body);
    box.appendChild(row);
  }
}

/**
 * What somebody did to this process, and when.
 *
 * The same list the traffic timeline marks, written out — because a marker answers
 * "was there a change here?" and a person auditing wants "what were they, in order".
 * Bounded and in memory, which the panel says: the durable copy is the change events.
 */
export function drawChanges(): void {
  if (!SECTIONS.changes) return;
  const box = $("stat-changes");
  const changes = state.snapshot?.changes ?? [];
  clear(box);
  $("change-count").textContent = changes.length > 0 ? `${changes.length} this run` : "";

  if (changes.length === 0) {
    box.appendChild(el("div", "note", "Nothing has been changed at runtime. Rules, guard and ranges are as the code that built this handler left them."));
    return;
  }

  for (const change of changes.slice().reverse()) {
    const row = el("div", "notice");
    const when = el("div", "when");
    when.appendChild(el("div", "tag", change.kind));
    when.appendChild(el("div", null, clockTime(change.at)));
    row.appendChild(when);
    const body = el("div");
    body.appendChild(el("div", null, change.summary));
    // "by nobody in particular" is a fact about the dashboard's `auth`, not a gap to
    // hide: a bearer token is a credential and not an identity.
    body.appendChild(el("div", "ev-meta", change.by === undefined || change.by === "" ? "by an unnamed viewer — this listener's auth carries no identity" : `by ${change.by}`));
    row.appendChild(body);
    box.appendChild(row);
  }
}

/** Sibling instances, when the operator listed any. */
export function drawPeers(): void {
  const box = $("peers");
  if (BOOT.peers.length === 0) {
    box.hidden = true;
    return;
  }
  if (box.childElementCount > 0) return;
  box.appendChild(el("span", "hint", "also:"));
  for (const peer of BOOT.peers) {
    const link = el("a", "linkbtn", peer.label);
    link.href = peer.href;
    link.rel = "noreferrer noopener";
    box.appendChild(link);
  }
}
