/* Deep trace through the real extension UI flow, against a mocked `vscode` API:
 *   failing terminal command → notification → panel → click "Deep trace" in the panel's own HTML (jsdom)
 *   → confirm → recorded re-run → click "Compare with related passing tests" → confirm → re-ranked panel,
 *   then ask the extension's live MCP bridge which (:Run) nodes are in the graph.
 * Usage: node test/e2e-deep.cjs   (builds demo-shop in a temp folder; needs python and git) */
const Module = require("module");
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");
const { execFileSync, spawnSync } = require("child_process");
const assert = require("assert");
const { JSDOM } = require("jsdom");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 20000, what = "condition") => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(50); }
  throw new Error("timeout waiting for " + what);
};
const ok = (m) => console.log("  ✓ " + m);

// ------------------------------------------------------------ the project: the judges' demo (demo-shop), whose Python
// scene has a bug in a helper that already returned before the error was raised
const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "br-e2e-deep-")), "demo-shop");
execFileSync(process.execPath, [path.join(__dirname, "..", "demo", "setup-demo.mjs"), root], { stdio: "ignore" });
const COMMAND = "python -m unittest tests.test_orders.OrdersTest.test_bulk_order";
const failing = spawnSync(COMMAND, { cwd: root, shell: true, encoding: "utf8" });
assert.notStrictEqual(failing.status, 0, "the demo test should fail");
const output = failing.stdout + failing.stderr;

// ------------------------------------------------------------ vscode mock
class EventEmitter { constructor() { this.l = []; this.event = (f) => (this.l.push(f), { dispose() {} }); } fire(v) { this.l.forEach((f) => f(v)); } }
const handlers = { start: [], end: [], lens: [] };
const panels = [];
const dialogs = [];
const decorated = [];
let clipboard = "";
const ACCEPT =["Show suspects", "Re-run with recording", "Run related tests"];
const disposable = { dispose() {} };
const vscode = {
  EventEmitter,
  Uri: { file: (p) => ({ fsPath: p, scheme: "file" }), joinPath: (u, ...p) => ({ fsPath: path.join(u.fsPath, ...p) }) },
  Position: class { constructor(l, c) { this.line = l; this.character = c; } },
  Range: class { constructor(a, b, c, d) { Object.assign(this, { a, b, c, d }); } },
  CodeLens: class { constructor(range, command) { this.range = range; this.command = command; } },
  RelativePattern: class { constructor(b, p) { this.base = b; this.pattern = p; } },
  McpStdioServerDefinition: class { constructor(label, command, args, env, version) { Object.assign(this, { label, command, args, env, version }); } },
  StatusBarAlignment: { Left: 1 }, ViewColumn: { One: 1, Two: 2, Beside: -2 }, ProgressLocation: { Notification: 15 }, OverviewRulerLane: { Left: 1 },
  ThemeColor: class { constructor(id) { this.id = id; } },
  window: {
    createOutputChannel: () => ({ appendLine: (m) => process.env.VERBOSE && console.log("   log:", m), show() {}, dispose() {} }),
    createStatusBarItem: () => ({ show() {}, dispose() {}, text: "" }),
    createWebviewPanel: () => {
      const p = { viewColumn: 1 /* panel in the first column, as when no editor was open */, posted: [], recv: null, webview: { html: "", asWebviewUri: (u) => u, cspSource: "", postMessage: async (m) => p.posted.push(m), onDidReceiveMessage: (f) => (p.webview.recv = f) }, reveal() {}, onDidDispose() {} };
      panels.push(p);
      return p;
    },
    // Accept the dialog's action button (what a user clicking "Re-run with recording" etc. would do).
    showWarningMessage: async (text, ...items) => { dialogs.push({ text, items: items.filter((x) => typeof x === "string") }); return items.find((x) => ACCEPT.includes(x)); },
    showInformationMessage: async (text) => (dialogs.push({ text, items: [] }), undefined),
    showErrorMessage: async (text) => (dialogs.push({ text, items: [] }), undefined),
    withProgress: async (_o, f) => f({ report() {} }, { onCancellationRequested() {} }),
    showTextDocument: async (doc, opts) => ({ document: doc, setDecorations: (_t, ranges) => decorated.push({ file: doc.uri.fsPath, column: opts?.viewColumn, lines: ranges.map((r) => r.a.line + 1) }) }),
    createTextEditorDecorationType: (o) => ({ ...o, dispose() {} }),
    onDidStartTerminalShellExecution: (f) => (handlers.start.push(f), disposable),
    onDidEndTerminalShellExecution: (f) => (handlers.end.push(f), disposable),
    onDidCloseTerminal: () => disposable,
    registerTerminalLinkProvider: () => disposable,
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: root } }],
    getConfiguration: () => ({ get: (_k, d) => d }),
    createFileSystemWatcher: () => ({ onDidChange() {}, onDidCreate() {}, onDidDelete() {}, dispose() {} }),
    openTextDocument: async (uri) => ({ uri, lineCount: 1e6 }),
  },
  commands: { registerCommand: () => disposable, executeCommand: async () => undefined },
  languages: { registerCodeLensProvider: (_s, p) => (handlers.lens.push(p), disposable) },
  env: { clipboard: { readText: async () => "", writeText: async (t) => { clipboard = t; } } },
  lm: { registerMcpServerDefinitionProvider: () => disposable },
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) { return req === "vscode" ? "vscode" : origResolve.call(this, req, ...rest); };
require.cache.vscode = { id: "vscode", filename: "vscode", loaded: true, exports: vscode };

/** Render the panel's real HTML+script with the latest state; return its document and what its buttons post. */
async function renderPanel(panel, state) {
  const sent = [];
  const html = panel.webview.html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "");
  const dom = new JSDOM(html, { runScripts: "dangerously", beforeParse(win) { win.acquireVsCodeApi = () => ({ postMessage: (m) => sent.push(m), getState() {}, setState() {} }); } });
  dom.window.postMessage(state, "*");
  await until(() => dom.window.document.querySelector(".card"), 3000, "panel render");
  return { doc: dom.window.document, sent };
}
const latest = (panel) => [...panel.posted].reverse().find((m) => m.mode === "trace");
const shortName = (s) => s.id.split("#")[1];

// ------------------------------------------------------------ the flow
const ext = require("../dist/extension.js");
const ctx = { subscriptions: [], extensionPath: path.join(__dirname, ".."), extensionUri: { fsPath: path.join(__dirname, "..") } };

(async () => {
  await ext.activate(ctx);
  await until(async () => (await handlers.lens[0].provideCodeLenses({ uri: { fsPath: path.join(root, "billing/orders.py") }, lineCount: 1e6 })).length > 0, 20000, "index");
  ok("extension activated and indexed demo-shop");

  // 1. The test fails in the terminal (shell integration reports the command line and cwd).
  const execution = { commandLine: { value: COMMAND }, cwd: { fsPath: root }, read: async function* () { yield output; } };
  const terminal = { name: "pwsh" };
  handlers.start.forEach((f) => f({ terminal, execution }));
  await sleep(50);
  await Promise.all(handlers.end.map((f) => f({ terminal, execution, exitCode: 1 })));
  assert.ok(dialogs.some((d) => d.items.includes("Show suspects")), "no notification");
  const panel = await until(() => panels[0], 3000, "panel");
  panel.webview.recv({ type: "ready" });
  const s1 = await until(() => latest(panel), 5000, "trace state");
  assert.strictEqual(s1.command, COMMAND, "panel should know the failing command");
  ok(`notification → panel: ${s1.result.suspects.slice(0, 4).map((s) => `${shortName(s)} ${s.score}`).join(", ")}`);

  // 2. Click the panel's Deep trace button.
  let ui = await renderPanel(panel, s1);
  const deepBtn = ui.doc.getElementById("deep");
  assert.ok(deepBtn, "Deep trace button missing");
  deepBtn.click();
  assert.strictEqual(ui.sent.at(-1)?.type, "deepTrace");
  const before = panel.posted.length;
  await panel.webview.recv({ type: ui.sent.at(-1).type });
  const confirm1 = await until(() => dialogs.find((d) => d.items.includes("Re-run with recording")), 5000, "confirm dialog");
  assert.ok(confirm1 && confirm1.text.includes(COMMAND), "confirm dialog should show the exact command");
  const s2 = await until(() => panel.posted.length > before && latest(panel).deep && latest(panel), 60000, "deep trace state");
  const bd2 = s2.result.suspects.find((s) => shortName(s) === "bulk_discount");
  assert.ok(bd2 && bd2.reasons.some((r) => r.kind === "ran"), "bulk_discount should have a 'ran' reason");
  ok(`Deep trace (confirmed "${confirm1.items[0]}"): ${s2.deep.functions} functions ran in ${s2.deep.seconds}s; ${s2.result.suspects.slice(0, 4).map((s) => `${shortName(s)} ${s.score}`).join(", ")}`);
  ui = await renderPanel(panel, s2);
  assert.match(ui.doc.querySelector(".origin").textContent, /of your functions ran/);
  ok(`panel box: "${ui.doc.querySelector(".origin").textContent.trim().slice(0, 110)}…"`);

  // 3. Click "Compare with related passing tests".
  const sbBtn = ui.doc.getElementById("sbfl");
  assert.ok(sbBtn, "Compare button missing");
  sbBtn.click();
  assert.strictEqual(ui.sent.at(-1)?.type, "compareTests");
  const before2 = panel.posted.length;
  await panel.webview.recv({ type: ui.sent.at(-1).type });
  const confirm2 = await until(() => dialogs.find((d) => d.items.includes("Run related tests")), 10000, "compare dialog");
  assert.ok(confirm2 && /OrdersTest\.test_small_order/.test(confirm2.text), "confirm should list test_small_order");
  const s3 = await until(() => panel.posted.length > before2 && latest(panel).deep?.spectrum && latest(panel), 60000, "spectrum state");
  assert.deepStrictEqual([s3.deep.spectrum.tests, s3.deep.spectrum.passed], [1, 1]);
  const bd3 = s3.result.suspects.find((s) => shortName(s) === "bulk_discount");
  assert.ok(bd3.reasons.some((r) => /none of the 1 related passing test/.test(r.text)), "bulk_discount should say it ran in no passing test");
  ok(`Compare (confirmed, ran: ${confirm2.text.split("\n").filter((l) => l.includes("unittest")).join("; ")}): ${s3.result.suspects.slice(0, 4).map((s) => `${shortName(s)} ${s.score}`).join(", ")}`);
  fs.writeFileSync(path.join(__dirname, "state-deep.json"), JSON.stringify(s3)); // for README screenshots (test/render-panel.cjs)
  ui = await renderPanel(panel, s3);
  assert.ok(!ui.doc.getElementById("sbfl"), "Compare button should be gone after comparing");
  ok(`panel box: "${ui.doc.querySelector(".origin").textContent.match(/Compared with[^)]*[)]/)[0]}"`);
  ok(`bulk_discount: ${bd3.reasons.map((r) => r.text).join(" | ")}`);

  // The bad value's producer is #1, and the lines that ran only in the failure are shown and highlighted.
  assert.strictEqual(shortName(s3.result.suspects[0]), "bulk_discount", "the function that returned the bad value should be #1");
  assert.ok(bd3.reasons[0].kind === "returned" && /-10\.000000000000014/.test(bd3.reasons[0].text));
  const ot = s3.result.suspects.find((s) => shortName(s) === "order_total");
  assert.deepStrictEqual(ot.lines.failingOnly, [22], "order_total: only `total = bulk_discount(total)` ran only in the failure");
  const card = [...ui.doc.querySelectorAll(".card")].find((c) => c.querySelector(".name").textContent.includes("order_total"));
  const lineLink = card.querySelector(".lines a");
  assert.ok(lineLink && /ran only in the failing test/.test(card.querySelector(".lines").textContent), "line block missing");
  lineLink.click();
  const openMsg = JSON.parse(JSON.stringify(ui.sent.at(-1)));
  assert.deepStrictEqual([openMsg.type, openMsg.line, openMsg.lines], ["open", 22, [22]]);
  await panel.webview.recv(openMsg);
  await until(() => decorated.length, 3000, "editor decoration");
  assert.deepStrictEqual(decorated.at(-1).lines, [22], "editor should highlight line 22");
  assert.strictEqual(decorated.at(-1).column, 2, "the file should open beside the panel (column 2), not on top of it");
  ok(`order_total: "${card.querySelector(".lines").textContent.trim()}" → click opens billing/orders.py:22 with line 22 highlighted`);

  // "Ask AI to fix": the prompt carries the returned value, the highlighted lines, and the suspects' code.
  ui.doc.getElementById("ai").click();
  const ask = JSON.parse(JSON.stringify(ui.sent.at(-1)));
  assert.strictEqual(ask.type, "askAi");
  await panel.webview.recv(ask);
  await until(() => clipboard, 3000, "AI prompt");
  assert.match(clipboard, /Returned `-10\.000000000000014`/, "prompt should name the returned value");
  assert.match(clipboard, /Lines that ran only in the failing test: 22/, "prompt should list the failing-only lines");
  assert.match(clipboard, />> 22 +total = bulk_discount\(total\)/, "prompt should include the code with >> on line 22");
  ok(`AI prompt includes the returned value, the lines, and the code: "${clipboard.split("\n").find((l) => l.startsWith(">> 22"))}"`);

  // 4. The runs are in the live graph: ask the extension's MCP bridge (read-only Cypher).
  const info = JSON.parse(fs.readFileSync(path.join(root, ".vscode", "codegraph.bridge.json"), "utf8"));
  const rows = await new Promise((resolve, reject) => {
    const body = JSON.stringify({ name: "query_codegraph", args: { cypher: "MATCH (r:Run)-[e:EXECUTED]->(f:Function) RETURN r.command AS command, r.failed AS failed, r.session IS NOT NULL AS inSession, count(f) AS functions ORDER BY failed DESC" } });
    const req = http.request({ host: "127.0.0.1", port: info.port, path: "/tool", method: "POST", headers: { authorization: `Bearer ${info.token}`, "content-type": "application/json" } }, (res) => {
      let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on("error", reject); req.end(body);
  });
  const text = JSON.stringify(rows.result ?? rows);
  assert.ok(/test_bulk_order/.test(text) && /test_small_order/.test(text), "both runs should be in the graph: " + text);
  ok(`graph (via MCP bridge): ${text.slice(0, 400)}`);

  ctx.subscriptions.forEach((d) => d.dispose && d.dispose());
  ext.deactivate();
  fs.rmSync(path.dirname(root), { recursive: true, force: true });
  console.log("\nDEEP-TRACE UI E2E CHECKS PASSED");
  process.exit(0);
})().catch((e) => {
  console.error("E2E-DEEP FAILED:", e);
  console.error("dialogs:", JSON.stringify(dialogs, null, 1).slice(0, 2000));
  process.exit(1);
});
