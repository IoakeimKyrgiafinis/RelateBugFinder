/**
 * Deep trace: re-run the command that failed with a recorder attached, and store which functions of the
 * project actually ran in the graph:
 *
 *   (:Run {id, command, failed, ts, lang})-[:EXECUTED {count, since}]->(:Function)
 *
 * `since` = how many calls to the project's functions happened after this one's last call (0 = it was the
 * last function to run, i.e. right next to the crash). Functions that already returned never show up in a stack
 * trace, but they do show up here.
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

export interface ExecRecord { file: string; line: number; name: string; count: number; since: number }
export interface DeepTraceResult { exitCode: number | null; output: string; records: ExecRecord[]; ms: number }

/** Run `command` in a shell with the recorders switched on. Never throws for a failing command. */
export function runDeepTrace(opts: { root: string; command: string; cwd?: string; recorderDir: string; timeoutMs?: number; env?: NodeJS.ProcessEnv }): Promise<DeepTraceResult> {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "br-trace-"));
  const base = opts.env ?? process.env;
  const env: NodeJS.ProcessEnv = {
    ...base,
    BR_TRACE_OUT: out,
    BR_TRACE_ROOT: opts.root,
    PYTHONPATH: [path.join(opts.recorderDir, "br_trace"), base.PYTHONPATH].filter(Boolean).join(path.delimiter),
    NODE_V8_COVERAGE: out,
  };
  const t0 = Date.now();
  return new Promise((resolve) => {
    const p = spawn(opts.command, { cwd: opts.cwd ?? opts.root, env, shell: true, windowsHide: true });
    let output = "";
    const keep = (d: Buffer) => {
      output += d.toString();
      if (output.length > 4_000_000) output = output.slice(-2_000_000);
    };
    p.stdout.on("data", keep);
    p.stderr.on("data", keep);
    const timer = setTimeout(() => p.kill(), opts.timeoutMs ?? 300_000);
    const done = (code: number | null) => {
      clearTimeout(timer);
      const records = readRecords(out, opts.root);
      fs.rmSync(out, { recursive: true, force: true });
      resolve({ exitCode: code, output, records, ms: Date.now() - t0 });
    };
    p.on("error", () => done(null));
    p.on("close", done);
  });
}

/**
 * Node's coverage has no call order, so "how close to the crash" is unknown: use this neutral value
 * (the same as SCORING.SINCE_K in analysis.ts, i.e. half the full "ran" weight).
 */
export const NODE_SINCE_UNKNOWN = 2;

/** Read every recorder file in `dir`: py-<pid>.json (Python recorder) and coverage-*.json (Node, V8). */
export function readRecords(dir: string, root?: string): ExecRecord[] {
  const recs: ExecRecord[] = [];
  let files: string[] = [];
  try { files = fs.readdirSync(dir); } catch { return recs; }
  for (const f of files) {
    try {
      if (/^py-\d+\.json$/.test(f)) {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as { seq: number; calls: [string, number, string, number, number][] };
        for (const [file, line, name, count, last] of j.calls) recs.push({ file, line, name, count, since: Math.max(0, j.seq - last) });
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
      out.push({ file, line: lineAt(starts, r.startOffset), name: fn.functionName, count: r.count, since: NODE_SINCE_UNKNOWN });
    }
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
export function recordRun(g: CodeGraph, root: string, records: ExecRecord[], meta: { command: string; failed: boolean; lang?: string }): { runId: string; functions: number } {
  const rootN = path.resolve(root);
  const byFile = new Map<string, ExecRecord[]>();
  for (const r of records) {
    const abs = path.resolve(r.file);
    const rel = path.relative(rootN, abs).split(path.sep).join("/");
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) continue;
    if (!byFile.has(rel)) byFile.set(rel, []);
    byFile.get(rel)!.push(r);
  }
  const agg = new Map<string, { count: number; since: number }>();
  for (const [file, recs] of byFile) {
    const fns = g.q(
      "MATCH (f:Function {file:$file}) WHERE f.kind <> 'module' RETURN f.id AS id, f.startLine AS s, f.endLine AS e",
      { file }
    ) as { id: string; s: number; e: number }[];
    fns.sort((a, b) => a.e - a.s - (b.e - b.s)); // innermost first
    for (const r of recs) {
      const fn = fns.find((f) => f.s <= r.line && f.e >= r.line);
      if (!fn) continue;
      const prev = agg.get(fn.id) ?? { count: 0, since: Infinity };
      agg.set(fn.id, { count: prev.count + r.count, since: Math.min(prev.since, r.since) });
    }
  }
  const ts = Math.floor(nowSec());
  const runId = `run-${ts}-${Math.random().toString(36).slice(2, 8)}`;
  g.txn(() => {
    g.q("CREATE (:Run {id:$id, command:$command, failed:$failed, ts:$ts, lang:$lang})", { id: runId, command: meta.command, failed: meta.failed, ts, lang: meta.lang ?? "python" });
    const rows = [...agg].map(([id, v]) => ({ id, count: v.count, since: v.since }));
    for (let i = 0; i < rows.length; i += 2000)
      g.q("MATCH (r:Run {id:$run}) UNWIND $rows AS x MATCH (f:Function {id:x.id}) CREATE (r)-[:EXECUTED {count:x.count, since:x.since}]->(f)", { run: runId, rows: rows.slice(i, i + 2000) });
    // Keep the graph small: the 50 most recent runs.
    g.q("MATCH (r:Run) WITH r ORDER BY r.ts DESC SKIP 50 DETACH DELETE r");
  });
  return { runId, functions: agg.size };
}

/** What a stored run says about each function: ran (with lateness) or not. */
export function executedIn(g: CodeGraph, runId: string): Map<string, { count: number; since: number }> {
  return new Map(
    g.q("MATCH (:Run {id:$id})-[e:EXECUTED]->(f:Function) RETURN f.id AS id, e.count AS count, e.since AS since", { id: runId }).map((r) => [r.id as string, { count: r.count as number, since: r.since as number }])
  );
}
