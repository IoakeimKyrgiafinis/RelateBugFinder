/**
 * Spectrum-based fault localization on the runs stored in the graph.
 *
 * A deep trace stores the failing run; related *passing* tests are then run with the same recorder and
 * stored in the same session (Run.session = the failing run's id). A function that ran in the failing run
 * but in few passing ones is more suspicious than one that runs everywhere. Ochiai's formula, computed in
 * Cypher:  ochiai(f) = failed(f) / sqrt(totalFailed · (failed(f) + passed(f)))
 */
import { CodeGraph } from "./graph";

export interface RelatedTest { id: string; file: string; qualifiedName: string; reach: number }

/**
 * Passing tests worth comparing with: test functions that call (≤3 hops) the functions that ran closest
 * to the crash, excluding tests that already ran in the failing run. Most connected first.
 */
export function relatedTests(g: CodeGraph, runId: string, max = 8): RelatedTest[] {
  const hot = g.q(
    "MATCH (:Run {id:$run})-[e:EXECUTED]->(f:Function) WHERE f.isTest = false RETURN f.id AS id ORDER BY e.since ASC LIMIT 30",
    { run: runId }
  ).map((r) => r.id as string);
  if (!hot.length) return [];
  const ranInFailing = new Set(g.q("MATCH (:Run {id:$run})-[:EXECUTED]->(t:Function) WHERE t.isTest = true RETURN t.id AS id", { run: runId }).map((r) => r.id as string));
  const rows = g.q(
    `MATCH (t:Function)-[:CALLS*1..3]->(h:Function)
     WHERE h.id IN $hot AND t.isTest = true AND t.name STARTS WITH 'test'
     RETURN t.id AS id, t.file AS file, t.qualifiedName AS qualifiedName, count(DISTINCT h.id) AS reach
     ORDER BY reach DESC LIMIT $lim`,
    { hot, lim: max * 4 }
  ) as unknown as RelatedTest[];
  return rows.filter((t) => !ranInFailing.has(t.id) && !t.qualifiedName.includes(".<") && t.qualifiedName.split(".").length <= 2).slice(0, max);
}

/** pytest node id for a test function: `tests/test_x.py::TestCls::test_y`. */
export const pytestNodeId = (t: { file: string; qualifiedName: string }) => [t.file, ...t.qualifiedName.split(".")].join("::");

/** unittest id for the same test: `tests.test_x.TestCls.test_y` (unittest needs a class). */
export const unittestId = (t: { file: string; qualifiedName: string }) => (t.qualifiedName.includes(".") ? `${t.file.replace(/\.py$/, "").split("/").join(".")}.${t.qualifiedName}` : undefined);

/**
 * How to run one related test with the same runner as the failing command, or undefined when the
 * command isn't a recognisable Python test run. Keeps the command's own interpreter/prefix, so a venv
 * python path or `uv run` is reused as typed.
 */
export function testCommandFor(failingCommand: string, t: { file: string; qualifiedName: string }): string | undefined {
  const c = failingCommand.trim();
  const ut = /^(.*?\bpython[\d.]*(?:\.exe)?["']?\s+-m\s+unittest)\b/.exec(c);
  if (ut) {
    const id = unittestId(t);
    return id ? `${ut[1]} -q ${id}` : undefined;
  }
  const pt = /^(.*?\b(?:py\.test|pytest)(?:\.exe)?["']?)(?=\s|$)/.exec(c);
  if (pt) return `${pt[1]} -q -p no:cacheprovider "${pytestNodeId(t)}"`;
  return undefined;
}

/** Ochiai score of every function that ran in the session's failing run(s), plus how many runs there were. */
export function ochiai(g: CodeGraph, sessionId: string): { scores: Map<string, { ochiai: number; ef: number; ep: number }>; failed: number; passed: number } {
  const runs = g.q("MATCH (r:Run) WHERE r.id = $s OR r.session = $s RETURN r.failed AS failed", { s: sessionId });
  const failed = runs.filter((r) => r.failed).length;
  const passed = runs.length - failed;
  const scores = new Map<string, { ochiai: number; ef: number; ep: number }>();
  if (!failed) return { scores, failed, passed };
  for (const r of g.q(
    `MATCH (r:Run)-[:EXECUTED]->(f:Function) WHERE r.id = $s OR r.session = $s
     WITH f, sum(CASE WHEN r.failed THEN 1 ELSE 0 END) AS ef, sum(CASE WHEN r.failed THEN 0 ELSE 1 END) AS ep
     WHERE ef > 0
     RETURN f.id AS id, ef, ep, toFloat(ef) / sqrt(toFloat($F) * (ef + ep)) AS ochiai`,
    { s: sessionId, F: failed }
  ))
    scores.set(r.id as string, { ochiai: r.ochiai as number, ef: r.ef as number, ep: r.ep as number });
  return { scores, failed, passed };
}
