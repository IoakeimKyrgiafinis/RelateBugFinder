import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { CodeGraph } from "./core/graph";
import { isIndexable, Workspace } from "./core/workspace";
import { ago, blastRadius, codeLensInfo, traceSuspects } from "./core/analysis";
import { parseStackTrace } from "./core/stackTrace";
import { recordRun, runDeepTrace } from "./core/deepTrace";
import { relatedTests, testCommandFor } from "./core/spectrum";
import type { TraceResult } from "./core/types";
import { startBridge } from "./mcp/bridge";
import { BlastPanel, DeepInfo, PanelMsg } from "./panel";

let ws: Workspace | undefined;
let graph: CodeGraph | undefined;
let root = "";
let ready = false;
const out = vscode.window.createOutputChannel("Blast Radius");
const log = (m: string) => out.appendLine(`[${new Date().toLocaleTimeString()}] ${m}`);
const changed = new vscode.EventEmitter<void>();

/** Relate's connection is single-threaded: serialise every graph mutation/read that awaits. */
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T> | T): Promise<T> {
  const p = queue.then(fn, fn);
  queue = p.catch(() => undefined);
  return p;
}

const rel = (uri: vscode.Uri) => path.relative(root, uri.fsPath).split(path.sep).join("/");
const cfg = () => vscode.workspace.getConfiguration("blastRadius");

export async function activate(ctx: vscode.ExtensionContext) {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return;
  root = folder.uri.fsPath;
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = "blastRadius.showPanel";
  status.text = "$(sync~spin) Blast Radius: indexing…";
  status.show();
  ctx.subscriptions.push(status, out);

  // ---- graph + initial index ------------------------------------------------
  const dbFile = path.join(root, ".vscode", "codegraph.rl");
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  ensureGitignore(root);
  // Relate allows one writer per file. Another window (or an older MCP server version) may hold it
  // briefly while exiting, so retry for a while before giving up.
  for (let attempt = 1; !graph; attempt++) {
    try {
      graph = CodeGraph.open(dbFile);
    } catch (e) {
      if (attempt >= 10) {
        status.text = "$(error) Blast Radius: graph locked";
        log(`open failed: ${(e as Error).message}`);
        const pick = await vscode.window.showErrorMessage(
          "Blast Radius can't open its graph file because another process holds it (another VS Code window on this folder, or a running blast-radius CLI/MCP process). Close it, then retry.",
          "Retry"
        );
        if (pick === "Retry") {
          status.dispose();
          return activate(ctx);
        }
        return;
      }
      status.text = `$(sync~spin) Blast Radius: waiting for graph lock (${attempt})…`;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  ws = new Workspace(root, graph, {
    pythonPath: cfg().get<string>("pythonPath") || undefined,
    gitSinceDays: cfg().get<number>("gitHistoryDays") ?? 30,
    pythonScript: path.join(ctx.extensionPath, "python", "py_index.py"),
    log,
  });
  const reindex = () =>
    serial(async () => {
      status.text = "$(sync~spin) Blast Radius: indexing…";
      const s = await ws!.fullIndex();
      ready = true;
      log(`Indexed ${s.files} files, ${s.functions} functions, ${s.calls} call edges, ${s.gitCommits} commits in ${s.ms}ms`);
      if (s.pythonSkipped) log(`Python skipped: ${s.pythonSkipped}`);
      status.text = `$(pulse) ${s.functions} fns · ${s.calls} calls`;
      status.tooltip = `Blast Radius graph (Relate): ${s.files} files indexed in ${s.ms}ms. Click to open the panel.`;
      changed.fire();
    });
  reindex().catch((e) => log(`index failed: ${e.stack ?? e}`));

  // ---- incremental updates ----------------------------------------------------
  const pending = new Map<string, NodeJS.Timeout>();
  const schedule = (uri: vscode.Uri, del = false) => {
    const r = rel(uri);
    if (r.startsWith("..") || !isIndexable(r)) return;
    clearTimeout(pending.get(r));
    pending.set(r, setTimeout(() => {
      pending.delete(r);
      serial(async () => {
        const t0 = Date.now();
        if (del) await ws!.deleteFile(r);
        else await ws!.updateFile(r);
        log(`${del ? "removed" : "re-indexed"} ${r} in ${Date.now() - t0}ms`);
        changed.fire();
      }).catch((e) => log(`update ${r} failed: ${e}`));
    }, 300));
  };
  const watcher = vscode.workspace.createFileSystemWatcher("**/*.{ts,tsx,js,jsx,mjs,cjs,mts,cts,py}");
  watcher.onDidChange((u) => schedule(u));
  watcher.onDidCreate((u) => schedule(u));
  watcher.onDidDelete((u) => schedule(u, true));
  // Commits / checkouts / pulls move HEAD → refresh the history layer.
  const gitWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, ".git/{HEAD,logs/HEAD}"));
  let gitTimer: NodeJS.Timeout | undefined;
  const onGit = () => {
    clearTimeout(gitTimer);
    gitTimer = setTimeout(() => serial(() => ws!.refreshGit(false)).then(() => changed.fire()).catch(() => undefined), 800);
  };
  gitWatcher.onDidChange(onGit);
  gitWatcher.onDidCreate(onGit);
  ctx.subscriptions.push(watcher, gitWatcher);

  // ---- panel ------------------------------------------------------------------
  const onPanelMsg = async (m: PanelMsg) => {
    if (m.type === "open") return openAt(m.file, m.line, m.lines);
    if (m.type === "trace") return showTrace(ctx, m.text);
    if (m.type === "blast") return showBlast(ctx, m.target);
    if (m.type === "deepTrace") return deepTrace(ctx);
    if (m.type === "compareTests") return compareTests(ctx);
    if (m.type === "askAi") {
      await vscode.env.clipboard.writeText(m.prompt);
      try {
        await vscode.commands.executeCommand("workbench.action.chat.open", { query: m.prompt });
      } catch {
        void vscode.window.showInformationMessage("Prompt copied to clipboard — paste it into your AI assistant.");
      }
    }
  };
  panelHandler = onPanelMsg;

  // ---- commands -----------------------------------------------------------------
  ctx.subscriptions.push(
    vscode.commands.registerCommand("blastRadius.reindex", () => reindex()),
    vscode.commands.registerCommand("blastRadius.showPanel", async () => {
      const clip = await vscode.env.clipboard.readText();
      BlastPanel.show(ctx.extensionUri, onPanelMsg, {
        mode: "welcome",
        stats: ready ? graph!.stats() : undefined,
        clipboard: parseStackTrace(clip).frames.length ? clip : "",
      });
    }),
    vscode.commands.registerCommand("blastRadius.traceError", async (text?: string) => {
      if (typeof text !== "string" || !text) {
        const ed = vscode.window.activeTextEditor;
        const sel = ed && !ed.selection.isEmpty ? ed.document.getText(ed.selection) : "";
        const clip = await vscode.env.clipboard.readText();
        text = parseStackTrace(sel).frames.length ? sel : parseStackTrace(clip).frames.length ? clip : "";
      }
      if (!text) return vscode.commands.executeCommand("blastRadius.showPanel");
      return showTrace(ctx, text);
    }),
    vscode.commands.registerCommand("blastRadius.blastRadius", async (target?: string) => {
      if (!target) {
        const ed = vscode.window.activeTextEditor;
        if (!ed) return;
        const fn = ws!.functionAt(rel(ed.document.uri), ed.selection.active.line + 1);
        target = fn && fn.kind !== "module" ? fn.id : rel(ed.document.uri);
      }
      return showBlast(ctx, target);
    }),
    vscode.commands.registerCommand("blastRadius.setupMcp", () => writeMcpConfigs(ctx)),
    vscode.commands.registerCommand("blastRadius.showLog", () => out.show())
  );

  // ---- CodeLens: "↑ 3 callers · 12 transitive · changed 3h ago" ----------------
  if (cfg().get<boolean>("codeLens", true)) {
    ctx.subscriptions.push(
      vscode.languages.registerCodeLensProvider(
        [{ scheme: "file", language: "typescript" }, { scheme: "file", language: "typescriptreact" }, { scheme: "file", language: "javascript" }, { scheme: "file", language: "javascriptreact" }, { scheme: "file", language: "python" }],
        {
          onDidChangeCodeLenses: changed.event,
          provideCodeLenses(doc) {
            if (!ready || !ws) return [];
            const r = rel(doc.uri);
            const pf = ws.files.get(r);
            if (!pf) return [];
            const info = codeLensInfo(graph!, r);
            return pf.functions
              .filter((f) => f.kind !== "module" && f.startLine <= doc.lineCount)
              .map((f) => {
                const i = info.get(f.id);
                const parts = [`$(references) ${i?.callers ?? 0} caller${i?.callers === 1 ? "" : "s"}`];
                if (i && i.transitive > i.callers) parts.push(`${i.transitive} transitive`);
                if (i?.dirty) parts.push("$(circle-filled) uncommitted");
                else if (i?.lastTs && Date.now() / 1000 - i.lastTs < 7 * 86400) parts.push(`changed ${ago(i.lastTs)}`);
                return new vscode.CodeLens(new vscode.Range(f.startLine - 1, 0, f.startLine - 1, 0), {
                  title: parts.join(" · "),
                  tooltip: "Show blast radius (who breaks if this changes)",
                  command: "blastRadius.blastRadius",
                  arguments: [f.id],
                });
              });
          },
        }
      )
    );
  }

  // ---- terminal: auto-trace failed commands + clickable error lines ------------
  setupTerminal(ctx);

  // ---- MCP: bridge for external agents + native registration for Copilot ---------
  try {
    const bridge = await startBridge(root, () => (ready ? graph : undefined), log);
    log(`MCP bridge on 127.0.0.1:${bridge.info.port}`);
    ctx.subscriptions.push({ dispose: bridge.close });
  } catch (e) {
    log(`MCP bridge failed: ${e}`);
  }
  registerMcpProvider(ctx);
}

export function deactivate() {
  graph?.checkpoint();
}

let panelHandler: (m: PanelMsg) => void = () => undefined;

/** The last failing terminal command (only those can be re-run by Deep trace). */
let lastFailure: { text: string; command: string; cwd?: string } | undefined;

async function showTrace(ctx: vscode.ExtensionContext, text: string) {
  if (!ready) return void vscode.window.showWarningMessage("Blast Radius is still indexing…");
  const result = await serial(() => traceSuspects(graph!, root, text, cfg().get<number>("maxSuspects") ?? 10));
  const command = lastFailure && lastFailure.text === text ? lastFailure.command : undefined;
  BlastPanel.show(ctx.extensionUri, panelHandler, { mode: "trace", result, input: text, command });
}

/**
 * Deep trace: re-run the failing command with recorders attached (Python: sys.setprofile via PYTHONPATH,
 * Node: NODE_V8_COVERAGE), store what ran as a (:Run) in the graph, and re-rank with it. Always asks first:
 * re-running a command can have side effects.
 */
async function deepTrace(ctx: vscode.ExtensionContext) {
  const f = lastFailure;
  if (!f || !ready) return;
  const go = await vscode.window.showWarningMessage(
    `Deep trace will run this command again, with a recorder attached:

${f.command}

Only continue if re-running it is safe (no deploys, payments or data changes).`,
    { modal: true },
    "Re-run with recording"
  );
  if (go !== "Re-run with recording") return void BlastPanel.show(ctx.extensionUri, panelHandler, { mode: "trace", result: await serial(() => traceSuspects(graph!, root, f.text, cfg().get<number>("maxSuspects") ?? 10)), input: f.text, command: f.command });
  const t0 = Date.now();
  const res = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Blast Radius: deep trace", cancellable: false }, async (p) => {
    p.report({ message: `re-running ${f.command}` });
    return runDeepTrace({ root, command: f.command, cwd: f.cwd, recorderDir: path.join(ctx.extensionPath, "python") });
  });
  if (!res.records.length) {
    void vscode.window.showWarningMessage("Deep trace recorded nothing. It works for Python and Node commands (not tsx/ts-node yet, nor commands run in containers).");
    return;
  }
  const text = parseStackTrace(res.output).frames.length ? res.output.slice(-256 * 1024) : f.text;
  const { result, functions, runId } = await serial(() => {
    const run = recordRun(graph!, root, res.records, { command: f.command, failed: res.exitCode !== 0 });
    return { result: traceSuspects(graph!, root, text, cfg().get<number>("maxSuspects") ?? 10, { run: run.runId }), functions: run.functions, runId: run.runId };
  });
  const deep: DeepInfo = { functions, seconds: Math.round((Date.now() - t0) / 100) / 10, exitCode: res.exitCode, canCompare: !!testCommandFor(f.command, { file: "t.py", qualifiedName: "T.test" }) };
  lastDeep = { runId, text, command: f.command, cwd: f.cwd, deep };
  BlastPanel.show(ctx.extensionUri, panelHandler, { mode: "trace", result, input: text, command: f.command, deep });
}

/** The last deep trace, so its related passing tests can be compared against it. */
let lastDeep: { runId: string; text: string; command: string; cwd?: string; deep: DeepInfo } | undefined;

/**
 * Spectrum-based localization: pick passing tests that exercise the code that ran just before the crash
 * (relatedTests, from the call graph), re-run each with the recorder, store them in the failing run's
 * session and re-rank with Ochiai. Asks first, listing the exact commands.
 */
async function compareTests(ctx: vscode.ExtensionContext) {
  const d = lastDeep;
  if (!d || !ready) return;
  const show = (deep: DeepInfo, result?: TraceResult) =>
    serial(() => result ?? traceSuspects(graph!, root, d.text, cfg().get<number>("maxSuspects") ?? 10, { run: d.runId })).then((r) =>
      BlastPanel.show(ctx.extensionUri, panelHandler, { mode: "trace", result: r, input: d.text, command: d.command, deep })
    );
  const cmds = await serial(() => relatedTests(graph!, d.runId, 8).map((t) => testCommandFor(d.command, t)).filter((c): c is string => !!c));
  if (!cmds.length) {
    void vscode.window.showInformationMessage("No related tests found: no test function calls the code that ran just before the crash.");
    return show({ ...d.deep, canCompare: false });
  }
  const go = await vscode.window.showWarningMessage(
    `Blast Radius will run ${cmds.length} related test${cmds.length === 1 ? "" : "s"} with the recorder attached:\n\n${cmds.join("\n")}\n\nOnly continue if running your tests is safe.`,
    { modal: true },
    "Run related tests"
  );
  if (go !== "Run related tests") return show(d.deep);
  const t0 = Date.now();
  let passed = 0;
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Blast Radius: related passing tests", cancellable: false }, async (p) => {
    for (let i = 0; i < cmds.length; i++) {
      p.report({ message: `${i + 1}/${cmds.length}`, increment: 100 / cmds.length });
      const res = await runDeepTrace({ root, command: cmds[i], cwd: d.cwd, recorderDir: path.join(ctx.extensionPath, "python") });
      // Only passing tests are a contrast; a failing or erroring one (often setup) is left out.
      if (res.exitCode !== 0 || !res.records.length) continue;
      passed++;
      await serial(() => recordRun(graph!, root, res.records, { command: cmds[i], failed: false, session: d.runId }));
    }
  });
  if (!passed) void vscode.window.showWarningMessage("None of the related tests passed with a recording, so the ranking is unchanged.");
  const deep: DeepInfo = { ...d.deep, canCompare: false, spectrum: { tests: cmds.length, passed, seconds: Math.round((Date.now() - t0) / 100) / 10 } };
  lastDeep = { ...d, deep };
  return show(deep);
}

async function showBlast(ctx: vscode.ExtensionContext, target: string) {
  if (!ready) return void vscode.window.showWarningMessage("Blast Radius is still indexing…");
  const result = await serial(() => blastRadius(graph!, root, target));
  BlastPanel.show(ctx.extensionUri, panelHandler, result ? { mode: "blast", result } : { mode: "error", message: `Nothing in the graph matches "${target}".` });
}

let ranDecoration: vscode.TextEditorDecorationType | undefined;

/** Open a file at a line; after a deep trace, highlight the lines that ran (only in the failure, when compared). */
async function openAt(file: string, line: number, lines?: number[]) {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, file)));
  const pos = new vscode.Position(Math.max(0, line - 1), 0);
  const editor = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, selection: new vscode.Range(pos, pos) });
  if (!editor?.setDecorations || !vscode.window.createTextEditorDecorationType) return;
  ranDecoration ??= vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor("diffEditor.removedLineBackground"),
    overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.errorForeground"),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  editor.setDecorations(ranDecoration, (lines ?? []).map((l) => new vscode.Range(new vscode.Position(l - 1, 0), new vscode.Position(l - 1, 0))));
}

// ------------------------------------------------------------------- terminal

function setupTerminal(ctx: vscode.ExtensionContext) {
  const MAX = 256 * 1024;
  const buffers = new Map<vscode.Terminal, string>();

  // Shell integration (VS Code ≥1.93): capture each command's output; when it fails with a trace, offer the analysis.
  ctx.subscriptions.push(
    vscode.window.onDidStartTerminalShellExecution(async (e) => {
      let buf = "";
      buffers.set(e.terminal, "");
      try {
        for await (const chunk of e.execution.read()) {
          buf = (buf + chunk).slice(-MAX);
          buffers.set(e.terminal, buf);
        }
      } catch {
        /* stream closed */
      }
    }),
    vscode.window.onDidEndTerminalShellExecution(async (e) => {
      if (!cfg().get<boolean>("autoTraceTerminal", true) || !ready) return;
      await new Promise((r) => setTimeout(r, 150)); // let the read loop drain
      const text = buffers.get(e.terminal) ?? "";
      if (e.exitCode === 0 && !/Error|Traceback|Exception/.test(text)) return;
      const parsed = parseStackTrace(text);
      if (!parsed.frames.length) return;
      // A successful command that merely logged "Error" + a file:line (linters, test logs) is not a crash.
      if (e.exitCode === 0 && parsed.language === "unknown") return;
      const command = e.execution.commandLine?.value?.trim();
      lastFailure = command ? { text, command, cwd: e.execution.cwd?.fsPath } : undefined;
      const result = await serial(() => traceSuspects(graph!, root, text, cfg().get<number>("maxSuspects") ?? 10));
      const top = result.suspects[0];
      if (!top) return;
      const why = top.reasons.find((r) => r.kind === "uncommitted" || r.kind === "commit")?.text ?? top.reasons[0]?.text ?? "";
      const o = result.valueOrigin;
      const headline = o?.source.kind === "call"
        ? `💥 "${o.expression}" was ${o.value}: it came from ${o.source.calleeText}()`
        : o?.source.kind === "param"
          ? `💥 "${o.expression}" was ${o.value}: the caller passed it in`
          : `💥 ${(result.note ?? "Command failed").slice(0, 90)}`;
      const pick = await vscode.window.showWarningMessage(
        `${headline} — top suspect: ${top.name} (${top.file}). ${why.slice(0, 80)}`,
        "Show suspects",
        "Open top suspect"
      );
      if (pick === "Show suspects") BlastPanel.show(ctx.extensionUri, panelHandler, { mode: "trace", result, input: text, command: lastFailure?.command });
      if (pick === "Open top suspect") void openAt(top.file, top.startLine);
    }),
    vscode.window.onDidCloseTerminal((t) => buffers.delete(t))
  );

  // Clickable "trace" links on error lines, for terminals without shell integration too.
  ctx.subscriptions.push(
    vscode.window.registerTerminalLinkProvider({
      provideTerminalLinks(c) {
        if (!/^\s*(?:[\w.]*(?:Error|Exception)\b|Traceback \(most recent call last\))/.test(c.line)) return [];
        const start = c.line.search(/\S/);
        return [{ startIndex: start, length: c.line.trimEnd().length - start, tooltip: "Blast Radius: find the root-cause suspects", terminal: c.terminal } as vscode.TerminalLink & { terminal: vscode.Terminal }];
      },
      handleTerminalLink(link: vscode.TerminalLink & { terminal?: vscode.Terminal }) {
        const buf = (link.terminal && buffers.get(link.terminal)) || "";
        if (parseStackTrace(buf).frames.length) return void showTrace(ctx, buf);
        // No captured output: grab the terminal selection/clipboard via the standard copy command.
        void vscode.commands.executeCommand("workbench.action.terminal.selectAll")
          .then(() => vscode.commands.executeCommand("workbench.action.terminal.copySelection"))
          .then(() => vscode.commands.executeCommand("workbench.action.terminal.clearSelection"))
          .then(() => vscode.env.clipboard.readText())
          .then((t) => showTrace(ctx, t.slice(-MAX)));
      },
    })
  );
}

// ------------------------------------------------------------------------ MCP

function mcpCommand(ctx: vscode.ExtensionContext) {
  return { command: "node", args: [path.join(ctx.extensionPath, "dist", "mcp.js"), "--root", root] };
}

function registerMcpProvider(ctx: vscode.ExtensionContext) {
  // Native registration: Copilot agent mode discovers the tools with zero config.
  const lm = vscode.lm as typeof vscode.lm & { registerMcpServerDefinitionProvider?: typeof vscode.lm.registerMcpServerDefinitionProvider };
  if (!lm.registerMcpServerDefinitionProvider) return;
  ctx.subscriptions.push(
    lm.registerMcpServerDefinitionProvider("blastRadius.mcp", {
      provideMcpServerDefinitions: () => [
        // VS Code's own runtime doubles as Node, so users don't even need Node installed.
        new vscode.McpStdioServerDefinition("Blast Radius", process.execPath, mcpCommand(ctx).args, { ELECTRON_RUN_AS_NODE: "1" }, "0.1.0"),
      ],
    })
  );
}

async function writeMcpConfigs(ctx: vscode.ExtensionContext) {
  const { command, args } = mcpCommand(ctx);
  const entry = { command, args };
  const targets = [
    { file: path.join(root, ".mcp.json"), label: "Claude Code (.mcp.json)", key: "mcpServers" },
    { file: path.join(root, ".cursor", "mcp.json"), label: "Cursor (.cursor/mcp.json)", key: "mcpServers" },
  ];
  const picks = await vscode.window.showQuickPick(targets.map((t) => ({ label: t.label, picked: true, t })), { canPickMany: true, title: "Register the Blast Radius MCP server for…" });
  if (!picks?.length) return;
  for (const { t } of picks) {
    let json: Record<string, Record<string, unknown>> = {};
    try {
      json = JSON.parse(fs.readFileSync(t.file, "utf8"));
    } catch {
      /* new file */
    }
    json[t.key] = { ...(json[t.key] ?? {}), "blast-radius": entry };
    fs.mkdirSync(path.dirname(t.file), { recursive: true });
    fs.writeFileSync(t.file, JSON.stringify(json, null, 2) + "\n");
  }
  void vscode.window.showInformationMessage(`Blast Radius MCP registered for ${picks.map((p) => p.t.label).join(", ")}. Copilot picks it up automatically.`);
}

function ensureGitignore(root: string) {
  const gi = path.join(root, ".vscode", ".gitignore");
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, "codegraph.rl*\ncodegraph.bridge.json\n");
}
