/* Deep trace through the real extension UI flow, against a mocked `vscode` API:
 *   failing terminal command → notification → panel → click "Deep trace" in the panel's own HTML (jsdom)
 *   → confirm → recorded re-run → click "Compare with related passing tests" → confirm → re-ranked panel,
 *   then ask the extension's live MCP bridge which (:Run) nodes are in the graph.
 * Usage: node test/e2e-deep.cjs   (builds its own throwaway Python project; needs python and git) */
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

// ------------------------------------------------------------ the project: a bug in a helper that already returned
const root = fs.mkdtempSync(path.join(os.tmpdir(), "br-e2e-deep-"));
const w = (f, s) => { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), s); };
const pricing = (bulk) => ["def subtotal(qty):", "    return qty * 10", "", "def bulk_discount(total):", `    return ${bulk}`, "",
  "def validate(total):", "    if total < 0:", "        raise ValueError('negative total: %s' % total)", "    return total", "",
  "def order_total(qty):", "    total = subtotal(qty)", "    if qty > 5:", "        total = bulk_discount(total)", "    return validate(total)", ""].join("\n");
w("pkg/__init__.py", ""); w("tests/__init__.py", "");
w("pkg/pricing.py", pricing("total * 0.9"));
w("tests/test_pricing.py", ["import unittest", "from pkg.pricing import order_total", "", "class PricingTest(unittest.TestCase):",
  "    def test_bulk(self):", "        self.assertEqual(order_total(10), 90)", "", "    def test_small(self):", "        self.assertEqual(order_total(2), 20)", ""].join("\n"));
w(".gitignore", ".vscode/\n__pycache__/\n");
const git = (...a) => execFileSync("git", ["-c", "user.name=Demo", "-c", "user.email=demo@example.com", ...a], { cwd: root, stdio: "ignore" });
git("init", "-q"); git("add", "-A"); git("commit", "-q", "-m", "Pricing", "--date", new Date(Date.now() - 20 * 864e5).toISOString());
w("pkg/pricing.py", pricing("total - total * 1.1  # 10% off"));
git("commit", "-q", "-am", "Simplify bulk discount");
const COMMAND = "python -m unittest -q tests.test_pricing.PricingTest.test_bulk";
const failing = spawnSync(COMMAND, { cwd: root, shell: true, encoding: "utf8" });
assert.notStrictEqual(failing.status, 0, "the demo test should fail");
const output = failing.stdout + failing.stderr;

// ------------------------------------------------------------ vscode mock
class EventEmitter { constructor() { this.l = []; this.event = (f) => (this.l.push(f), { dispose() {} }); } fire(v) { this.l.forEach((f) => f(v)); } }
const handlers = { start: [], end: [], lens: [] };
const panels = [];
const dialogs = [];
const ACCEPT = ["Show suspects", "Re-run with recording", "Run related tests"];
const disposable = { dispose() {} };
const vscode = {
  EventEmitter,
  Uri: { file: (p) => ({ fsPath: p, scheme: "file" }), joinPath: (u, ...p) => ({ fsPath: path.join(u.fsPath, ...p) }) },
  Position: class { constructor(l, c) { this.line = l; this.character = c; } },
  Range: class { constructor(a, b, c, d) { Object.assign(this, { a, b, c, d }); } },
  CodeLens: class { constructor(range, command) { this.range = range; this.command = command; } },
  RelativePattern: class { constructor(b, p) { this.base = b; this.pattern = p; } },
  McpStdioServerDefinition: class { constructor(label, command, args, env, version) { Object.assign(this, { label, command, args, env, version }); } },
  StatusBarAlignment: { Left: 1 }, ViewColumn: { One: 1, Beside: -2 }, ProgressLocation: { Notification: 15 },
  window: {
    createOutputChannel: () => ({ appendLine: (m) => process.env.VERBOSE && console.log("   log:", m), show() {}, dispose() {} }),
    createStatusBarItem: () => ({ show() {}, dispose() {}, text: "" }),
    createWebviewPanel: () => {
      const p = { posted: [], recv: null, webview: { html: "", asWebviewUri: (u) => u, cspSource: "", postMessage: async (m) => p.posted.push(m), onDidReceiveMessage: (f) => (p.webview.recv = f) }, reveal() {}, onDidDispose() {} };
      panels.push(p);
      return p;
    },
    // Accept the dialog's action button (what a user clicking "Re-run with recording" etc. would do).
    showWarningMessage: async (text, ...items) => { dialogs.push({ text, items: items.filter((x) => typeof x === "string") }); return items.find((x) => ACCEPT.includes(x)); },
    showInformationMessage: async (text) => (dialogs.push({ text, items: [] }), undefined),
    showErrorMessage: async (text) => (dialogs.push({ text, items: [] }), undefined),
    withProgress: async (_o, f) => f({ report() {} }),
    showTextDocument: async () => undefined,
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
  env: { clipboard: { readText: async () => "", writeText: async () => undefined } },
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
  await until(async () => (await handlers.lens[0].provideCodeLenses({ uri: { fsPath: path.join(root, "pkg/pricing.py") }, lineCount: 1e6 })).length > 0, 20000, "index");
  ok("extension activated and indexed the Python project");

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
  assert.ok(confirm2 && /PricingTest\.test_small/.test(confirm2.text), "confirm should list test_small");
  const s3 = await until(() => panel.posted.length > before2 && latest(panel).deep?.spectrum && latest(panel), 60000, "spectrum state");
  assert.deepStrictEqual([s3.deep.spectrum.tests, s3.deep.spectrum.passed], [1, 1]);
  const bd3 = s3.result.suspects.find((s) => shortName(s) === "bulk_discount");
  assert.ok(bd3.reasons.some((r) => /none of the 1 related passing test/.test(r.text)), "bulk_discount should say it ran in no passing test");
  ok(`Compare (confirmed, ran: ${confirm2.text.split("\n").filter((l) => l.includes("unittest")).join("; ")}): ${s3.result.suspects.slice(0, 4).map((s) => `${shortName(s)} ${s.score}`).join(", ")}`);
  ui = await renderPanel(panel, s3);
  assert.ok(!ui.doc.getElementById("sbfl"), "Compare button should be gone after comparing");
  ok(`panel box: "${ui.doc.querySelector(".origin").textContent.match(/Compared with[^)]*[)]/)[0]}"`);
  ok(`bulk_discount: ${bd3.reasons.map((r) => r.text).join(" | ")}`);

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
  assert.ok(/test_bulk/.test(text) && /test_small/.test(text), "both runs should be in the graph: " + text);
  ok(`graph (via MCP bridge): ${text.slice(0, 400)}`);

  ctx.subscriptions.forEach((d) => d.dispose && d.dispose());
  ext.deactivate();
  fs.rmSync(root, { recursive: true, force: true });
  console.log("\nDEEP-TRACE UI E2E CHECKS PASSED");
  process.exit(0);
})().catch((e) => {
  console.error("E2E-DEEP FAILED:", e);
  console.error("dialogs:", JSON.stringify(dialogs, null, 1).slice(0, 2000));
  process.exit(1);
});
