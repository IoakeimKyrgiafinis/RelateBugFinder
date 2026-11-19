#!/usr/bin/env node
// How much slower does the Deep trace recorder make a test run? Times each command plain, with the
// recorder (calls + return values + lines), and with BR_TRACE_LINES=0 (calls + return values only).
//   A  the failing test of benchmark bugs (BugsInPy venvs, Python 3.8: setprofile + settrace path)
//   B  the whole test file that contains it (more code, longer runs)
//   C  CPython standard-library test suites on this machine's Python 3.12+ (sys.monitoring path), with the
//      whole standard library counted as "project code", i.e. everything is recorded: a worst case.
// Usage: node bench/overhead.mjs [--bugs 16] [--reps 3]      → bench/OVERHEAD.md
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = path.resolve(process.env.BENCH_CACHE ?? path.join(REPO, "..", "bench-cache"));
const DATASET = path.join(CACHE, "BugsInPy");
const RECORDER = path.join(REPO, "python", "br_trace");
const WIN = process.platform === "win32";
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const N = Number(arg("bugs", "16")), REPS = Number(arg("reps", "3"));
const NO_PROMPTS = { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_ASKPASS: "echo", SSH_ASKPASS: "echo" };

const readText = (f) => { const b = fs.readFileSync(f); return ((b[0] === 0xff && b[1] === 0xfe) || (b.length > 1 && b[1] === 0) ? b.toString("utf16le") : b.toString("utf8")).replace(/^﻿/, ""); };
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

function time(cmd, cwd, env) {
  const t0 = process.hrtime.bigint();
  spawnSync("bash", ["-c", cmd], { cwd, env, stdio: "ignore", timeout: 900_000 });
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

/** Median ms for plain / recorder / recorder without lines, interleaved so drift hits all three alike. */
function measure(cmd, cwd, baseEnv, root) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "br-ovh-"));
  const rec = { ...baseEnv, BR_TRACE_OUT: tmp, BR_TRACE_ROOT: root, PYTHONPATH: [RECORDER, baseEnv.PYTHONPATH].filter(Boolean).join(path.delimiter) };
  const t = { plain: [], rec: [], noLines: [] };
  time(cmd, cwd, baseEnv); // warm caches (.pyc, disk)
  for (let i = 0; i < REPS; i++) {
    t.plain.push(time(cmd, cwd, baseEnv));
    t.rec.push(time(cmd, cwd, rec));
    t.noLines.push(time(cmd, cwd, { ...rec, BR_TRACE_LINES: "0" }));
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  return { plain: median(t.plain), rec: median(t.rec), noLines: median(t.noLines) };
}

function bugEnv(project, id) {
  const wt = path.join(CACHE, "work", `${project}-${id}`), venv = path.join(CACHE, "venvs", `${project}-${id}`);
  const bin = path.join(venv, WIN ? "Scripts" : "bin");
  return { wt, env: { ...process.env, ...NO_PROMPTS, PATH: bin + path.delimiter + process.env.PATH, VIRTUAL_ENV: venv, PYTHONPATH: wt, PYTHONIOENCODING: "utf-8" } };
}
const failingCmd = (project, id) => {
  const first = readText(path.join(DATASET, "projects", project, "bugs", id, "run_test.sh")).split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith("#")) ?? "pytest";
  return first.replace(/^tox\s+(?:-e\s+\S+\s+)?/, "pytest ").replace(/^pytest\b/, "python -m pytest").replace(/^python3?\b/, "python");
};
/** The whole test file of a failing-test command: pytest node id → its file; unittest id → its module. */
const fileCmd = (cmd) => {
  const pt = /^(python -m pytest)\s+(?:.*\s)?"?([^\s":]+\.py)(?:::[^\s"]*)?"?/.exec(cmd);
  if (pt) return `${pt[1]} -q -p no:cacheprovider ${pt[2]}`;
  const ut = /^(python -m unittest)\s+(?:-\S+\s+)*([\w.]+)$/.exec(cmd);
  if (ut) { const parts = ut[2].split("."); const mod = parts.findIndex((p) => /^test_/.test(p)); return mod >= 0 ? `${ut[1]} -q ${parts.slice(0, mod + 1).join(".")}` : undefined; }
  return undefined;
};

const recs = new Map(fs.readFileSync(path.join(REPO, "bench", "results", "bugsinpy.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).map((r) => [r.bug, r]));
// A spread of projects: round-robin over projects, first bugs of each.
const byProject = new Map();
for (const r of recs.values()) if (r.stage === "reproduced") { const p = r.bug.split(":")[0]; if (!byProject.has(p)) byProject.set(p, []); byProject.get(p).push(r.bug); }
const picked = [];
for (let i = 0; picked.length < N && i < 50; i++) for (const list of byProject.values()) if (list[i] && picked.length < N) picked.push(list[i]);

const rows = { A: [], B: [], C: [] };
for (const bug of picked) {
  const [project, id] = bug.split(":");
  const { wt, env } = bugEnv(project, id);
  const cmd = failingCmd(project, id);
  const a = measure(cmd, wt, env, wt);
  rows.A.push({ name: bug, cmd, ...a });
  console.log(`A ${bug.padEnd(14)} plain ${a.plain.toFixed(0)} ms  rec ${a.rec.toFixed(0)}  no-lines ${a.noLines.toFixed(0)}`);
  const fc = fileCmd(cmd);
  if (fc && rows.B.length < 8) {
    const b = measure(fc, wt, env, wt);
    if (b.plain > 1500) rows.B.push({ name: bug, cmd: fc, ...b }); // only runs long enough to matter
    console.log(`B ${bug.padEnd(14)} plain ${b.plain.toFixed(0)} ms  rec ${b.rec.toFixed(0)}  no-lines ${b.noLines.toFixed(0)}  (${fc})`);
  }
}

// C: this machine's Python, sys.monitoring path, stdlib tests with the whole stdlib recorded.
const pyInfo = spawnSync("python", ["-c", "import sys, sysconfig; print(sys.version.split()[0]); print(sysconfig.get_paths()['stdlib'])"], { encoding: "utf8" }).stdout.trim().split(/\r?\n/);
if (pyInfo.length === 2 && Number(pyInfo[0].split(".")[1]) >= 12) {
  for (const t of ["test_json", "test_difflib", "test_textwrap", "test_statistics"]) {
    const cmd = `python -m test -q ${t}`;
    const c = measure(cmd, REPO, { ...process.env }, pyInfo[1]);
    rows.C.push({ name: `${t} (Python ${pyInfo[0]})`, cmd, ...c });
    console.log(`C ${t.padEnd(16)} plain ${c.plain.toFixed(0)} ms  rec ${c.rec.toFixed(0)}  no-lines ${c.noLines.toFixed(0)}`);
  }
}

const ratio = (r, k) => r[k] / r.plain;
const fmt = (x) => `${x.toFixed(2)}×`;
const sec = (ms) => (ms / 1000).toFixed(1) + " s";
const summary = (set) => set.length ? `median ${fmt(median(set.map((r) => ratio(r, "rec"))))}, worst ${fmt(Math.max(...set.map((r) => ratio(r, "rec"))))} (without lines: median ${fmt(median(set.map((r) => ratio(r, "noLines"))))})` : "–";
let md = `# Deep trace recorder overhead\n\nGenerated by \`node bench/overhead.mjs\` (median of ${REPS} runs each, after one warm-up run; ${new Date().toISOString().slice(0, 10)}, ${os.cpus()[0].model}, ${process.platform}).\nEach command is timed plain, with the recorder (calls + return values + lines), and with \`BR_TRACE_LINES=0\` (calls + return values). Times include interpreter start-up and test collection, as a user would experience them.\n\n`;
const section = (title, note, set) => {
  md += `## ${title}\n\n${note}\n\n**Slowdown: ${summary(set)}**\n\n| Run | Plain | Recorder | ×  | Without lines | × |\n|---|---|---|---|---|---|\n`;
  for (const r of set) md += `| ${r.name} | ${sec(r.plain)} | ${sec(r.rec)} | ${fmt(ratio(r, "rec"))} | ${sec(r.noLines)} | ${fmt(ratio(r, "noLines"))} |\n`;
  md += "\n";
};
section("A. The failing test (what Deep trace re-runs)", "BugsInPy bugs, one per project in turn; Python 3.8 (setprofile + settrace).", rows.A);
section("B. The whole test file", "The file containing the failing test, where it ran for more than 1.5 s; Python 3.8.", rows.B);
section("C. Python 3.12+ (sys.monitoring), worst case", "CPython's own test suites with the *whole standard library* recorded as project code.", rows.C);
fs.writeFileSync(path.join(REPO, "bench", "OVERHEAD.md"), md);
console.log("\n" + md);
