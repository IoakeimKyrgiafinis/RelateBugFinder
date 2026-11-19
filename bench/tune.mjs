#!/usr/bin/env node
// Re-weight Blast Radius offline from the per-candidate signals that bench/rescore.mjs saved
// (../bench-cache/features), and pick weights on a DEV half of the bugs only. The HELD-OUT half
// is reported but never used for choosing, so its numbers are an honest estimate.
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
  bugs.push({ bug: r.bug, dev: isDev(r.bug), assert: !r.message || /^AssertionError/.test(r.message), truth: new Set(d.truth), asOf: d.asOf, features: d.features ?? [] });
}

function rank(b, P) {
  const decay = (ts) => Math.pow(0.5, Math.max(0, b.asOf - ts) / 3600 / P.HALF_LIFE_H);
  const scored = [];
  for (const c of b.features) {
    let rec = P.BASELINE;
    if (c.dirty) rec = P.DIRTY;
    if (c.fnTs != null) rec = Math.max(rec, P.FN_COMMIT * decay(c.fnTs));
    else if (c.fileTs != null) rec = Math.max(rec, P.FILE_COMMIT * decay(c.fileTs));
    const warm = rec > P.BASELINE || c.origin;
    if (!(c.relation === "crash-site" || c.relation === "in-stack" || warm)) continue;
    const pen = c.kind === "test" ? P.TEST_PENALTY : 1;
    scored.push({ id: c.id, s: Math.round((c.prox * (P.FLOOR + rec)) / (P.FLOOR + P.DIRTY) * pen * 1000) / 10 });
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

export const CURRENT = { HALF_LIFE_H: 72, DIRTY: 1, FN_COMMIT: 0.9, FILE_COMMIT: 0.35, BASELINE: 0.02, FLOOR: 0, TEST_PENALTY: 1 };
const dev = bugs.filter((b) => b.dev), held = bugs.filter((b) => !b.dev);

let best = { P: CURRENT, m: metrics(dev, CURRENT) };
for (const HALF_LIFE_H of [24, 72, 168, 336, 720])
  for (const FLOOR of [0, 0.02, 0.05, 0.1, 0.2, 0.3, 0.5, 1])
    for (const TEST_PENALTY of [1, 0.5, 0.2, 0.1, 0.05])
        for (const FILE_COMMIT of [0.15, 0.35, 0.6]) {
          const P = { ...CURRENT, HALF_LIFE_H, FLOOR, TEST_PENALTY, FILE_COMMIT };
          const m = metrics(dev, P);
          // MRR first, top-3 as the tie-breaker; prefer the simpler (earlier) setting on exact ties.
          if (m.mrr > best.m.mrr + 1e-9 || (Math.abs(m.mrr - best.m.mrr) < 1e-9 && m.top3 > best.m.top3)) best = { P, m };
        }

const fmt = (m) => `n=${String(m.n).padStart(3)}  top1 ${(100 * m.top1).toFixed(0).padStart(3)}%  top3 ${(100 * m.top3).toFixed(0).padStart(3)}%  top5 ${(100 * m.top5).toFixed(0).padStart(3)}%  MRR ${m.mrr.toFixed(3)}`;
const show = (label, P) => {
  console.log(`\n${label}: ${JSON.stringify(P)}`);
  for (const [name, set] of [["dev", dev], ["held-out", held], ["  crashes", held.filter((b) => !b.assert)], ["  asserts", held.filter((b) => b.assert)]]) console.log(`  ${name.padEnd(10)} ${fmt(metrics(set, P))}`);
};
show("Current weights", CURRENT);
show("Best on dev", best.P);
for (const [k, vs] of Object.entries({ HALF_LIFE_H: [168, 720], FLOOR: [0.2, 0.5], TEST_PENALTY: [0.1, 0.5] })) for (const v of vs) { const P = { ...best.P, [k]: v }; console.log(`  ${k}=${v}`.padEnd(22), "dev", fmt(metrics(dev, P)), "| held", fmt(metrics(held, P))); }
