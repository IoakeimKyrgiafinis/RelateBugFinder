import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { CodeGraph } from "./core/graph";
import { isIndexable, Workspace } from "./core/workspace";
import { ago, blastRadius, codeLensInfo, traceSuspects } from "./core/analysis";
import { parseStackTrace } from "./core/stackTrace";
import { DeepTraceResult, explainDeepTrace, recordRun, runDeepTrace } from "./core/deepTrace";
import { PyEnv, envOfInterpreter, findProjectVenv } from "./core/pyenv";
import { relatedTests, testCommandFor } from "./core/spectrum";
import type { TraceResult } from "./core/types";
import { startBridge } from "./mcp/bridge";
import { BlastPanel, DeepInfo, PanelMsg } from "./panel";

let ws: Workspace | undefined;
let graph: CodeGraph | undefined;
let root = "";
let ready = false;
const out = vscode.window.createOutputChannel("Relate Bug Finder");
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
const cfg = () => vscode.workspace.getConfiguration("relateBugFinder");

export async function activate(ctx: vscode.ExtensionContext) {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return;
  root = folder.uri.fsPath;
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = "relateBugFinder.showPanel";
  status.text = "$(sync~spin) Relate Bug Finder: indexing…";
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
        status.text = "$(error) Relate Bug Finder: graph locked";
        log(`open failed: ${(e as Error).message}`);
        const pick = await vscode.window.showErrorMessage(
          "Relate Bug Finder can't open its graph file because another process holds it (another VS Code window on this folder, or a running relate-bug-finder CLI/MCP process). Close it, then retry.",
          "Retry"
        );
        if (pick === "Retry") {
          status.dispose();
          return activate(ctx);
        }
        return;
      }
      status.text = `$(sync~spin) Relate Bug Finder: waiting for graph lock (${attempt})…`;
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
      status.text = "$(sync~spin) Relate Bug Finder: indexing…";
      const s = await ws!.fullIndex();
      ready = true;
      log(`Indexed ${s.files} files, ${s.functions} functions, ${s.calls} call edges, ${s.gitCommits} commits in ${s.ms}ms`);
      if (s.pythonSkipped) log(`Python skipped: ${s.pythonSkipped}`);
      status.text = `$(pulse) ${s.functions} fns · ${s.calls} calls`;
      status.tooltip = `Relate Bug Finder graph (Relate): ${s.files} files indexed in ${s.ms}ms. Click to open the panel.`;
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
      const prompt = m.prompt + suspectCode(m.code ?? []);
      await vscode.env.clipboard.writeText(prompt);
      try {
        await vscode.commands.executeCommand("workbench.action.chat.open", { query: prompt });
      } catch {
        void vscode.window.showInformationMessage("Prompt copied to clipboard — paste it into your AI assistant.");
      }
    }
  };
  panelHandler = onPanelMsg;

  // ---- commands -----------------------------------------------------------------
  ctx.subscriptions.push(
    vscode.commands.registerCommand("relateBugFinder.reindex", () => reindex()),
    vscode.commands.registerCommand("relateBugFinder.showPanel", async () => {
      const clip = await vscode.env.clipboard.readText();
      BlastPanel.show(ctx.extensionUri, onPanelMsg, {
        mode: "welcome",
        stats: ready ? graph!.stats() : undefined,
        clipboard: parseStackTrace(clip).frames.length ? clip : "",
      });
    }),
    vscode.commands.registerCommand("relateBugFinder.traceError", async (text?: string) => {
      if (typeof text !== "string" || !text) {
        const ed = vscode.window.activeTextEditor;
        const sel = ed && !ed.selection.isEmpty ? ed.document.getText(ed.selection) : "";
        const clip = await vscode.env.clipboard.readText();
        text = parseStackTrace(sel).frames.length ? sel : parseStackTrace(clip).frames.length ? clip : "";
      }
      if (!text) return vscode.commands.executeCommand("relateBugFinder.showPanel");
      return showTrace(ctx, text);
    }),
    vscode.commands.registerCommand("relateBugFinder.blastRadius", async (target?: string) => {
      if (!target) {
        const ed = vscode.window.activeTextEditor;
        if (!ed) return;
        const fn = ws!.functionAt(rel(ed.document.uri), ed.selection.active.line + 1);
        target = fn && fn.kind !== "module" ? fn.id : rel(ed.document.uri);
      }
      return showBlast(ctx, target);
    }),
    vscode.commands.registerCommand("relateBugFinder.setupMcp", () => writeMcpConfigs(ctx)),
    vscode.commands.registerCommand("relateBugFinder.showLog", () => out.show())
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
                  command: "relateBugFinder.blastRadius",
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
let lastFailure: { text: string; command: string; cwd?: string; shellPath?: string } | undefined;

async function showTrace(ctx: vscode.ExtensionContext, text: string) {
  if (!ready) return void vscode.window.showWarningMessage("Relate Bug Finder is still indexing…");
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
  const pyEnv = await projectPyEnv();
  const res = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Relate Bug Finder: deep trace", cancellable: true }, async (p, token) => {
    p.report({ message: `re-running ${f.command}` });
    const stop = new AbortController();
    token.onCancellationRequested(() => stop.abort());
    return runDeepTrace({ root, command: f.command, cwd: f.cwd, recorderDir: path.join(ctx.extensionPath, "python"), shellPath: f.shellPath, pyEnv, signal: stop.signal });
  });
  const problem = explainDeepTrace(res);
  log(`deep trace: exit ${res.exitCode}, ${res.records.length} records, ${res.ms} ms, shell ${res.shell}, env ${res.pyEnv ?? "inherited"}${res.stopped ? `, ${res.stopped}` : ""}`);
  if (!res.records.length) {
    const msg = problem?.text ?? "Deep trace recorded nothing.";
    if (problem?.level === "warning") void vscode.window.showWarningMessage(msg);
    else void vscode.window.showErrorMessage(msg, "Show output").then((x) => x && showRunOutput(res.output));
    return;
  }
  if (problem) void vscode.window.showWarningMessage(problem.text);
  const text = parseStackTrace(res.output).frames.length ? res.output.slice(-256 * 1024) : f.text;
  const { result, functions, runId } = await serial(() => {
    const run = recordRun(graph!, root, res.records, { command: f.command, failed: res.exitCode !== 0 });
    return { result: traceSuspects(graph!, root, text, cfg().get<number>("maxSuspects") ?? 10, { run: run.runId }), functions: run.functions, runId: run.runId };
  });
  const deep: DeepInfo = {
    functions,
    seconds: Math.round((Date.now() - t0) / 100) / 10,
    exitCode: res.exitCode,
    canCompare: !!testCommandFor(f.command, { file: "t.py", qualifiedName: "T.test" }),
    env: describeEnv(res),
    note: problem?.text,
  };
  lastDeep = { runId, text, command: f.command, cwd: f.cwd, shellPath: f.shellPath, deep };
  BlastPanel.show(ctx.extensionUri, panelHandler, { mode: "trace", result, input: text, command: f.command, deep });
}

/** "Python 3.12 from .venv, pwsh" for the panel, from what the recorder reported. */
function describeEnv(res: DeepTraceResult): string {
  const py = res.recorders.find((r) => r.version);
  return [py ? `Python ${py.version}${res.pyEnv ? ` from ${res.pyEnv}` : ""}` : res.pyEnv ? `Python from ${res.pyEnv}` : "", res.shell].filter(Boolean).join(", ");
}

let runOutput: vscode.OutputChannel | undefined;
/** Show the re-run's own output, so a failure to start (wrong env, missing tool) is visible. */
function showRunOutput(text: string) {
  runOutput ??= vscode.window.createOutputChannel("Relate Bug Finder: deep trace run");
  runOutput.clear();
  runOutput.append(text.slice(-200_000));
  runOutput.show(true);
}

/**
 * The project's Python environment: VS Code's selected interpreter (Python extension), else a venv in the
 * project folder (.venv, venv, env). Undefined → the extension host's PATH.
 */
async function projectPyEnv(): Promise<PyEnv | undefined> {
  try {
    const ext = vscode.extensions?.getExtension("ms-python.python");
    if (ext) {
      const api = ext.isActive ? ext.exports : await ext.activate();
      const sel = api?.environments?.getActiveEnvironmentPath?.(vscode.Uri.file(root));
      const env = sel?.path ? envOfInterpreter(sel.path, "VS Code's selected interpreter") : undefined;
      if (env) return env;
    }
  } catch {
    /* no Python extension, or its API changed */
  }
  return findProjectVenv(root);
}

/** The last deep trace, so its related passing tests can be compared against it. */
let lastDeep: { runId: string; text: string; command: string; cwd?: string; shellPath?: string; deep: DeepInfo } | undefined;

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
    `Relate Bug Finder will run ${cmds.length} related test${cmds.length === 1 ? "" : "s"} with the recorder attached:\n\n${cmds.join("\n")}\n\nOnly continue if running your tests is safe.`,
    { modal: true },
    "Run related tests"
  );
  if (go !== "Run related tests") return show(d.deep);
  const t0 = Date.now();
  let passed = 0, ran = 0, cancelled = false;
  const pyEnv = await projectPyEnv();
  const failures: string[] = [];
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Relate Bug Finder: related passing tests", cancellable: true }, async (p, token) => {
    const stop = new AbortController();
    token.onCancellationRequested(() => stop.abort());
    for (let i = 0; i < cmds.length && !stop.signal.aborted; i++) {
      p.report({ message: `${i + 1}/${cmds.length}`, increment: 100 / cmds.length });
      const res = await runDeepTrace({ root, command: cmds[i], cwd: d.cwd, recorderDir: path.join(ctx.extensionPath, "python"), shellPath: d.shellPath, pyEnv, signal: stop.signal });
      if (res.stopped === "cancelled") { cancelled = true; break; }
      ran++;
      // Only passing tests are a contrast; a failing or erroring one (often setup) is left out.
      if (res.exitCode !== 0 || !res.records.length) {
        failures.push(res.output);
        continue;
      }
      passed++;
      await serial(() => recordRun(graph!, root, res.records, { command: cmds[i], failed: false, session: d.runId }));
    }
  });
  if (!passed)
    void vscode.window.showWarningMessage(
      cancelled ? "Cancelled before any related test passed, so the ranking is unchanged." : `None of the ${ran} related tests passed with a recording, so the ranking is unchanged.`,
      ...(failures.length ? ["Show output"] : [])
    ).then((x) => x && showRunOutput(failures.join("\n\n----------\n\n")));
  const deep: DeepInfo = { ...d.deep, canCompare: cancelled && !passed, spectrum: passed || !cancelled ? { tests: ran, passed, seconds: Math.round((Date.now() - t0) / 100) / 10 } : undefined };
  lastDeep = { ...d, deep };
  return show(deep);
}

async function showBlast(ctx: vscode.ExtensionContext, target: string) {
  if (!ready) return void vscode.window.showWarningMessage("Relate Bug Finder is still indexing…");
  const result = await serial(() => blastRadius(graph!, root, target));
  BlastPanel.show(ctx.extensionUri, panelHandler, result ? { mode: "blast", result } : { mode: "error", message: `Nothing in the graph matches "${target}".` });
}

/**
 * The top suspects' source for the AI prompt, numbered, with `>>` on the lines the deep trace highlights
 * (ran only in the failing test, or ran at all). Long functions are cut around those lines.
 */
export function suspectCode(code: { id: string; file: string; startLine: number; endLine: number; lines: number[] }[]): string {
  const parts: string[] = [];
  for (const s of code) {
    let src: string[];
    try { src = fs.readFileSync(path.join(root, s.file), "utf8").split(/\r?\n/); } catch { continue; }
    let a = s.startLine, b = Math.min(s.endLine, src.length);
    if (b - a > 80) {
      const mid = s.lines.length ? s.lines[0] : a;
      a = Math.max(a, mid - 30);
      b = Math.min(b, a + 80);
    }
    const mark = new Set(s.lines);
    const width = String(b).length;
    const body = src.slice(a - 1, b).map((t, i) => `${mark.has(a + i) ? ">>" : "  "} ${String(a + i).padStart(width)}  ${t}`).join("\n");
    parts.push(`${s.file} (${s.id.split("#")[1]}):\n\`\`\`\n${body}\n\`\`\``);
  }
  if (!parts.length) return "";
  const any = code.some((s) => s.lines.length);
  return `\n\nSource of the top suspects${any ? " (>> marks lines the deep trace recorded as running in the failing test)" : ""}:\n\n${parts.join("\n\n")}`;
}

/** The shell a terminal runs: its own shellPath, else VS Code's default terminal shell. */
function terminalShell(t: vscode.Terminal | undefined): string | undefined {
  const opts = t?.creationOptions as vscode.TerminalOptions | undefined;
  return opts?.shellPath || vscode.env?.shell || undefined;
}

let ranDecoration: vscode.TextEditorDecorationType | undefined;

/** Open a file at a line; after a deep trace, highlight the lines that ran (only in the failure, when compared). */
async function openAt(file: string, line: number, lines?: number[]) {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, file)));
  const pos = new vscode.Position(Math.max(0, line - 1), 0);
  // Never open the file on top of the panel: when the panel sits in the first column (no editor was open
  // when it appeared), open the file in the second one, beside it.
  const viewColumn = BlastPanel.column() === vscode.ViewColumn.One ? vscode.ViewColumn.Two : vscode.ViewColumn.One;
  const editor = await vscode.window.showTextDocument(doc, { viewColumn, selection: new vscode.Range(pos, pos) });
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
      lastFailure = command ? { text, command, cwd: e.execution.cwd?.fsPath, shellPath: terminalShell(e.terminal) } : undefined;
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
        return [{ startIndex: start, length: c.line.trimEnd().length - start, tooltip: "Relate Bug Finder: find the root-cause suspects", terminal: c.terminal } as vscode.TerminalLink & { terminal: vscode.Terminal }];
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
    lm.registerMcpServerDefinitionProvider("relateBugFinder.mcp", {
      provideMcpServerDefinitions: () => [
        // VS Code's own runtime doubles as Node, so users don't even need Node installed.
        new vscode.McpStdioServerDefinition("Relate Bug Finder", process.execPath, mcpCommand(ctx).args, { ELECTRON_RUN_AS_NODE: "1" }, "0.1.0"),
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
  const picks = await vscode.window.showQuickPick(targets.map((t) => ({ label: t.label, picked: true, t })), { canPickMany: true, title: "Register the Relate Bug Finder MCP server for…" });
  if (!picks?.length) return;
  for (const { t } of picks) {
    let json: Record<string, Record<string, unknown>> = {};
    try {
      json = JSON.parse(fs.readFileSync(t.file, "utf8"));
    } catch {
      /* new file */
    }
    json[t.key] = { ...(json[t.key] ?? {}), "relate-bug-finder": entry };
    fs.mkdirSync(path.dirname(t.file), { recursive: true });
    fs.writeFileSync(t.file, JSON.stringify(json, null, 2) + "\n");
  }
  void vscode.window.showInformationMessage(`Relate Bug Finder MCP registered for ${picks.map((p) => p.t.label).join(", ")}. Copilot picks it up automatically.`);
}

function ensureGitignore(root: string) {
  const gi = path.join(root, ".vscode", ".gitignore");
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, "codegraph.rl*\ncodegraph.bridge.json\n");
}
