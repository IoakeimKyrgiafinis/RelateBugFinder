import * as vscode from "vscode";
import { randomBytes } from "crypto";
import type { BlastResult, TraceResult } from "./core/types";

export type PanelMsg =
  | { type: "open"; file: string; line: number; lines?: number[] }
  | { type: "trace"; text: string }
  | { type: "blast"; target: string }
  | { type: "askAi"; prompt: string }
  | { type: "deepTrace" }
  | { type: "compareTests" }
  | { type: "ready" };

export interface DeepInfo {
  functions: number;
  seconds: number;
  exitCode: number | null;
  /** True when the command is a pytest/unittest run, so related passing tests can be run the same way. */
  canCompare?: boolean;
  /** Set after "Compare with related passing tests". */
  spectrum?: { tests: number; passed: number; seconds: number };
}

export type PanelState =
  | { mode: "welcome"; stats?: Record<string, unknown>; clipboard?: string }
  | { mode: "trace"; result: TraceResult; input: string; command?: string; deep?: DeepInfo }
  | { mode: "blast"; result: BlastResult }
  | { mode: "error"; message: string };

/** One reusable side panel that renders traces and blast radii. */
export class BlastPanel {
  private static current: BlastPanel | undefined;
  private state: PanelState = { mode: "welcome" };
  private ready = false;

  static show(extUri: vscode.Uri, onMsg: (m: PanelMsg) => void, state?: PanelState): BlastPanel {
    if (!BlastPanel.current) BlastPanel.current = new BlastPanel(extUri, onMsg);
    else BlastPanel.current.panel.reveal(vscode.ViewColumn.Beside, true);
    if (state) BlastPanel.current.update(state);
    return BlastPanel.current;
  }

  private constructor(extUri: vscode.Uri, onMsg: (m: PanelMsg) => void, private panel = vscode.window.createWebviewPanel(
    "blastRadius", "Blast Radius", { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
    { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [extUri] }
  )) {
    panel.iconPath = vscode.Uri.joinPath(extUri, "media", "icon.svg");
    panel.webview.html = html(randomBytes(16).toString("base64"));
    panel.webview.onDidReceiveMessage((m: PanelMsg) => {
      if (m.type === "ready") {
        this.ready = true;
        this.post();
      } else onMsg(m);
    });
    panel.onDidDispose(() => (BlastPanel.current = undefined));
  }

  update(state: PanelState) {
    this.state = state;
    this.panel.title = state.mode === "trace" ? "Blast Radius · Error trace" : state.mode === "blast" ? `Blast Radius · ${state.result.target.name}` : "Blast Radius";
    this.post();
  }

  private post() {
    if (this.ready) void this.panel.webview.postMessage(JSON.parse(JSON.stringify(this.state, (_k, v) => (typeof v === "bigint" ? Number(v) : v))));
  }
}

function html(nonce: string): string {
  return /* html */ `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  :root { --hot: var(--vscode-charts-red); --warm: var(--vscode-charts-orange); --cool: var(--vscode-charts-blue); --muted: var(--vscode-descriptionForeground); }
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 0 16px 24px; line-height: 1.45; }
  h1 { font-size: 1.25em; margin: 16px 0 4px; } h2 { font-size: 1em; margin: 22px 0 8px; color: var(--muted); text-transform: uppercase; letter-spacing: .06em; }
  .err { font-family: var(--vscode-editor-font-family); background: var(--vscode-inputValidation-errorBackground); border: 1px solid var(--vscode-inputValidation-errorBorder); padding: 8px 10px; border-radius: 4px; white-space: pre-wrap; }
  .muted { color: var(--muted); } code, .mono { font-family: var(--vscode-editor-font-family); font-size: .95em; }
  a { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: none; } a:hover { text-decoration: underline; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 0; padding: 5px 12px; border-radius: 3px; cursor: pointer; font: inherit; }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button:hover { filter: brightness(1.1); }
  textarea { width: 100%; box-sizing: border-box; min-height: 150px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); font-family: var(--vscode-editor-font-family); padding: 8px; }
  .card { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 10px 12px; margin: 8px 0; display: grid; grid-template-columns: 44px 1fr auto; gap: 4px 12px; align-items: start; }
  .card.top { border-color: var(--hot); box-shadow: 0 0 0 1px var(--hot) inset; }
  .rank { font-size: 1.4em; font-weight: 600; color: var(--muted); text-align: center; }
  .name { font-weight: 600; } .loc { color: var(--muted); }
  .chips { display: flex; gap: 6px; flex-wrap: wrap; margin: 2px 0; }
  .chip { font-size: .8em; padding: 1px 7px; border-radius: 10px; border: 1px solid var(--vscode-panel-border); color: var(--muted); }
  .chip.crash-site { border-color: var(--hot); color: var(--hot); } .chip.downstream { border-color: var(--warm); color: var(--warm); } .chip.ran { border-color: var(--warm); color: var(--warm); }
  .origin { border-left: 3px solid var(--hot); background: var(--vscode-textBlockQuote-background); padding: 8px 12px; margin: 10px 0; border-radius: 0 4px 4px 0; }
  .origin b { color: var(--hot); } .origin code { font-family: var(--vscode-editor-font-family); }
  .chip.value-origin { background: var(--warm); color: var(--vscode-editor-background); border-color: var(--warm); }
  .chip.uncommitted { background: var(--hot); color: var(--vscode-editor-background); border-color: var(--hot); }
  ul.reasons { margin: 4px 0 0 0; padding-left: 18px; } ul.reasons li { margin: 1px 0; }
  .lines { margin-top: 4px; font-size: 0.92em; } .lines .chip { margin-right: 4px; }
  .score { text-align: right; min-width: 70px; } .bar { height: 5px; border-radius: 3px; background: var(--vscode-panel-border); margin-top: 4px; overflow: hidden; } .bar > i { display: block; height: 100%; background: var(--hot); }
  .actions { grid-column: 2 / 4; display: flex; gap: 8px; margin-top: 4px; }
  .actions a { font-size: .9em; }
  svg text { fill: var(--vscode-foreground); font-family: var(--vscode-editor-font-family); font-size: 11px; }
  svg .node rect { fill: var(--vscode-editor-background); stroke: var(--vscode-panel-border); stroke-width: 1.2; rx: 5; cursor: pointer; }
  svg .node:hover rect { stroke: var(--vscode-focusBorder); }
  svg .edge { stroke: var(--muted); stroke-width: 1.2; fill: none; opacity: .7; }
  table { border-collapse: collapse; width: 100%; } td { padding: 3px 8px 3px 0; vertical-align: top; }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .graphbox { overflow-x: auto; border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 6px; }
</style></head><body><div id="app"><p class="muted">Loading…</p></div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const app = document.getElementById("app");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const open = (file, line, lines) => vscode.postMessage({ type: "open", file, line, lines });

/** Lines to highlight for a suspect after a deep trace: those that ran only in the failure, else those that ran. */
function hlLines(s) { return s.lines ? (s.lines.failingOnly && s.lines.failingOnly.length ? s.lines.failingOnly : s.lines.ran) : null; }

/** "13–16, 19" from [13,14,15,16,19], each range a link that opens the file there with the lines highlighted. */
function linesHtml(s) {
  const L = hlLines(s);
  if (!L || !L.length) return "";
  const only = !!(s.lines.failingOnly && s.lines.failingOnly.length);
  const runs = [];
  for (const n of L) { const r = runs[runs.length - 1]; if (r && n === r[1] + 1) r[1] = n; else runs.push([n, n]); }
  const hl = esc(JSON.stringify(L));
  const links = runs.map((r) => '<a data-f="' + esc(s.file) + '" data-l="' + r[0] + '" data-hl="' + hl + '">' + (r[0] === r[1] ? r[0] : r[0] + "–" + r[1]) + "</a>").join(", ");
  return '<div class="lines muted">' + (only ? '<span class="chip ran">ran only in the failing test</span> lines ' : "Lines that ran in the failing test: ") + links + "</div>";
}
const shortName = (id) => id.split("#")[1] || id;
let last;

window.addEventListener("message", (e) => { last = e.data; render(e.data); });
vscode.postMessage({ type: "ready" });

function render(s) {
  if (s.mode === "trace") return renderTrace(s.result, s.input, s);
  if (s.mode === "blast") return renderBlast(s.result);
  if (s.mode === "error") { app.innerHTML = '<h1>Blast Radius</h1><div class="err">' + esc(s.message) + "</div>" + pasteBox(""); return bindPaste(); }
  app.innerHTML = '<h1>Blast Radius</h1><p class="muted">Paste an error or stack trace (Node, browser, Python, pytest, tsc). Failed commands in the integrated terminal are traced automatically.</p>' +
    pasteBox(s.clipboard || "") + (s.stats ? '<h2>Graph</h2><p class="mono">' + Object.entries(s.stats).map(([k, v]) => esc(k) + ": " + esc(v)).join(" · ") + "</p>" : "");
  bindPaste();
}
function pasteBox(v) { return '<textarea id="t" placeholder="TypeError: … at fn (src/file.ts:12:3)">' + esc(v) + '</textarea><div class="row" style="margin-top:8px"><button id="go">Find suspects</button></div>'; }
function bindPaste() { const b = document.getElementById("go"); if (b) b.onclick = () => vscode.postMessage({ type: "trace", text: document.getElementById("t").value }); }

function renderTrace(r, input, s) {
  let h = "<h1>Most likely root causes</h1>";
  if (r.note) h += '<div class="err">' + esc(r.note) + "</div>";
  if (!r.suspects.length) { app.innerHTML = h + '<p>No suspects: ' + esc(r.note || "no frames matched this workspace") + "</p>" + pasteBox(input); return bindPaste(); }
  if (r.crashSite) h += '<p class="muted">Thrown in <a data-f="' + esc(r.crashSite.file) + '" data-l="' + r.crashSite.line + '">' + esc(r.crashSite.file) + ":" + r.crashSite.line + "</a> · ranked by recency × graph distance</p>";
  if (s && s.deep) h += '<div class="origin"><b>Deep trace</b><br>Re-ran <code>' + esc(s.command || "") + '</code> with recording (' + s.deep.seconds + ' s): ' + s.deep.functions + ' of your functions ran. Suspects that ran, especially just before the crash, now rank higher.' +
    (s.deep.spectrum ? '<br><b>Compared with ' + s.deep.spectrum.tests + ' related passing test' + (s.deep.spectrum.tests === 1 ? "" : "s") + '</b> (' + s.deep.spectrum.passed + ' passed, ' + s.deep.spectrum.seconds + ' s): functions that also run in passing tests now rank lower (Ochiai spectrum score).'
      : s.deep.canCompare ? '<div class="row" style="margin-top:6px"><button class="secondary" id="sbfl" title="Finds passing tests that exercise the same code (from the call graph), runs them with the recorder, and compares">Compare with related passing tests</button></div>' : "") + '</div>';
  else if (s && s.command) h += '<div class="row" style="margin:8px 0"><button class="secondary" id="deep" title="Runs the command again with a recorder attached, to see which functions actually ran before the crash">Deep trace: re-run <code>' + esc(s.command.length > 40 ? s.command.slice(0, 40) + "…" : s.command) + '</code> with recording</button></div>';
  if (r.valueOrigin) h += '<div class="origin"><b>Where the ' + esc(r.valueOrigin.value) + " came from</b><br>" + esc(r.valueOrigin.summary).replace(/\x60([^\x60]+)\x60/g, "<code>$1</code>") + "</div>";
  const max = Math.max(...r.suspects.map((s) => s.score), 1);
  r.suspects.forEach((s, i) => {
    const dirty = s.reasons.some((x) => x.kind === "uncommitted");
    h += '<div class="card' + (i === 0 ? " top" : "") + '"><div class="rank">' + (i + 1) + "</div><div>" +
      '<div class="name"><a data-f="' + esc(s.file) + '" data-l="' + s.startLine + '"' + (hlLines(s) ? ' data-hl="' + esc(JSON.stringify(hlLines(s))) + '"' : "") + '>' + esc(shortName(s.id)) + "</a></div>" +
      '<div class="loc mono">' + esc(s.file) + ":" + s.startLine + "</div>" +
      '<div class="chips"><span class="chip ' + s.relation + '">' + s.relation.replace("-", " ") + (s.hops ? " · " + s.hops + " hop" + (s.hops > 1 ? "s" : "") : "") + "</span>" + (dirty ? '<span class="chip uncommitted">uncommitted</span>' : "") + (s.reasons.some((x) => x.kind === "value-origin") ? '<span class="chip value-origin">source of the ' + esc(r.valueOrigin ? r.valueOrigin.value : "bad value") + "</span>" : "") + "</div>" +
      '<ul class="reasons">' + s.reasons.map((x) => "<li>" + esc(x.text).replace(/\x60([^\x60]+)\x60/g, "<code>$1</code>") + "</li>").join("") + "</ul>" + linesHtml(s) + "</div>" +
      '<div class="score"><b>' + s.score.toFixed(1) + '</b><div class="bar"><i style="width:' + (100 * s.score / max) + '%"></i></div></div>' +
      '<div class="actions"><a data-f="' + esc(s.file) + '" data-l="' + s.startLine + '">Open</a><a data-blast="' + esc(s.id) + '">Blast radius</a>' + (s.lastChange ? '<span class="muted mono">' + esc(s.lastChange.hash.slice(0, 7)) + "</span>" : "") + "</div></div>";
  });
  h += "<h2>Call chain</h2>" + graph(r.suspects.map((s) => ({ id: s.id, label: shortName(s.id), sub: s.file + ":" + s.startLine, file: s.file, line: s.startLine, heat: s.score / max })), r.edges);
  h += '<div class="row" style="margin-top:14px"><button id="ai">Ask AI to fix with this context</button><button class="secondary" id="again">Trace another error</button></div>';
  app.innerHTML = h;
  bindLinks();
  document.getElementById("again").onclick = () => render({ mode: "welcome", clipboard: "" });
  document.getElementById("ai").onclick = () => vscode.postMessage({ type: "askAi", prompt: aiPrompt(r) });
  const d = document.getElementById("deep");
  if (d) d.onclick = () => { d.disabled = true; d.textContent = "Re-running with recording…"; vscode.postMessage({ type: "deepTrace" }); };
  const sb = document.getElementById("sbfl");
  if (sb) sb.onclick = () => { sb.disabled = true; sb.textContent = "Running related passing tests…"; vscode.postMessage({ type: "compareTests" }); };
}

function aiPrompt(r) {
  const lines = ["I hit this error:", "", (r.note || "(see stack)"), ""];
  if (r.valueOrigin) lines.push("Where the bad value came from: " + r.valueOrigin.summary, "");
  lines.push( "The Blast-Radius code graph ranks these as the most likely root causes (recency of change × call-graph distance from the crash):");
  r.suspects.slice(0, 5).forEach((s, i) => lines.push((i + 1) + ". " + s.id + " (" + s.file + ":" + s.startLine + "-" + s.endLine + ", " + s.relation + ") — " + s.reasons.map((x) => x.text).join("; ")));
  lines.push("", "Read those functions first, explain the root cause, and propose a minimal fix. Use the blast-radius MCP tools (get_blast_radius) to check what else the fix could break.");
  return lines.join("\\n");
}

function renderBlast(r) {
  let h = "<h1>Blast radius: " + esc(r.target.name) + "</h1><p class='muted'>" + esc(r.summary) + "</p>";
  h += "<h2>Callers</h2>";
  if (!r.callers.length) h += "<p class='muted'>No callers found in the graph.</p>";
  else {
    const tid = r.target.id || r.target.file;
    const callerIds = new Set(r.callers.map((c) => c.id));
    // File targets: edges into any of the file's functions point at the single file node.
    const edges = r.edges.map((e) => (callerIds.has(e.to) || e.to === tid ? e : { from: e.from, to: tid }));
    const maxHops = Math.max(...r.callers.map((c) => c.hops));
    h += graph([{ id: tid, label: r.target.name, sub: r.target.file, file: r.target.file, line: 1, heat: 1, rank: maxHops }, ...r.callers.map((c) => ({ id: c.id, label: shortName(c.id), sub: c.file + ":" + c.startLine, file: c.file, line: c.startLine, heat: 1 / (1 + c.hops), rank: maxHops - c.hops }))], edges);
  }
  if (r.callers.length) h +=
    "<table>" + r.callers.map((c) => "<tr><td class='muted'>" + c.hops + " hop" + (c.hops > 1 ? "s" : "") + "</td><td><a data-f='" + esc(c.file) + "' data-l='" + c.startLine + "'>" + esc(shortName(c.id)) + "</a>" + (c.isTest ? " <span class='chip'>test</span>" : "") + "</td><td class='mono muted'>" + esc(c.file) + ":" + c.startLine + "</td></tr>").join("") + "</table>";
  h += "<h2>Tests to run</h2>" + (r.testsToRun.length ? r.testsToRun.map((t) => "<div><a data-f='" + esc(t) + "' data-l='1'>" + esc(t) + "</a></div>").join("") : "<p class='muted'>No test files reach this code. Consider adding one.</p>");
  h += "<h2>Importing files</h2>" + (r.importerFiles.length ? "<table>" + r.importerFiles.map((f) => "<tr><td class='muted'>" + f.hops + "</td><td><a data-f='" + esc(f.file) + "' data-l='1'>" + esc(f.file) + "</a></td></tr>").join("") + "</table>" : "<p class='muted'>None.</p>");
  app.innerHTML = h;
  bindLinks();
}

function bindLinks() {
  app.querySelectorAll("[data-f]").forEach((a) => (a.onclick = () => open(a.dataset.f, Number(a.dataset.l), a.dataset.hl ? JSON.parse(a.dataset.hl) : undefined)));
  app.querySelectorAll("[data-blast]").forEach((a) => (a.onclick = () => vscode.postMessage({ type: "blast", target: a.dataset.blast })));
}

/** Tiny layered layout, top → bottom (callers above callees) so it fits a narrow side panel. */
function graph(nodes, edges) {
  const ids = new Set(nodes.map((n) => n.id));
  edges = edges.filter((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to);
  const layer = new Map(nodes.map((n) => [n.id, n.rank ?? 0]));
  if (!nodes.some((n) => n.rank !== undefined)) for (let k = 0; k < nodes.length; k++) for (const e of edges) if (layer.get(e.to) <= layer.get(e.from) && layer.get(e.from) < nodes.length) layer.set(e.to, layer.get(e.from) + 1);
  const rows = [];
  for (const n of nodes) (rows[layer.get(n.id)] ||= []).push(n);
  const W = 200, H = 40, GX = 16, GY = 30;
  const widest = Math.max(...rows.filter(Boolean).map((r) => r.length));
  const width = 20 + widest * (W + GX) - GX;
  const pos = new Map();
  rows.forEach((r, y) => { const off = (width - (r.length * (W + GX) - GX)) / 2; r.forEach((n, x) => pos.set(n.id, { x: off + x * (W + GX), y: 10 + y * (H + GY) })); });
  const height = 20 + rows.length * (H + GY) - GY;
  let s = '<div class="graphbox"><svg width="' + width + '" height="' + height + '"><defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0L10,5L0,10z" fill="currentColor" opacity=".6"/></marker></defs>';
  for (const e of edges) { const a = pos.get(e.from), b = pos.get(e.to); const x1 = a.x + W / 2, y1 = a.y + H, x2 = b.x + W / 2, y2 = b.y; s += '<path class="edge" marker-end="url(#arr)" d="M' + x1 + "," + y1 + " C" + x1 + "," + (y1 + GY / 1.5) + " " + x2 + "," + (y2 - GY / 1.5) + " " + x2 + "," + y2 + '"/>'; }
  for (const n of nodes) {
    const p = pos.get(n.id), heat = Math.max(0.08, Math.min(1, n.heat || 0));
    s += '<g class="node" data-f="' + esc(n.file) + '" data-l="' + n.line + '" transform="translate(' + p.x + "," + p.y + ')"><rect width="' + W + '" height="' + H + '"/>' +
      '<rect width="4" height="' + H + '" style="fill:var(--hot);stroke:none;opacity:' + heat + '"/>' +
      '<text x="12" y="16" font-weight="600">' + esc(n.label.length > 26 ? n.label.slice(0, 25) + "…" : n.label) + "</text>" +
      '<text x="12" y="31" opacity=".65">' + esc(n.sub.length > 29 ? "…" + n.sub.slice(-28) : n.sub) + "</text></g>";
  }
  return s + "</svg></div>";
}
</script></body></html>`;
}
