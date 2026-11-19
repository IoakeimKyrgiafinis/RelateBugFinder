#!/usr/bin/env node
/**
 * Real-bug benchmark on BugsInPy (Widyasari et al., ESEC/FSE 2020): 493 real bugs from 17 Python projects,
 * each with the buggy commit, the fix commit and the test that exposes the bug.
 *
 *   node bench/bugsinpy.mjs [--projects thefuck,httpie] [--only thefuck:3] [--jobs 4] [--max 5]
 *
 * For every bug:
 *   1. git worktree at the buggy commit, with the project's real history (so recency is authentic)
 *   2. bring in the failing test file(s) from the fix commit, committed with an OLD date so the test
 *      itself carries no recency signal (the developer didn't have it; the bug report did)
 *   3. uv venv + the bug's pinned requirements, run the failing test, keep its output if it fails
 *   4. bench/evaluate.ts ranks suspects with the clock pinned to the buggy commit's time (+1h)
 *
 * Caches (clones, worktrees, venvs) live in $BENCH_CACHE (default: ../bench-cache, outside the repo).
 * Results: bench/results/bugsinpy.jsonl (one line per bug, including failures and why).
 */
import { execFileSync, spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = path.resolve(process.env.BENCH_CACHE ?? path.join(REPO, "..", "bench-cache"));
const DATASET = path.join(CACHE, "BugsInPy");
const OUT = path.join(REPO, "bench", "results", "bugsinpy.jsonl");
const WIN = process.platform === "win32";

const DEFAULT_PROJECTS = ["thefuck", "PySnooper", "httpie", "tqdm", "cookiecutter", "black", "youtube-dl", "fastapi", "tornado", "sanic", "luigi", "scrapy"];
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const projects = arg("projects", DEFAULT_PROJECTS.join(",")).split(",");
const only = arg("only");
const jobs = Number(arg("jobs", "3"));
const max = Number(arg("max", "1000"));
const PYTHON_VERSION = arg("python", "3.8");
let PYTHON = PYTHON_VERSION; // resolved to a full interpreter path at startup (one download, no races)

// Never let anything the benchmark runs (git, pip, tox, pre-commit) open a login prompt or window:
// old projects reference repos that moved or went private (e.g. flake8's old GitLab home).
const NO_PROMPTS = { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_ASKPASS: "echo", SSH_ASKPASS: "echo", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "credential.helper", GIT_CONFIG_VALUE_0: "" };
Object.assign(process.env, NO_PROMPTS); // inherited by every child process below

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20, ...opts });
const git = (cwd, ...args) => sh("git", args, { cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });

/** Some BugsInPy files were saved as UTF-16 on Windows. */
function readText(file) {
  const b = fs.readFileSync(file);
  if ((b[0] === 0xff && b[1] === 0xfe) || (b.length > 1 && b[1] === 0)) return b.toString("utf16le").replace(/^﻿/, "");
  return b.toString("utf8").replace(/^﻿/, "");
}

function info(file) {
  const o = {};
  for (const m of readText(file).matchAll(/(\w+)="([^"]*)"/g)) o[m[1]] = m[2];
  return o;
}

function run(cmd, args, opts) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { ...opts, windowsHide: true });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    const t = setTimeout(() => { p.kill(); out += "\n[bench] TIMEOUT"; }, opts.timeout ?? 600_000);
    p.on("close", (code) => { clearTimeout(t); resolve({ code, out }); });
    p.on("error", (e) => { clearTimeout(t); resolve({ code: -1, out: String(e) }); });
  });
}

// Clones are shared per project; serialise clone/worktree operations per project.
const locks = new Map();
const withLock = (key, fn) => { const p = (locks.get(key) ?? Promise.resolve()).then(fn, fn); locks.set(key, p.catch(() => {})); return p; };

async function prepare(project, id, meta) {
  const clone = path.join(CACHE, "repos", project);
  const wt = path.join(CACHE, "work", `${project}-${id}`);
  await withLock(project, async () => {
    if (!fs.existsSync(clone)) {
      fs.mkdirSync(path.dirname(clone), { recursive: true });
      sh("git", ["clone", "-q", meta.project.github_url, clone], { timeout: 900_000 });
    }
    try { git(clone, "cat-file", "-e", `${meta.bug.fixed_commit_id}^{commit}`); } catch { git(clone, "fetch", "-q", "origin"); }
    if (fs.existsSync(wt)) {
      try { git(clone, "worktree", "remove", "--force", wt); } catch { fs.rmSync(wt, { recursive: true, force: true }); git(clone, "worktree", "prune"); }
    }
    git(clone, "worktree", "add", "-q", "--detach", wt, meta.bug.buggy_commit_id);
  });
  git(wt, "config", "core.autocrlf", "false");
  const buggyTs = Number(git(wt, "show", "-s", "--format=%ct", "HEAD").trim());
  const asOf = buggyTs + 3600;
  // The failing test(s) from the fix, committed with an old date: present, but not "recent".
  const tests = meta.bug.test_file.split(";").map((s) => s.trim()).filter(Boolean);
  for (const t of tests) {
    try { git(wt, "checkout", meta.bug.fixed_commit_id, "--", t); } catch { /* file may not exist in fix */ }
  }
  const old = new Date((asOf - 400 * 86400) * 1000).toISOString();
  git(wt, "add", "-A");
  try {
    sh("git", ["-c", "user.name=bench", "-c", "user.email=bench@example.com", "commit", "-q", "-m", "bench: failing test from the fix"], { cwd: wt, env: { ...process.env, GIT_AUTHOR_DATE: old, GIT_COMMITTER_DATE: old } });
  } catch { /* nothing to commit */ }
  return { wt, asOf };
}

async function reproduce(project, id, meta, wt) {
  const bugDir = path.join(DATASET, "projects", project, "bugs", id);
  const venv = path.join(CACHE, "venvs", `${project}-${id}`); // outside the worktree: not "untracked changes"
  const bin = path.join(venv, WIN ? "Scripts" : "bin");
  let r = await run("uv", ["venv", "-q", "--clear", "--python", PYTHON, venv], { cwd: wt, timeout: 300_000 });
  if (r.code !== 0) return { stage: "venv", detail: r.out.slice(-800) };
  const reqFile = path.join(bugDir, "requirements.txt");
  const reqs = fs.existsSync(reqFile) ? readText(reqFile).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && !/^-e\s/.test(l)) : [];
  const base = ["pytest"];
  // Install one by one (like BugsInPy's own compile script) so one unavailable pin doesn't sink the rest.
  r = await run("uv", ["pip", "install", "-q", "--python", venv, ...base], { cwd: wt, timeout: 600_000 });
  const failed = [];
  for (const req of reqs) {
    const x = await run("uv", ["pip", "install", "-q", "--python", venv, req], { cwd: wt, timeout: 600_000 });
    if (x.code !== 0) {
      const loose = req.replace(/==.*$/, ""); // pinned version unavailable on this Python → unpinned
      const y = await run("uv", ["pip", "install", "-q", "--python", venv, loose], { cwd: wt, timeout: 600_000 });
      if (y.code !== 0) failed.push(req);
    }
  }
  // Era-appropriate setuptools: new ones vendor libraries that crash against old pinned deps (e.g. importlib-metadata).
  await run("uv", ["pip", "install", "-q", "--python", venv, "setuptools<58"], { cwd: wt, timeout: 600_000 });
  const setup = path.join(bugDir, "setup.sh");
  const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH, VIRTUAL_ENV: venv, PYTHONPATH: wt, PYTHONIOENCODING: "utf-8", PYTHONDONTWRITEBYTECODE: "1" };
  if (fs.existsSync(setup)) await run("bash", [setup], { cwd: wt, env, timeout: 600_000 });
  const cmds = readText(path.join(bugDir, "run_test.sh")).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  let out = "";
  let anyFailed = false;
  for (const c of cmds) {
    // Run the test the way the project's maintainers ran it, with the venv's python.
    const cmd = c.replace(/^tox\s+(?:-e\s+\S+\s+)?/, "pytest ").replace(/^pytest\b/, "python -m pytest").replace(/^python3?\b/, "python");
    const x = await run("bash", ["-c", cmd], { cwd: wt, env, timeout: 600_000 });
    out += `$ ${c}\n${x.out}\n`;
    if (x.code !== 0) anyFailed = true;
  }
  return { stage: anyFailed ? "reproduced" : "test-passed", out, failedReqs: failed };
}

async function evaluate(wt, traceFile, patch, asOf) {
  const r = await run("node", [path.join(REPO, "bench", ".dist", "evaluate.cjs"), wt, traceFile, patch, String(asOf)], { cwd: REPO, timeout: 600_000 });
  try { return JSON.parse(r.out.trim().split("\n").pop()); } catch { return { error: r.out.slice(-1500) }; }
}

async function one(project, id) {
  const t0 = Date.now();
  const bugDir = path.join(DATASET, "projects", project, "bugs", id);
  const meta = { bug: info(path.join(bugDir, "bug.info")), project: info(path.join(DATASET, "projects", project, "project.info")) };
  const rec = { bug: `${project}:${id}`, buggy: meta.bug.buggy_commit_id, fixed: meta.bug.fixed_commit_id, test: meta.bug.test_file };
  try {
    const { wt, asOf } = await prepare(project, id, meta);
    rec.asOf = new Date(asOf * 1000).toISOString();
    const rep = await reproduce(project, id, meta, wt);
    rec.stage = rep.stage;
    if (rep.failedReqs?.length) rec.failedReqs = rep.failedReqs;
    if (rep.out) {
      const traceFile = path.join(CACHE, "traces", `${project}-${id}.txt`);
      fs.mkdirSync(path.dirname(traceFile), { recursive: true });
      fs.writeFileSync(traceFile, rep.out);
      rec.traceTail = rep.out.slice(-600);
      if (rep.stage === "reproduced") Object.assign(rec, await evaluate(wt, traceFile, path.join(bugDir, "bug_patch.txt"), asOf));
      // A failure with no frame in the project's own code is the environment breaking, not the bug.
      if (rec.stage === "reproduced" && rec.framesInWorkspace === 0) rec.stage = "env-error";
    } else rec.detail = rep.detail;
  } catch (e) {
    rec.stage = "error";
    rec.detail = String(e.stderr || e.message || e).slice(-1500);
  }
  rec.seconds = Math.round((Date.now() - t0) / 1000);
  fs.appendFileSync(OUT, JSON.stringify(rec) + "\n");
  const rk = rec.ranks ? ` blast=${rec.ranks.blast} stack=${rec.ranks.stack} sentry=${rec.ranks.sentry} recent=${rec.ranks.recent}` : "";
  console.log(`${rec.bug.padEnd(16)} ${String(rec.stage).padEnd(12)} ${rec.seconds}s${rk}${rec.error ? " EVAL-ERROR" : ""}`);
}

// ---------------------------------------------------------------- main
try { execFileSync("uv", ["python", "install", PYTHON_VERSION], { stdio: "ignore" }); } catch { /* already there, or a harmless link warning */ }
PYTHON = sh("uv", ["python", "find", PYTHON_VERSION]).trim();
if (!fs.existsSync(DATASET)) {
  fs.mkdirSync(CACHE, { recursive: true });
  sh("git", ["clone", "-q", "--depth", "1", "https://github.com/soarsmu/BugsInPy.git", DATASET], { timeout: 600_000 });
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
sh("node", [path.join(REPO, "node_modules", "esbuild", "bin", "esbuild"), path.join(REPO, "bench", "evaluate.ts"), "--bundle", "--platform=node", "--format=cjs", `--outfile=${path.join(REPO, "bench", ".dist", "evaluate.cjs")}`, "--external:@relate/relate", "--external:typescript", "--log-level=error"], { cwd: REPO });

const done = new Set(fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).bug) : []);
let queue = [];
for (const p of projects) {
  const dir = path.join(DATASET, "projects", p, "bugs");
  if (!fs.existsSync(dir)) continue;
  for (const id of fs.readdirSync(dir).sort((a, b) => Number(a) - Number(b))) queue.push([p, id]);
}
if (only) queue = queue.filter(([p, id]) => only.split(",").includes(`${p}:${id}`));
queue = queue.filter(([p, id]) => only || !done.has(`${p}:${id}`)).slice(0, max);
console.log(`[bench] ${queue.length} bugs, ${jobs} at a time, cache ${CACHE}`);
await Promise.all(Array.from({ length: jobs }, async () => { while (queue.length) await one(...queue.shift()); }));
console.log("[bench] done →", path.relative(REPO, OUT));
