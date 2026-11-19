/**
 * Deep trace: re-run the command that failed with a recorder attached, and store which functions of the
 * project actually ran in the graph:
 *
 *   (:Run {id, command, failed, ts, lang, session})-[:EXECUTED {count, since, lines, rets}]->(:Function)
 *
 * Passing runs recorded to compare with a failing one carry `session` = the failing run's id (spectrum.ts).
 *
 * `since` = how many calls to the project's functions happened after this one's last call (0 = it was the
 * last function to run, i.e. right next to the crash). Functions that already returned never show up in a stack
 * trace, but they do show up here.
 *
 * `lines` = the function's lines that ran ("12,13,15"). `rets` = JSON [[value, count, ago]] of what it returned
 * (Python only), where `ago` counts project returns after its last return of that value (0 = the last return).
 *
 * Python: python/br_trace/sitecustomize.py, picked up through PYTHONPATH (no packages to install).
 * Node: V8's built-in coverage (NODE_V8_COVERAGE), which every child node process honours.
 */
import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import { CodeGraph } from "./graph";
import { nowSec } from "./clock";
import { PyEnv, shellRun, withPyEnv } from "./pyenv";

/** A returned value (summary from the recorder), how often, and how many project returns came after its last one. */
export interface RetValue { v: string; n: number; ago: number }
export interface ExecRecord { file: string; line: number; name: string; count: number; since: number; lines?: number[]; rets?: RetValue[] }
/** What the Python recorder reported about itself (one per recorded process). */
export interface RecorderInfo { python?: string; version?: string; mode?: string; lines?: string }

export interface DeepTraceResult {
  exitCode: number | null;
  output: string;
  records: ExecRecord[];
  ms: number;
  /** Stopped by the user (signal) or by the time limit: nothing is recorded then. */
  stopped?: "cancelled" | "timeout";
  /** The Python processes that were recorded: interpreter, version, recording mode, line recording state. */
  recorders: RecorderInfo[];
  /** The shell the command ran in, and the Python environment put first on PATH, for messages. */
  shell: string;
  pyEnv?: string;
}

export interface DeepTraceOptions {
  root: string;
  command: string;
  cwd?: string;
  recorderDir: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** The user's terminal shell (pwsh, bash, …); default: the platform shell. */
  shellPath?: string;
  /** The project's Python environment, put first on PATH. */
  pyEnv?: PyEnv;
  /** Abort → the whole process tree is stopped. */
  signal?: AbortSignal;
}

/** Stop a process and everything it started (a shell's python child too). */
function killTree(pid: number | undefined) {
  if (!pid) return;
  try {
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    else process.kill(-pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

/** Run `command` in the user's shell with the recorders switched on. Never throws for a failing command. */
export function runDeepTrace(opts: DeepTraceOptions): Promise<DeepTraceResult> {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "br-trace-"));
  const base = withPyEnv(opts.env ?? process.env, opts.pyEnv);
  const env: NodeJS.ProcessEnv = {
    ...base,
    BR_TRACE_OUT: out,
    BR_TRACE_ROOT: opts.root,
    PYTHONPATH: [path.join(opts.recorderDir, "br_trace"), base.PYTHONPATH].filter(Boolean).join(path.delimiter),
    NODE_V8_COVERAGE: out,
  };
  const run = shellRun(opts.command, opts.shellPath);
  const t0 = Date.now();
  return new Promise((resolve) => {
    let stopped: DeepTraceResult["stopped"];
    let finished = false;
    const p = spawn(run.file, run.args, { cwd: opts.cwd ?? opts.root, env, shell: run.shell, windowsHide: true, detached: process.platform !== "win32" });
    let output = "";
    const keep = (d: Buffer) => {
      output += d.toString();
      if (output.length > 4_000_000) output = output.slice(-2_000_000);
    };
    p.stdout.on("data", keep);
    p.stderr.on("data", keep);
    const stop = (why: NonNullable<DeepTraceResult["stopped"]>) => {
      if (finished) return;
      stopped ??= why;
      killTree(p.pid);
    };
    const timer = setTimeout(() => stop("timeout"), opts.timeoutMs ?? 300_000);
    const onAbort = () => stop("cancelled");
    if (opts.signal?.aborted) onAbort();
    opts.signal?.addEventListener("abort", onAbort);
    const done = (code: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      const recorders = readRecorderInfo(out);
      const records = stopped ? [] : readRecords(out, opts.root);
      fs.rmSync(out, { recursive: true, force: true });
      resolve({ exitCode: code, output, records, ms: Date.now() - t0, stopped, recorders, shell: run.label, pyEnv: opts.pyEnv?.source });
    };
    p.on("error", (e) => {
      output += `\n${e.message}`;
      done(null);
    });
    p.on("close", done);
  });
}

/** The recorder's own notes (interpreter, mode, whether line recording survived) from each py-*.json. */
export function readRecorderInfo(dir: string): RecorderInfo[] {
  const out: RecorderInfo[] = [];
  let files: string[] = [];
  try { files = fs.readdirSync(dir); } catch { return out; }
  for (const f of files) {
    if (!/^py-\d+\.json$/.test(f)) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as RecorderInfo;
      out.push({ python: j.python, version: j.version, mode: j.mode, lines: j.lines });
    } catch {
      /* partial file */
    }
  }
  return out;
}

/**
 * Why a deep trace recorded nothing (or less than usual), in words a user can act on. Undefined when it
 * looks fine. `res` is the run; `kind` what the command looked like.
 */
export function explainDeepTrace(res: DeepTraceResult): { level: "error" | "warning"; text: string } | undefined {
  if (res.stopped === "cancelled") return { level: "warning", text: "Deep trace cancelled: nothing was recorded." };
  if (res.stopped === "timeout") return { level: "error", text: "Deep trace stopped after the time limit: nothing was recorded. Try re-running a single failing test instead of the whole suite." };
  const env = res.pyEnv ? ` (Python environment: ${res.pyEnv}, shell: ${res.shell})` : ` (shell: ${res.shell})`;
  if (!res.records.length) {
    if (/No module named|ModuleNotFoundError|ImportError/.test(res.output))
      return { level: "error", text: `Deep trace recorded nothing: the re-run could not import your code${env}. It probably used a different Python environment than your terminal. Select your project's interpreter in VS Code (Python: Select Interpreter), or put it in .venv.` };
    if (/is not recognized as|command not found|not found\s*$|cannot find the path/im.test(res.output))
      return { level: "error", text: `Deep trace recorded nothing: the command was not found when re-run${env}.` };
    if (res.exitCode === 0) return { level: "warning", text: "Deep trace recorded nothing, and the command passed this time (a flaky test?)." };
    return { level: "error", text: `Deep trace recorded nothing${env}. It records Python and Node commands; commands run in containers, over SSH, or through tsx/ts-node are not recorded yet.` };
  }
  if (res.recorders.some((r) => r.lines === "replaced"))
    return { level: "warning", text: "Another tracer (a coverage tool or debugger) took over line recording, so lines are missing; which functions ran and what they returned were still recorded. Re-running without --cov, or on Python 3.12+, records lines too." };
  if (res.exitCode === 0) return { level: "warning", text: "The command passed when re-run (a flaky test?). The recording shows a passing run, so the ranking may be off." };
  return undefined;
}

/**
 * Node's coverage has no call order, so "how close to the crash" is unknown: use this neutral value
 * (the same as SCORING.SINCE_K in analysis.ts, i.e. half the full "ran" weight).
 */
export const NODE_SINCE_UNKNOWN = 5;

/** Read every recorder file in `dir`: py-<pid>.json (Python recorder) and coverage-*.json (Node, V8). */
export function readRecords(dir: string, root?: string): ExecRecord[] {
  const recs: ExecRecord[] = [];
  let files: string[] = [];
  try { files = fs.readdirSync(dir); } catch { return recs; }
  for (const f of files) {
    try {
      if (/^py-\d+\.json$/.test(f)) {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as { seq: number; rseq?: number; calls: [string, number, string, number, number, number[]?, [string, number, number, number][]?][] };
        for (const [file, line, name, count, last, lines, rets] of j.calls)
          recs.push({ file, line, name, count, since: Math.max(0, j.seq - last), lines, rets: rets?.map(([v, n, , lastR]) => ({ v, n, ago: Math.max(0, (j.rseq ?? lastR) - lastR) })) });
      } else if (/^coverage-.*\.json$/.test(f)) {
        recs.push(...v8Records(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")), root));
      }
    } catch {
      /* a process killed mid-write */
    }
  }
  return recs;
}

type V8Coverage = { result: { url: string; functions: { functionName: string; ranges: { startOffset: number; endOffset: number; count: number }[] }[] }[] };

/** V8 function coverage → one record per function that ran (its first range is the whole function). */
function v8Records(cov: V8Coverage, root?: string): ExecRecord[] {
  const out: ExecRecord[] = [];
  const rootN = root ? path.resolve(root).toLowerCase() : undefined;
  for (const script of cov.result ?? []) {
    if (!script.url.startsWith("file:")) continue;
    let file: string;
    try { file = fileURLToPath(script.url); } catch { continue; }
    if (/[\\/]node_modules[\\/]/.test(file) || (rootN && !path.resolve(file).toLowerCase().startsWith(rootN))) continue;
    let starts: number[] | undefined;
    for (const fn of script.functions) {
      const r = fn.ranges[0];
      if (!r || r.count === 0 || (r.startOffset === 0 && !fn.functionName)) continue; // never ran / the module body
      if (!starts) {
        try { starts = lineStarts(fs.readFileSync(file, "utf8")); } catch { break; }
      }
      out.push({ file, line: lineAt(starts, r.startOffset), name: fn.functionName, count: r.count, since: NODE_SINCE_UNKNOWN, lines: ranLines(starts, fn.ranges) });
    }
  }
  return out;
}

/**
 * Lines of a function that ran, from V8 block coverage: a line ran when the innermost range covering its
 * start has a non-zero count (later, nested ranges override earlier ones). Lines are 1-based.
 */
function ranLines(starts: number[], ranges: { startOffset: number; endOffset: number; count: number }[]): number[] {
  const first = lineAt(starts, ranges[0].startOffset), last = lineAt(starts, Math.max(ranges[0].startOffset, ranges[0].endOffset - 1));
  const out: number[] = [];
  for (let ln = first; ln <= last; ln++) {
    const off = Math.max(starts[ln - 1], ranges[0].startOffset);
    let count = 0;
    for (const r of ranges) if (r.startOffset <= off && off < r.endOffset) count = r.count;
    if (count > 0) out.push(ln);
  }
  return out;
}

function lineStarts(text: string): number[] {
  const s = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) s.push(i + 1);
  return s;
}
function lineAt(starts: number[], offset: number): number {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
  }
  return lo + 1;
}

/**
 * Store a run in the graph and return its id. Each record maps to the innermost indexed function whose
 * lines contain its first line (lambdas and comprehensions count for their enclosing function).
 */
export function recordRun(g: CodeGraph, root: string, records: ExecRecord[], meta: { command: string; failed: boolean; lang?: string; session?: string }): { runId: string; functions: number } {
  const rootN = path.resolve(root);
  const byFile = new Map<string, ExecRecord[]>();
  for (const r of records) {
    const abs = path.resolve(r.file);
    const rel = path.relative(rootN, abs).split(path.sep).join("/");
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) continue;
    if (!byFile.has(rel)) byFile.set(rel, []);
    byFile.get(rel)!.push(r);
  }
  const agg = new Map<string, { count: number; since: number; lines: Set<number>; rets: Map<string, RetValue> }>();
  for (const [file, recs] of byFile) {
    const fns = g.q(
      "MATCH (f:Function {file:$file}) WHERE f.kind <> 'module' RETURN f.id AS id, f.startLine AS s, f.endLine AS e",
      { file }
    ) as { id: string; s: number; e: number }[];
    fns.sort((a, b) => a.e - a.s - (b.e - b.s)); // innermost first
    for (const r of recs) {
      const fn = fns.find((f) => f.s <= r.line && f.e >= r.line);
      if (!fn) continue;
      let a = agg.get(fn.id);
      if (!a) agg.set(fn.id, (a = { count: 0, since: Infinity, lines: new Set(), rets: new Map() }));
      a.count += r.count;
      a.since = Math.min(a.since, r.since);
      // Not the "def" line itself (Python reports it when the function starts), unless nothing else ran.
      for (const l of r.lines ?? []) if (l >= fn.s && l <= fn.e && (l !== fn.s || r.lines!.length === 1)) a.lines.add(l);
      for (const x of r.rets ?? []) {
        const p = a.rets.get(x.v);
        a.rets.set(x.v, p ? { v: x.v, n: p.n + x.n, ago: Math.min(p.ago, x.ago) } : { ...x });
      }
    }
  }
  const ts = Math.floor(nowSec());
  const runId = `run-${ts}-${Math.random().toString(36).slice(2, 8)}`;
  g.txn(() => {
    g.q("CREATE (:Run {id:$id, command:$command, failed:$failed, ts:$ts, lang:$lang, session:$session})", { id: runId, command: meta.command, failed: meta.failed, ts, lang: meta.lang ?? "python", session: meta.session ?? null });
    const rows = [...agg].map(([id, v]) => ({ id, count: v.count, since: v.since, lines: [...v.lines].sort((x, y) => x - y).join(","), rets: v.rets.size ? JSON.stringify([...v.rets.values()].map((x) => [x.v, x.n, x.ago])) : "" }));
    for (let i = 0; i < rows.length; i += 2000)
      g.q("MATCH (r:Run {id:$run}) UNWIND $rows AS x MATCH (f:Function {id:x.id}) CREATE (r)-[:EXECUTED {count:x.count, since:x.since, lines:x.lines, rets:x.rets}]->(f)", { run: runId, rows: rows.slice(i, i + 2000) });
    // Keep the graph small: the 300 most recent runs.
    g.q("MATCH (r:Run) WITH r ORDER BY r.ts DESC SKIP 300 DETACH DELETE r");
  });
  return { runId, functions: agg.size };
}

export interface Executed { count: number; since: number; lines: number[]; rets: RetValue[] }

const parseLines = (s: unknown): number[] => (typeof s === "string" && s ? s.split(",").map(Number) : []);
const parseRets = (s: unknown): RetValue[] => {
  if (typeof s !== "string" || !s) return [];
  try { return (JSON.parse(s) as [string, number, number][]).map(([v, n, ago]) => ({ v, n, ago })); } catch { return []; }
};

/** What a stored run says about each function: ran (with lateness, lines and return values) or not. */
export function executedIn(g: CodeGraph, runId: string): Map<string, Executed> {
  return new Map(
    g.q("MATCH (:Run {id:$id})-[e:EXECUTED]->(f:Function) RETURN f.id AS id, e.count AS count, e.since AS since, e.lines AS lines, e.rets AS rets", { id: runId })
      .map((r) => [r.id as string, { count: r.count as number, since: r.since as number, lines: parseLines(r.lines), rets: parseRets(r.rets) }])
  );
}

/**
 * Lines of each function that ran in the session's failing run(s) but in none of its passing runs.
 * Only for functions that also ran in at least one passing run (otherwise every line would qualify).
 */
export function failingOnlyLines(g: CodeGraph, sessionId: string): Map<string, number[]> {
  const rows = g.q(
    "MATCH (r:Run)-[e:EXECUTED]->(f:Function) WHERE r.id = $s OR r.session = $s RETURN f.id AS id, r.failed AS failed, e.lines AS lines",
    { s: sessionId }
  );
  const fail = new Map<string, Set<number>>(), pass = new Map<string, Set<number>>();
  for (const r of rows) {
    const m = r.failed ? fail : pass;
    const set = m.get(r.id as string) ?? new Set<number>();
    for (const l of parseLines(r.lines)) set.add(l);
    m.set(r.id as string, set);
  }
  const out = new Map<string, number[]>();
  for (const [id, f] of fail) {
    const p = pass.get(id);
    if (!p) continue;
    out.set(id, [...f].filter((l) => !p.has(l)).sort((a, b) => a - b));
  }
  return out;
}
