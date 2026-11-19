#!/usr/bin/env node
// Re-score every reproduced bug after a change to the ranking, without re-running any project's tests.
// Reuses the cached worktrees and traces from bench/bugsinpy.mjs.   Usage: node bench/rescore.mjs [--jobs 4]
import { execFile, execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { envReason } from "./classify.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = path.resolve(process.env.BENCH_CACHE ?? path.join(REPO, "..", "bench-cache"));
const OUT = path.join(REPO, "bench", "results", "bugsinpy.jsonl");
const EVAL = path.join(REPO, "bench", ".dist", "evaluate.cjs");
const FEAT = path.join(CACHE, "features");
fs.mkdirSync(FEAT, { recursive: true });
const i = process.argv.indexOf("--jobs");
const jobs = i >= 0 ? Number(process.argv[i + 1]) : 4;

execFileSync("node", [path.join(REPO, "node_modules", "esbuild", "bin", "esbuild"), path.join(REPO, "bench", "evaluate.ts"), "--bundle", "--platform=node", "--format=cjs", `--outfile=${EVAL}`, "--external:@relate/relate", "--external:typescript", "--log-level=error"], { cwd: REPO });

const latest = new Map(fs.readFileSync(OUT, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).map((r) => [r.bug, r]));
const todo = [...latest.values()].filter((r) => r.stage === "reproduced" || (r.stage === "env-error" && r.envReason && r.envReason !== "no frame in the project's code"));
const KEYS = ["index", "message", "frames", "framesInWorkspace", "crashSite", "crashInTest", "valueOrigin", "truth", "truthModuleLevelOnly", "truthChangedInWindow", "truthOnStack", "ranks", "candidates", "top", "error"];

async function rescore(r) {
  const [project, id] = r.bug.split(":");
  const wt = path.join(CACHE, "work", `${project}-${id}`);
  const trace = path.join(CACHE, "traces", `${project}-${id}.txt`);
  const patch = path.join(CACHE, "BugsInPy", "projects", project, "bugs", id, "bug_patch.txt");
  const asOf = Math.floor(Date.parse(r.asOf) / 1000);
  const out = await new Promise((res) => execFile("node", [EVAL, wt, trace, patch, String(asOf), path.join(FEAT, `${project}-${id}.json`)], { cwd: REPO, maxBuffer: 64 << 20, timeout: 600_000 }, (_e, so) => res(String(so ?? ""))));
  let j;
  try { j = JSON.parse(out.trim().split("\n").pop()); } catch { j = { error: out.slice(-1500) }; }
  for (const k of KEYS) delete r[k];
  Object.assign(r, j);
  r.stage = "reproduced";
  delete r.envReason;
  const env = envReason(r, fs.readFileSync(trace, "utf8"));
  if (env) { r.stage = "env-error"; r.envReason = env; }
  const k = r.ranks ?? {};
  console.log(`${r.bug.padEnd(16)} commits=${String(r.index?.commitsInWindow ?? "?").padEnd(4)} blast=${k.blast} stack=${k.stack} sentry=${k.sentry} recent=${k.recent}${r.error ? " EVAL-ERROR" : ""}`);
}

const queue = [...todo];
await Promise.all(Array.from({ length: jobs }, async () => { while (queue.length) await rescore(queue.shift()); }));
fs.writeFileSync(OUT, [...latest.values()].map((r) => JSON.stringify(r) + "\n").join(""));
console.log(`rescored ${todo.length} bugs → ${path.relative(REPO, OUT)}`);
