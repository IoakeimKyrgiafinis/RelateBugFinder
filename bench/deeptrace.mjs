#!/usr/bin/env node
// Record a "deep trace" for every reproduced bug: re-run its failing test once more with the Python
// recorder (python/br_trace/sitecustomize.py) attached, exactly as the extension's Deep trace button
// does, and keep the recordings in ../bench-cache/deeptrace/<project>-<id>/ for evaluate.ts.
// Reuses the worktrees and venvs that bench/bugsinpy.mjs built.
//   Usage: node bench/deeptrace.mjs [--jobs 4] [--only black:12,tqdm:5] [--passing]
// --passing: instead, record related PASSING tests for spectrum-based localization (bench/related.ts picks
// them from the graph, like the extension), into <dir>/pass-<i>/ with <dir>/passing.json listing them.
import { execFileSync, spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = path.resolve(process.env.BENCH_CACHE ?? path.join(REPO, "..", "bench-cache"));
const DATASET = path.join(CACHE, "BugsInPy");
const OUT = path.join(REPO, "bench", "results", "bugsinpy.jsonl");
const RECORDER = path.join(REPO, "python", "br_trace");
const WIN = process.platform === "win32";
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const jobs = Number(arg("jobs", "4"));
const only = arg("only");
const passing = process.argv.includes("--passing");
const MAX_PASSING = Number(arg("max-passing", "8"));

const NO_PROMPTS = { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_ASKPASS: "echo", SSH_ASKPASS: "echo" };

function run(cmd, args, opts) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { ...opts, windowsHide: true });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    const t = setTimeout(() => p.kill(), opts.timeout ?? 600_000);
    p.on("close", (code) => { clearTimeout(t); resolve({ code, out }); });
    p.on("error", () => { clearTimeout(t); resolve({ code: null, out }); });
  });
}
const readText = (f) => {
  const b = fs.readFileSync(f);
  return ((b[0] === 0xff && b[1] === 0xfe) || (b.length > 1 && b[1] === 0) ? b.toString("utf16le") : b.toString("utf8")).replace(/^﻿/, "");
};

async function recordPassing(bug) {
  const [project, id] = bug.split(":");
  const wt = path.join(CACHE, "work", `${project}-${id}`);
  const venv = path.join(CACHE, "venvs", `${project}-${id}`);
  const dest = path.join(CACHE, "deeptrace", `${project}-${id}`);
  if (!fs.existsSync(dest)) return console.log(`${bug.padEnd(14)} no failing deep trace yet`);
  for (const d of fs.readdirSync(dest)) if (d.startsWith("pass-")) fs.rmSync(path.join(dest, d), { recursive: true, force: true });
  const t0 = Date.now();
  // Same runner as the bug's own failing command (pytest, or unittest for projects like Black).
  const first = readText(path.join(DATASET, "projects", project, "bugs", id, "run_test.sh")).split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith("#")) ?? "pytest";
  const failing = first.replace(/^tox\s+(?:-e\s+\S+\s+)?/, "pytest ").replace(/^pytest\b/, "python -m pytest").replace(/^python3?\b/, "python");
  const rel = await run("node", [path.join(REPO, "bench", ".dist", "related.cjs"), wt, dest, failing, String(MAX_PASSING)], { cwd: REPO, timeout: 600_000 });
  let ids = [];
  try { ids = JSON.parse(rel.out.trim().split(/\r?\n/).pop()); } catch { /* none */ }
  const bin = path.join(venv, WIN ? "Scripts" : "bin");
  const runs = [];
  for (let i = 0; i < ids.length; i++) {
    const out = path.join(dest, `pass-${i}`);
    fs.mkdirSync(out, { recursive: true });
    const env = {
      ...process.env, ...NO_PROMPTS,
      PATH: bin + path.delimiter + process.env.PATH, VIRTUAL_ENV: venv,
      PYTHONPATH: [RECORDER, wt].join(path.delimiter), PYTHONIOENCODING: "utf-8", PYTHONDONTWRITEBYTECODE: "1",
      BR_TRACE_OUT: out, BR_TRACE_ROOT: wt,
    };
    const x = await run("bash", ["-c", ids[i]], { cwd: wt, env, timeout: 600_000 });
    runs.push({ command: ids[i], dir: `pass-${i}`, exitCode: x.code });
  }
  fs.writeFileSync(path.join(dest, "passing.json"), JSON.stringify(runs));
  const ok = runs.filter((r) => r.exitCode === 0).length;
  console.log(`${bug.padEnd(14)} ${ids.length} related test(s): ${ok} passed, ${runs.length - ok} failed/errored  ${Math.round((Date.now() - t0) / 1000)}s`);
}

async function record(bug) {
  const [project, id] = bug.split(":");
  const wt = path.join(CACHE, "work", `${project}-${id}`);
  const venv = path.join(CACHE, "venvs", `${project}-${id}`);
  const dest = path.join(CACHE, "deeptrace", `${project}-${id}`);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  const bin = path.join(venv, WIN ? "Scripts" : "bin");
  const env = {
    ...process.env, ...NO_PROMPTS,
    PATH: bin + path.delimiter + process.env.PATH, VIRTUAL_ENV: venv,
    PYTHONPATH: [RECORDER, wt].join(path.delimiter), PYTHONIOENCODING: "utf-8", PYTHONDONTWRITEBYTECODE: "1",
    BR_TRACE_OUT: dest, BR_TRACE_ROOT: wt,
  };
  const t0 = Date.now();
  const cmds = readText(path.join(DATASET, "projects", project, "bugs", id, "run_test.sh")).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  let failed = false;
  for (const c of cmds) {
    const cmd = c.replace(/^tox\s+(?:-e\s+\S+\s+)?/, "pytest ").replace(/^pytest\b/, "python -m pytest").replace(/^python3?\b/, "python");
    const x = await run("bash", ["-c", cmd], { cwd: wt, env, timeout: 900_000 });
    if (x.code !== 0) failed = true;
  }
  const files = fs.readdirSync(dest).filter((f) => f.endsWith(".json"));
  console.log(`${bug.padEnd(14)} ${failed ? "failed " : "PASSED?"} ${files.length} process(es) recorded  ${Math.round((Date.now() - t0) / 1000)}s`);
}

const latest = new Map(fs.readFileSync(OUT, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).map((r) => [r.bug, r]));
let queue = [...latest.values()].filter((r) => r.stage === "reproduced").map((r) => r.bug);
if (only) queue = queue.filter((b) => only.split(",").includes(b));
console.log(`[deeptrace] ${queue.length} bugs, ${jobs} at a time`);
if (passing)
  execFileSync("node", [path.join(REPO, "node_modules", "esbuild", "bin", "esbuild"), path.join(REPO, "bench", "related.ts"), "--bundle", "--platform=node", "--format=cjs", `--outfile=${path.join(REPO, "bench", ".dist", "related.cjs")}`, "--external:@relate/relate", "--external:typescript", "--log-level=error"], { cwd: REPO });
await Promise.all(Array.from({ length: jobs }, async () => { while (queue.length) await (passing ? recordPassing : record)(queue.shift()); }));
console.log("[deeptrace] done");
