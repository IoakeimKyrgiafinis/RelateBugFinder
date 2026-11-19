/**
 * Score one reproduced bug.
 *
 *   node bench/.dist/evaluate.cjs <workspace> <trace.txt> <fix.patch> <asOfEpochSec>
 *
 * Indexes the workspace exactly as the extension would (in memory), with the clock pinned to the moment
 * the bug was hit, then ranks functions four ways and reports where the truly-fixed function lands:
 *
 *   blast   Blast Radius (stack + call graph + function-level git recency + value origin)
 *   stack   read the stack trace top-down (crash site first)
 *   sentry  stack frames only, most recently changed first (Sentry "suspect commits" style)
 *   recent  every function, most recently changed first (ignores the trace)
 *
 * Ground truth: functions whose lines the real fix changed (old side of the patch), excluding tests.
 */
import * as fs from "fs";
import * as path from "path";
import { CodeGraph, TEST_FILE_RE } from "../src/core/graph";
import { Workspace } from "../src/core/workspace";
import { functionAtLine, traceSuspects } from "../src/core/analysis";
import { pinClock } from "../src/core/clock";
import { readRecords, recordRun } from "../src/core/deepTrace";

async function main() {
  const [root, traceFile, patchFile, asOfStr, featuresFile, deepDir] = process.argv.slice(2);
  const asOf = Number(asOfStr);
  pinClock(asOf);
  const g = CodeGraph.open(":memory:");
  const ws = new Workspace(root, g, { pythonPath: process.env.BENCH_INDEX_PYTHON || "python", pythonScript: path.join(__dirname, "..", "..", "python", "py_index.py"), gitSinceDays: 30 });
  const stats = await ws.fullIndex();
  const trace = fs.readFileSync(traceFile, "utf8");

  // ---- ground truth
  const changed = parsePatch(fs.readFileSync(patchFile, "utf8"));
  const truth = new Set<string>();
  let moduleOnly = false;
  for (const [file, ranges] of changed) {
    if (TEST_FILE_RE.test(file)) continue;
    for (const [a, b] of ranges) {
      const rows = g.q(
        `MATCH (f:Function {file:$file}) WHERE f.kind <> 'module' AND f.startLine <= $b AND f.endLine >= $a RETURN f.id AS id, f.startLine AS s, f.endLine AS e`,
        { file, a, b }
      );
      // Innermost function(s) only: a nested helper's change shouldn't also credit its enclosing function.
      const inner = rows.filter((r) => !rows.some((o) => o !== r && (o.s as number) >= (r.s as number) && (o.e as number) <= (r.e as number) && (o.e as number) - (o.s as number) < (r.e as number) - (r.s as number)));
      if (!rows.length) moduleOnly = true;
      for (const r of inner) truth.add(r.id as string);
    }
  }

  // ---- rankings
  const r = traceSuspects(g, root, trace, 500, { features: !!featuresFile });
  const blast = r.suspects.map((s) => s.id);
  // Same, after a deep trace (a recorded re-run of the failing test), when one was recorded.
  const records = deepDir && fs.existsSync(deepDir) ? readRecords(deepDir) : [];
  const run = records.length ? recordRun(g, root, records, { command: "bench", failed: true }) : undefined;
  const rd = run ? traceSuspects(g, root, trace, 500, { features: !!featuresFile, run: run.runId }) : undefined;
  const blastDeep = rd?.suspects.map((s) => s.id);
  // Then spectrum-based: add the related passing tests' recordings (bench/deeptrace.mjs --passing) to the same session.
  const passingFile = deepDir ? path.join(deepDir, "passing.json") : "";
  const passing: { command: string; dir: string; exitCode: number | null }[] = run && fs.existsSync(passingFile) ? JSON.parse(fs.readFileSync(passingFile, "utf8")) : [];
  let passRuns = 0;
  for (const p of passing) {
    // Only tests that passed are a contrast; one that failed or errored (often the environment) is skipped.
    if (p.exitCode !== 0) continue;
    const recs = readRecords(path.join(deepDir, p.dir));
    if (!recs.length) continue;
    recordRun(g, root, recs, { command: p.command, failed: p.exitCode !== 0, session: run!.runId });
    passRuns++;
  }
  const rs = passRuns ? traceSuspects(g, root, trace, 500, { features: !!featuresFile, run: run!.runId }) : undefined;
  const blastSbfl = rs?.suspects.map((s) => s.id);

  const stack: string[] = [];
  for (const f of r.frames) {
    if (!f.relPath) continue;
    const fn = functionAtLine(g, f.relPath, f.line);
    if (fn && !stack.includes(fn.id)) stack.push(fn.id);
  }
  const lastTouch = new Map<string, number>(
    g.q("MATCH (c:Commit)-[:TOUCHED]->(f:Function) RETURN f.id AS id, max(c.ts) AS ts").map((x) => [x.id as string, x.ts as number])
  );
  const dirty = new Set(g.q("MATCH (f:Function) WHERE f.dirty = true RETURN f.id AS id").map((x) => x.id as string));
  const recencyKey = (id: string) => (dirty.has(id) ? Infinity : lastTouch.get(id) ?? -Infinity);
  const sentry = stack.map((id, i) => ({ id, i })).sort((a, b) => recencyKey(b.id) - recencyKey(a.id) || a.i - b.i).map((x) => x.id);
  const recent = [...lastTouch.keys(), ...dirty].filter((id, i, a) => a.indexOf(id) === i && !TEST_FILE_RE.test(id.split("#")[0])).sort((a, b) => recencyKey(b) - recencyKey(a));

  const rankOf = (list: string[]) => {
    const i = list.findIndex((id) => truth.has(id));
    return i < 0 ? null : i + 1;
  };
  const top = r.suspects.slice(0, 5).map((s) => ({ id: s.id, score: s.score, why: s.reasons.map((x) => x.text) }));
  if (featuresFile) fs.writeFileSync(featuresFile, JSON.stringify({ asOf, truth: [...truth], stack, features: (rs ?? rd ?? r).features, deep: !!rd, sbfl: !!rs }));
  const truthTouched = [...truth].some((id) => lastTouch.has(id) || dirty.has(id));

  console.log(
    JSON.stringify({
      index: { files: stats.files, functions: stats.functions, calls: stats.calls, commitsInWindow: stats.gitCommits, pythonSkipped: stats.pythonSkipped },
      message: r.note,
      frames: r.frames.length,
      framesInWorkspace: r.frames.filter((f) => f.relPath).length,
      crashSite: r.crashSite?.id,
      crashInTest: r.crashSite ? TEST_FILE_RE.test(r.crashSite.file) : undefined,
      valueOrigin: r.valueOrigin?.summary,
      truth: [...truth],
      truthModuleLevelOnly: truth.size === 0 && moduleOnly,
      truthChangedInWindow: truthTouched,
      truthOnStack: [...truth].some((id) => stack.includes(id)),
      ranks: { blast: rankOf(blast), blastDeep: blastDeep ? rankOf(blastDeep) : undefined, blastSbfl: blastSbfl ? rankOf(blastSbfl) : undefined, stack: rankOf(stack), sentry: rankOf(sentry), recent: rankOf(recent) },
      deep: run ? { functionsRan: run.functions, truthRan: [...truth].some((id) => records.length > 0 && rd!.suspects.some((s) => s.id === id && s.reasons.some((x) => x.kind === "ran"))) } : undefined,
      sbfl: rs ? { passingRuns: passRuns } : undefined,
      topDeep: rd?.suspects.slice(0, 5).map((s) => ({ id: s.id, score: s.score, why: s.reasons.map((x) => x.text) })),
      candidates: { blast: blast.length, stack: stack.length },
      top,
    })
  );
}

/**
 * Exact old-side (buggy) lines the fix touched, per file. Context lines are skipped; a pure insertion
 * blames the old lines on both sides of where it was inserted.
 */
function parsePatch(text: string): Map<string, [number, number][]> {
  const out = new Map<string, [number, number][]>();
  let file: string | undefined;
  let old = 0; // next old-side line number inside the current hunk
  let inHunk = false;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("diff --git")) { inHunk = false; continue; }
    if (!inHunk && line.startsWith("--- ")) {
      const p = line.slice(4).trim();
      file = p === "/dev/null" ? undefined : p.replace(/^a\//, "");
      if (file && !out.has(file)) out.set(file, []);
      continue;
    }
    const h = /^@@ -(\d+)(?:,\d+)? /.exec(line);
    if (h) { old = Number(h[1]); inHunk = true; continue; }
    if (!inHunk || !file) continue;
    if (line.startsWith("-")) { out.get(file)!.push([old, old]); old++; }
    else if (line.startsWith("+")) out.get(file)!.push([Math.max(1, old - 1), old]);
    else if (line.startsWith(" ") || line === "") old++;
    else if (line.startsWith("\\")) continue; // "\ No newline at end of file"
    else inHunk = false;
  }
  return out;
}

main().catch((e) => {
  console.log(JSON.stringify({ error: String(e?.stack ?? e) }));
  process.exit(1);
});
