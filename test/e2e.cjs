/* End-to-end test of dist/extension.js against a mocked `vscode` API.
 * Usage: node test/e2e.cjs <demo-workspace> <node-trace-file>
 * Exercises: activation + full index, terminal auto-trace, panel messaging, CodeLens,
 * blast-radius command, incremental re-index on save, git commit refresh, MCP bridge. */
const Module = require("module");
const path = require("path");
const fs = require("fs");
const { execFileSync } = require("child_process");
const assert = require("assert");

const [root, traceFile] = process.argv.slice(2).map((p) => path.resolve(p));
const trace = fs.readFileSync(traceFile, "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000, what = "condition") => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(40); }
  throw new Error("timeout waiting for " + what);
};

// ----------------------------------------------------------------- vscode mock
class EventEmitter { constructor() { this.l = []; this.event = (f) => (this.l.push(f), { dispose() {} }); } fire(v) { this.l.forEach((f) => f(v)); } }
const handlers = { start: [], end: [], watch: [], commands: new Map(), lens: [], linkProviders: [], mcp: [] };
const panels = [];
const messages = [];
let warningAnswer;
let clipboard = "";
const disposable = { dispose() {} };
const vscode = {
  EventEmitter,
  Uri: { file: (p) => ({ fsPath: p, scheme: "file" }), joinPath: (u, ...p) => ({ fsPath: path.join(u.fsPath, ...p) }) },
  Position: class { constructor(l, c) { this.line = l; this.character = c; } },
  Range: class { constructor(a, b, c, d) { Object.assign(this, { a, b, c, d }); } },
  CodeLens: class { constructor(range, command) { this.range = range; this.command = command; } },
  RelativePattern: class { constructor(b, p) { this.base = b; this.pattern = p; } },
  McpStdioServerDefinition: class { constructor(label, command, args, env, version) { Object.assign(this, { label, command, args, env, version }); } },
  StatusBarAlignment: { Left: 1 }, ViewColumn: { One: 1, Beside: -2 },
  window: {
    createOutputChannel: () => ({ appendLine: (m) => process.env.VERBOSE && console.log("   log:", m), show() {}, dispose() {} }),
    createStatusBarItem: () => ({ show() {}, dispose() {}, text: "" }),
    createWebviewPanel: () => {
      const p = { posted: [], recv: null, title: "", webview: { html: "", postMessage: async (m) => p.posted.push(m), onDidReceiveMessage: (f) => (p.webview.recv = f) }, reveal() {}, onDidDispose() {} };
      panels.push(p);
      return p;
    },
    showWarningMessage: async (...a) => (messages.push(["warn", ...a]), warningAnswer),
    showInformationMessage: async (...a) => (messages.push(["info", ...a]), undefined),
    showErrorMessage: async (...a) => (messages.push(["error", ...a]), undefined),
    showQuickPick: async (items) => items,
    showTextDocument: async (doc, opts) => messages.push(["open", doc.uri.fsPath, opts.selection.a]),
    onDidStartTerminalShellExecution: (f) => (handlers.start.push(f), disposable),
    onDidEndTerminalShellExecution: (f) => (handlers.end.push(f), disposable),
    onDidCloseTerminal: () => disposable,
    registerTerminalLinkProvider: (p) => (handlers.linkProviders.push(p), disposable),
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: root } }],
    getConfiguration: () => ({ get: (_k, d) => d }),
    createFileSystemWatcher: (glob) => {
      const w = { glob, change: [], create: [], del: [], onDidChange: (f) => w.change.push(f), onDidCreate: (f) => w.create.push(f), onDidDelete: (f) => w.del.push(f), dispose() {} };
      handlers.watch.push(w);
      return w;
    },
    openTextDocument: async (uri) => ({ uri, lineCount: 1e6 }),
  },
  commands: {
    registerCommand: (id, f) => (handlers.commands.set(id, f), disposable),
    executeCommand: async (id, ...a) => (handlers.commands.has(id) ? handlers.commands.get(id)(...a) : messages.push(["exec", id, ...a])),
  },
  languages: { registerCodeLensProvider: (_s, p) => (handlers.lens.push(p), disposable) },
  env: { clipboard: { readText: async () => clipboard, writeText: async (t) => (clipboard = t) } },
  lm: { registerMcpServerDefinitionProvider: (id, p) => (handlers.mcp.push({ id, p }), disposable) },
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) { return req === "vscode" ? "vscode" : origResolve.call(this, req, ...rest); };
require.cache.vscode = { id: "vscode", filename: "vscode", loaded: true, exports: vscode };

// --------------------------------------------------------------------- tests
const ext = require("../dist/extension.js");
const ctx = { subscriptions: [], extensionPath: path.join(__dirname, ".."), extensionUri: { fsPath: path.join(__dirname, "..") } };
const ok = (m) => console.log("  ✓ " + m);

(async () => {
  const t0 = Date.now();
  await ext.activate(ctx);
  const bridgeFile = path.join(root, ".vscode", "codegraph.bridge.json");
  await until(() => fs.existsSync(bridgeFile), 8000, "bridge file");
  // wait for initial index (CodeLens returns [] until ready)
  const lensFor = async (rel) => handlers.lens[0].provideCodeLenses({ uri: { fsPath: path.join(root, rel) }, lineCount: 1e6 });
  await until(async () => (await lensFor("src/coupons.ts")).length > 0, 10000, "index");
  ok(`activated + indexed in ${Date.now() - t0}ms; commands: ${[...handlers.commands.keys()].join(", ")}`);

  // CodeLens
  const lenses = await lensFor("src/coupons.ts");
  assert.match(lenses[0].command.title, /1 caller/);
  assert.match(lenses[0].command.title, /changed \dh ago/);
  ok(`CodeLens on lookupCoupon: "${lenses[0].command.title}"`);
  const invLens = await lensFor("src/inventory.ts");
  assert.ok(invLens.some((l) => /uncommitted/.test(l.command.title)));
  ok(`CodeLens flags uncommitted edit: "${invLens.find((l) => /uncommitted/.test(l.command.title)).command.title}"`);

  // MCP native provider
  const defs = handlers.mcp[0].p.provideMcpServerDefinitions();
  assert.equal(defs[0].env.ELECTRON_RUN_AS_NODE, "1");
  ok(`MCP provider registered for Copilot: ${defs[0].label} → ${path.basename(defs[0].args[0])} --root …`);

  // Terminal: a failing command with a stack trace → warning → "Show suspects" → panel
  warningAnswer = "Show suspects";
  const terminal = { name: "zsh" };
  const execution = { read: async function* () { yield trace.slice(0, 200); yield trace.slice(200); } };
  handlers.start.forEach((f) => f({ terminal, execution }));
  await sleep(20);
  await Promise.all(handlers.end.map((f) => f({ terminal, execution, exitCode: 1 })));
  const warn = messages.find((m) => m[0] === "warn");
  assert.ok(warn, "no warning shown");
  ok(`terminal auto-trace notification: ${warn[1]}`);
  const panel = await until(() => panels[0], 3000, "panel");
  fs.writeFileSync(path.join(__dirname, "panel.html"), panel.webview.html);
  panel.webview.recv({ type: "ready" });
  const traceState = await until(() => panel.posted.find((m) => m.mode === "trace"), 3000, "trace state");
  assert.equal(traceState.result.suspects[0].id, "src/coupons.ts#lookupCoupon");
  ok(`panel shows suspects: ${traceState.result.suspects.slice(0, 3).map((s) => s.name + " " + s.score).join(", ")}`);
  fs.writeFileSync(path.join(__dirname, "state-trace.json"), JSON.stringify(traceState));

  // Panel → open file message
  await panel.webview.recv({ type: "open", file: "src/coupons.ts", line: 10 });
  assert.ok(messages.find((m) => m[0] === "open" && m[1].endsWith("src/coupons.ts")));
  ok("panel click opens src/coupons.ts:10");

  // Terminal link provider
  const links = handlers.linkProviders[0].provideTerminalLinks({ line: "TypeError: Cannot read properties of undefined (reading 'pct')", terminal });
  assert.equal(links.length, 1);
  ok("terminal error line becomes a clickable link");

  // Blast radius command (as invoked by CodeLens)
  await handlers.commands.get("blastRadius.blastRadius")("src/money.ts#applyDiscount");
  const blastState = await until(() => panel.posted.find((m) => m.mode === "blast"), 3000, "blast state");
  ok(`blast radius: ${blastState.result.summary}`);
  fs.writeFileSync(path.join(__dirname, "state-blast.json"), JSON.stringify(blastState));

  // Incremental: add a new caller of lookupCoupon in a new file, save → graph updates
  const newFile = path.join(root, "src", "promo.ts");
  fs.writeFileSync(newFile, 'import { lookupCoupon } from "./coupons.ts";\n\nexport function promoBanner(code: string) {\n  return `Save ${lookupCoupon(code).pct}%`;\n}\n');
  const t1 = Date.now();
  handlers.watch[0].create.forEach((f) => f({ fsPath: newFile }));
  await until(async () => /2 callers/.test((await lensFor("src/coupons.ts"))[0].command.title), 5000, "incremental update");
  ok(`new file indexed incrementally in ${Date.now() - t1}ms → lookupCoupon now "${(await lensFor("src/coupons.ts"))[0].command.title}"`);

  // Commit it → git watcher → history refresh: promoBanner is no longer "uncommitted"
  execFileSync("git", ["add", "src/promo.ts"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "Add promo banner"], { cwd: root });
  handlers.watch[1].change.forEach((f) => f({}));
  await until(async () => (await lensFor("src/promo.ts"))[0]?.command.title.includes("changed"), 6000, "git refresh");
  ok(`after commit: promoBanner "${(await lensFor("src/promo.ts"))[0].command.title}"`);

  // MCP via the bridge (extension holds the Relate writer lock)
  const { stdout: out, stderr: mcpErr } = await require("util").promisify(require("child_process").execFile)("node", [path.join(__dirname, "mcp-e2e.mjs"), root, traceFile], { encoding: "utf8", timeout: 30000 });
  assert.ok(!/not reachable/.test(mcpErr), "MCP fell back instead of using the bridge");
  assert.match(out, /#1 src\/coupons.ts#lookupCoupon/);
  assert.match(out, /promoBanner|2 direct|blast/);
  ok("MCP server answered through the live bridge:\n" + out.trim().split("\n").map((l) => "      " + l).join("\n"));

  ctx.subscriptions.forEach((d) => d.dispose && d.dispose());
  ext.deactivate();
  console.log("\nALL E2E CHECKS PASSED");
  process.exit(0);
})().catch((e) => {
  console.error("E2E FAILED:", e);
  process.exit(1);
});
