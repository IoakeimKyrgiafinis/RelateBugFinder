#!/usr/bin/env node
// Re-weight Blast Radius offline from the per-candidate signals that bench/rescore.mjs saved
// (../bench-cache/features), and pick weights on a DEV half of the bugs only. The HELD-OUT half
// is reported but never used for choosing, so its numbers are an honest estimate.
//
// Two searches:
//   base   the history/proximity weights (no deep trace), as shipped in src/core/analysis.ts
//   deep   RAN / SINCE_K / NOT_RAN, the weights of a deep trace (recorded re-run), base held fixed
//   Usage: node bench/tune.mjs
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = path.resolve(process.env.BENCH_CACHE ?? path.join(REPO, "..", "bench-cache"));
const FEAT = path.join(CACHE, "features");
const recs = new Map(fs.readFileSync(path.join(REPO, "bench", "results", "bugsinpy.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).map((r) => [r.bug, r]));

// Stable split: FNV-1a of the bug name, even → dev, odd → held-out.
const fnv = (s) => { let h = 0x811c9dc5; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0; return h; };
export const isDev = (bug) => fnv(bug) % 2 === 0;

const bugs = [];
for (const r of recs.values()) {
  if (r.stage !== "reproduced" || !r.truth?.length) continue;
  const f = path.join(FEAT, `${r.bug.replace(":", "-")}.json`);
  if (!fs.existsSync(f)) continue;
  const d = JSON.parse(fs.readFileSync(f, "utf8"));
  bugs.push({ bug: r.bug, dev: isDev(r.bug), deep: !!d.deep, assert: !r.message || /^AssertionError/.test(r.message), truth: new Set(d.truth), asOf: d.asOf, features: d.features ?? [] });
}

/** Mirrors traceSuspects' scoring (src/core/analysis.ts: recency, scoreOf, effectiveProx, warm rule). */
function rank(b, P) {
  const decay = (ts) => Math.pow(0.5, Math.max(0, b.asOf - ts) / 3600 / P.HALF_LIFE_H);
  const useDeep = P.DEEP && b.deep;
  const scored = [];
  for (const c of b.features) {
    if (!useDeep && c.relation === "ran") continue; // only exists because of the deep trace
    let rec = P.BASELINE;
    if (c.dirty) rec = P.DIRTY;
    if (c.fnTs != null) rec = Math.max(rec, P.FN_COMMIT * decay(c.fnTs));
    else if (c.fileTs != null) rec = Math.max(rec, P.FILE_COMMIT * decay(c.fileTs));
    const ran = useDeep ? c.ran : undefined;
    const warm = rec > P.BASELINE || c.origin || c.field || !!ran;
    if (!(c.relation === "crash-site" || c.relation === "in-stack" || warm)) continue;
    let prox = c.prox;
    if (ran === true) prox = Math.max(prox, P.RAN / (1 + c.since / P.SINCE_K));
    else if (ran === false && c.relation !== "crash-site" && c.relation !== "in-stack") prox *= P.NOT_RAN;
    const pen = c.kind === "test" ? P.TEST_PENALTY : 1;
    scored.push({ id: c.id, s: Math.round(((prox * (P.FLOOR + rec)) / (P.FLOOR + P.DIRTY)) * pen * 1000) / 10 });
  }
  scored.sort((a, b) => b.s - a.s);
  const i = scored.findIndex((x) => b.truth.has(x.id));
  return i < 0 ? null : i + 1;
}

const metrics = (set, P) => {
  const ranks = set.map((b) => rank(b, P));
  const at = (k) => ranks.filter((x) => x && x <= k).length / (set.length || 1);
  return { n: set.length, top1: at(1), top3: at(3), top5: at(5), mrr: ranks.reduce((s, x) => s + (x ? 1 / x : 0), 0) / (set.length || 1) };
};
const better = (m, b) => m.mrr > b.mrr + 1e-9 || (Math.abs(m.mrr - b.mrr) < 1e-9 && m.top3 > b.top3);

// As shipped in src/core/analysis.ts SCORING.
export const SHIPPED = { HALF_LIFE_H: 336, DIRTY: 1, FN_COMMIT: 0.9, FILE_COMMIT: 0.15, BASELINE: 0.02, FLOOR: 0.3, TEST_PENALTY: 0.2, DEEP: false, RAN: 0.2, SINCE_K: 2, NOT_RAN: 1 };
const dev = bugs.filter((b) => b.dev), held = bugs.filter((b) => !b.dev);

let base = { P: SHIPPED, m: metrics(dev, SHIPPED) };
for (const HALF_LIFE_H of [72, 168, 336, 720])
  for (const FLOOR of [0.1, 0.2, 0.3, 0.5, 1])
    for (const TEST_PENALTY of [0.5, 0.2, 0.1])
      for (const FILE_COMMIT of [0.15, 0.35]) {
        const P = { ...SHIPPED, HALF_LIFE_H, FLOOR, TEST_PENALTY, FILE_COMMIT };
        const m = metrics(dev, P);
        if (better(m, base.m)) base = { P, m };
      }

const deepStart = { ...SHIPPED, DEEP: true };
let deep = { P: deepStart, m: metrics(dev, deepStart) };
for (const RAN of [0.2, 0.3, 0.5, 0.7, 1])
  for (const SINCE_K of [2, 5, 10, 20, 50, 200])
    for (const NOT_RAN of [1, 0.5, 0.3, 0.1]) {
      const P = { ...SHIPPED, DEEP: true, RAN, SINCE_K, NOT_RAN };
      const m = metrics(dev, P);
      if (better(m, deep.m)) deep = { P, m };
    }

const fmt = (m) => `n=${String(m.n).padStart(3)}  top1 ${(100 * m.top1).toFixed(0).padStart(3)}%  top3 ${(100 * m.top3).toFixed(0).padStart(3)}%  top5 ${(100 * m.top5).toFixed(0).padStart(3)}%  MRR ${m.mrr.toFixed(3)}`;
const show = (label, P) => {
  console.log(`\n${label}: ${JSON.stringify(P)}`);
  for (const [name, set] of [["dev", dev], ["held-out", held], ["  crashes", held.filter((b) => !b.assert)], ["  asserts", held.filter((b) => b.assert)]]) console.log(`  ${name.padEnd(10)} ${fmt(metrics(set, P))}`);
};
console.log(`${bugs.length} bugs, ${bugs.filter((b) => b.deep).length} with a deep trace`);
show("Shipped, no deep trace", SHIPPED);
show("Best base weights on dev (no deep trace)", base.P);
show("Shipped + deep trace", deepStart);
show("Best deep-trace weights on dev", deep.P);
for (const [k, vs] of Object.entries({ RAN: [0.3, 0.7], SINCE_K: [5, 50], NOT_RAN: [0.1, 1] })) for (const v of vs) {
  const P = { ...deep.P, [k]: v };
  console.log(`  ${k}=${v}`.padEnd(16), "dev", fmt(metrics(dev, P)), "| held", fmt(metrics(held, P)));
}
