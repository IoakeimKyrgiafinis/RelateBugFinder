import { CodeGraph, Row, TEST_FILE_RE } from "./graph";
import { mapToWorkspace, parseStackTrace } from "./stackTrace";
import { BlastNode, BlastResult, Suspect, SuspectReason, TraceResult } from "./types";
import { findValueOrigin, parseNullishError } from "./valueOrigin";
import { nowSec } from "./clock";
import { executedIn } from "./deepTrace";

/**
 * Suspect score = proximity × (0.3 + recency) / 1.3, × 0.2 for test code, shown as 0–100.
 * Deliberately simple and explainable:
 *
 *   recency   1.0                       uncommitted edits inside the function
 *             0.9 · ½^(age / 14d)       a commit's diff hunk overlaps the function
 *             0.15 · ½^(age / 14d)      only the *file* changed (function untouched)
 *             0.02                      nothing changed recently
 *   floor     0.3                       so a cold crash site still beats a warm but distant neighbour
 *   tests     × 0.2                     kept (they explain the failure) but a fix is rarely in the test
 *   proximity 1.0                       crash site (top in-workspace frame)
 *             1 / (1 + 0.5·i)           i-th frame further down the stack
 *             1 / (1 + hops)            static caller N hops upstream (max 5)
 *             0.8 / (1 + hops)          callee N hops downstream of the crash site (max 2) — a changed helper often *is* the bug
 *             0.4 × frame proximity     direct callee of another stack frame (its result may have flowed into the crash)
 *             1.0                       the call that produced the undefined/null value read at the crash site
 *             0.9                       the caller that passed an undefined/null argument (see valueOrigin.ts)
 *             0.6 / 0.5                 a method that sets the missing/empty field / the constructor if none does
 *             0.4                       a method of the crash's class that changes a field the crash line reads
 *             0.3                       another method of the class, or function of the module, that lacked an attribute
 *   (0.4 / 0.3 links sit below the crash site; they lead mostly when the stack ends inside a test.)
 */
// Weights picked on the DEV half of the BugsInPy benchmark only (bench/tune.mjs); see bench/RESULTS.md.
export const SCORING = { HALF_LIFE_H: 336, DIRTY: 1.0, FN_COMMIT: 0.9, FILE_COMMIT: 0.15, BASELINE: 0.02, FLOOR: 0.3, TEST_PENALTY: 0.2, UP_HOPS: 5, DOWN_HOPS: 2, SIBLING: 0.4, ORIGIN: 1.0, FIELD_WRITER: 0.6, FIELD_INIT: 0.5, FIELD_READ: 0.4, MEMBER: 0.3, RAN: 0.2, SINCE_K: 2, NOT_RAN: 1 };

const now = nowSec;
const decay = (ts: number) => Math.pow(0.5, Math.max(0, now() - ts) / 3600 / SCORING.HALF_LIFE_H);

export function ago(ts: number): string {
  const s = Math.max(0, now() - ts);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

interface FnRow { id: string; name: string; file: string; startLine: number; endLine: number }

function indexedFiles(g: CodeGraph): string[] {
  return g.q("MATCH (f:File) WHERE f.loc IS NOT NULL RETURN f.path AS p").map((r) => r.p as string);
}

export function functionAtLine(g: CodeGraph, file: string, line: number): FnRow | undefined {
  const r = g.q(
    `MATCH (f:Function {file:$file}) WHERE f.startLine <= $line AND f.endLine >= $line
     RETURN f.id AS id, f.name AS name, f.file AS file, f.startLine AS startLine, f.endLine AS endLine, f.kind AS kind
     ORDER BY f.endLine - f.startLine ASC LIMIT 1`,
    { file, line }
  );
  return r[0] as unknown as FnRow | undefined;
}

// ------------------------------------------------------------------ trace

/** Raw per-candidate signals, so the benchmark can re-weight scores offline without re-indexing. */
export interface CandidateFeatures { id: string; relation: Suspect["relation"]; prox: number; kind: FileKind; dirty: boolean; fnTs: number | null; fileTs: number | null; origin: boolean; field: boolean; ran: boolean | null; since: number | null }

export function traceSuspects(g: CodeGraph, root: string, traceText: string, limit = 12, opts: { features?: boolean; run?: string } = {}): TraceResult & { features?: CandidateFeatures[] } {
  const features: CandidateFeatures[] = [];
  const parsed = parseStackTrace(traceText);
  const files = indexedFiles(g);
  for (const f of parsed.frames) f.relPath = mapToWorkspace(f.file, root, files);
  const inWs = parsed.frames.filter((f) => f.relPath);
  if (!inWs.length)
    return { frames: parsed.frames, suspects: [], edges: [], note: parsed.frames.length ? "No stack frame points into this workspace." : "No stack frames found in the text." };

  // 1. Stack frames → functions.
  const cand = new Map<string, { fn: FnRow; relation: Suspect["relation"]; prox: number; hops: number; reasons: SuspectReason[] }>();
  inWs.forEach((fr, i) => {
    const fn = functionAtLine(g, fr.relPath!, fr.line);
    if (!fn || cand.has(fn.id)) return;
    cand.set(fn.id, {
      fn,
      relation: cand.size === 0 ? "crash-site" : "in-stack",
      prox: cand.size === 0 ? 1 : 1 / (1 + 0.5 * i),
      hops: 0,
      reasons: [{ kind: "in-stack", text: cand.size === 0 ? `Error thrown here (${fr.relPath}:${fr.line})` : `On the stack, frame #${i + 1} (${fr.relPath}:${fr.line})` }],
    });
  });
  const crash = [...cand.values()][0];
  if (!crash) return { frames: parsed.frames, suspects: [], edges: [], note: "Frames map to files that have no indexed functions." };
  const stackIds = [...cand.keys()];

  // 2. Static upstream callers (who could pass bad input) and downstream callees (helpers whose change could break us).
  const up = g.q(
    `MATCH (c:Function) WHERE c.id IN $ids
     MATCH p=(u:Function)-[:CALLS*1..${SCORING.UP_HOPS}]->(c)
     WHERE NOT u.id IN $ids AND u.kind <> 'module'
     WITH u, min(length(p)) AS hops
     RETURN u.id AS id, u.name AS name, u.file AS file, u.startLine AS startLine, u.endLine AS endLine, hops`,
    { ids: stackIds }
  );
  const down = g.q(
    `MATCH (c:Function {id:$id})
     MATCH p=(c)-[:CALLS*1..${SCORING.DOWN_HOPS}]->(d:Function)
     WHERE NOT d.id IN $ids
     WITH d, min(length(p)) AS hops
     RETURN d.id AS id, d.name AS name, d.file AS file, d.startLine AS startLine, d.endLine AS endLine, hops`,
    { id: crash.fn.id, ids: stackIds }
  );
  for (const r of up) {
    const hops = r.hops as number;
    cand.set(r.id as string, { fn: r as unknown as FnRow, relation: "upstream", prox: 1 / (1 + hops), hops, reasons: [{ kind: "caller", text: `Calls into the stack ${hops} hop${hops > 1 ? "s" : ""} upstream` }] });
  }
  for (const r of down) {
    if (cand.has(r.id as string)) continue;
    const hops = r.hops as number;
    cand.set(r.id as string, { fn: r as unknown as FnRow, relation: "downstream", prox: 0.8 / (1 + hops), hops, reasons: [{ kind: "callee", text: `Called by the crash site ${hops} hop${hops > 1 ? "s" : ""} down` }] });
  }
  // Helpers called directly by the other stack frames also ran before the crash, and their return value
  // may be what reached the crash site (e.g. summary() calls getRate(), passes it to total()). 1 hop only,
  // scaled by that frame's own proximity, so deeper unrelated work below a frame stays out.
  const frames = [...cand.entries()].filter(([, c]) => c.relation === "in-stack").map(([id, c]) => ({ id, name: c.fn.name, prox: c.prox }));
  if (frames.length) {
    const siblings = g.q(
      `UNWIND $frames AS fr
       MATCH (c:Function {id:fr.id})-[:CALLS]->(d:Function)
       WHERE NOT d.id IN $ids AND d.kind <> 'module'
       RETURN d.id AS id, d.name AS name, d.file AS file, d.startLine AS startLine, d.endLine AS endLine, fr.name AS via, fr.prox AS fprox`,
      { frames, ids: stackIds }
    );
    for (const r of siblings) {
      const prox = SCORING.SIBLING * (r.fprox as number);
      const prev = cand.get(r.id as string);
      if (prev && prev.prox >= prox) continue;
      cand.set(r.id as string, { fn: r as unknown as FnRow, relation: "downstream", prox, hops: 1, reasons: [{ kind: "callee", text: `Called directly by ${r.via}, which is on the stack` }] });
    }
  }

  // 2b. Where did the undefined/null come from? Read the crash line and trace the bad value back.
  const nullish = parseNullishError(parsed.message);
  const valueOrigin = nullish ? findValueOrigin(root, inWs[0].relPath!, inWs[0].line, inWs[0].col, nullish) : undefined;
  if (valueOrigin?.source.kind === "call") {
    const src = valueOrigin.source;
    const hit = g.q(
      `MATCH (:Function {id:$id})-[:CALLS]->(d:Function {name:$name})
       RETURN d.id AS id, d.name AS name, d.file AS file, d.startLine AS startLine, d.endLine AS endLine LIMIT 1`,
      { id: crash.fn.id, name: src.callee }
    )[0];
    if (hit) {
      const prev = cand.get(hit.id as string);
      const reason: SuspectReason = { kind: "value-origin", text: `Produced the ${valueOrigin.value} \`${valueOrigin.expression}\` (${crash.fn.file}:${src.line}: ${src.code})` };
      if (prev) {
        prev.prox = Math.max(prev.prox, SCORING.ORIGIN);
        prev.reasons.unshift(reason);
      } else cand.set(hit.id as string, { fn: hit as unknown as FnRow, relation: "downstream", prox: SCORING.ORIGIN, hops: 1, reasons: [reason] });
    }
  } else if (valueOrigin?.source.kind === "param") {
    // The caller passed the bad value: that's the next frame on the stack.
    const caller = stackIds[1] && cand.get(stackIds[1]);
    if (caller) {
      caller.prox = Math.max(caller.prox, SCORING.ORIGIN * 0.9);
      caller.reasons.unshift({ kind: "value-origin", text: `Passed ${valueOrigin.value} as \`${valueOrigin.source.param}\` to ${valueOrigin.source.fnName}()` });
    }
  }

  // 2c. A field that was missing or empty: the code that should have set it already returned, so it's
  // never on the stack. Rank the methods of that class that assign it, and its constructor.
  const addSignal = (fn: FnRow, prox: number, reason: SuspectReason) => {
    const prev = cand.get(fn.id);
    if (prev) {
      if (prev.prox < prox) prev.prox = prox;
      if (!prev.reasons.some((x) => x.text === reason.text)) prev.reasons.unshift(reason);
    } else cand.set(fn.id, { fn, relation: "downstream", prox, hops: 1, reasons: [reason] });
  };
  const crashQ = crash.fn.id.split("#")[1].replace(/~\d+$/, "");
  const field = missingField(parsed.message, valueOrigin, crashQ);
  if (field) {
    for (const w of fieldWriters(g, field.cls, field.attr, { ctorFallback: true })) {
      const text = w.assigns
        ? `Sets \`${field.self}.${field.attr}\`, which was ${field.how} at the crash (${w.file}:${w.line})`
        : `Constructor of ${field.cls}; nothing in the class sets \`${field.self}.${field.attr}\`, which was ${field.how} at the crash`;
      addSignal(w, w.assigns ? SCORING.FIELD_WRITER : SCORING.FIELD_INIT, { kind: "value-origin", text });
    }
  }

  // 2d. Weaker structural links read from the error itself. Kept even when cold (they are specific to this
  // error), but weighted below the crash site so they only lead when the stack ends in a test.
  //   · fields the crash line reads → methods of the same class that change them (state set earlier)
  //   · 'X' object has no attribute 'y' → the other methods of X
  //   · module 'a.b' has no attribute 'x' → the functions of that module
  for (const f of fieldsReadAt(g, crash.fn.id, inWs[0].line).slice(0, 4)) {
    if (field && f.name === field.attr) continue;
    for (const w of fieldWriters(g, f.cls, f.name, { mutations: true }))
      if (w.id !== crash.fn.id) addSignal(w, SCORING.FIELD_READ, { kind: "field", text: `Changes \`${f.cls}.${f.name}\`, which the crash line reads (${w.file}:${w.line})` });
  }
  if (field && field.how === "missing")
    for (const m of classMethods(g, field.cls)) addSignal(m, SCORING.MEMBER, { kind: "field", text: `Method of ${field.cls}, which had no attribute \`${field.attr}\`` });
  const modAttr = missingModuleAttr(parsed.message);
  if (modAttr) {
    const rel = modAttr.module.replace(/\./g, "/");
    const fns = g.q(
      `MATCH (f:Function) WHERE (f.file = $a OR f.file = $b) AND f.kind <> 'module'
       RETURN f.id AS id, f.name AS name, f.file AS file, f.startLine AS startLine, f.endLine AS endLine`,
      { a: `${rel}.py`, b: `${rel}/__init__.py` }
    ) as unknown as FnRow[];
    for (const f of fns) addSignal(f, SCORING.MEMBER, { kind: "field", text: `In module ${modAttr.module}, which had no attribute \`${modAttr.attr}\`` });
  }

  // 2e. Deep trace: what actually ran in a recorded re-run of the failing command (deepTrace.ts).
  // Functions that ran join the candidates, weighted by how close to the crash they last ran;
  // (NOT_RAN can push down neighbours that never ran; the benchmark found no gain from it, so it is 1.)
  const executed = opts.run ? executedIn(g, opts.run) : undefined;
  if (executed) {
    const fresh = [...executed.keys()].filter((id) => !cand.has(id));
    for (let i = 0; i < fresh.length; i += 2000) {
      const rows = g.q(
        "MATCH (f:Function) WHERE f.id IN $ids AND f.kind <> 'module' RETURN f.id AS id, f.name AS name, f.file AS file, f.startLine AS startLine, f.endLine AS endLine",
        { ids: fresh.slice(i, i + 2000) }
      ) as unknown as FnRow[];
      for (const fn of rows) cand.set(fn.id, { fn, relation: "ran", prox: 0, hops: 0, reasons: [] });
    }
    for (const [id, c] of cand) {
      const e = executed.get(id);
      if (e) c.reasons.push({ kind: "ran", text: `Ran in the deep trace (${e.count} call${e.count > 1 ? "s" : ""}${e.since <= 5 ? ", among the last to run before the crash" : ""})` });
    }
  }

  // 3. Recency signal for every candidate in one query.
  const ids = [...cand.keys()];
  const rec = g.q(
    `UNWIND $ids AS id
     MATCH (f:Function {id:id})
     OPTIONAL MATCH (c:Commit)-[:TOUCHED]->(f)
     WITH f, c ORDER BY c.ts DESC
     WITH f, collect(c) AS cs
     OPTIONAL MATCH (fc:Commit)-[:MODIFIED]->(:File {path:f.file})
     WITH f, cs, fc ORDER BY fc.ts DESC
     WITH f, cs, collect(fc) AS fcs
     RETURN f.id AS id, coalesce(f.dirty,false) AS dirty,
            [x IN cs[0..3] | {hash:x.hash, author:x.author, ts:x.ts, message:x.message}] AS commits,
            [x IN fcs[0..1] | {hash:x.hash, author:x.author, ts:x.ts, message:x.message}] AS fileCommits`,
    { ids }
  );

  const suspects: Suspect[] = [];
  for (const r of rec) {
    const c = cand.get(r.id as string)!;
    const commits = r.commits as { hash: string; author: string; ts: number; message: string }[];
    const fileCommits = r.fileCommits as typeof commits;
    let recency = SCORING.BASELINE;
    let lastChange: Suspect["lastChange"];
    if (r.dirty) {
      recency = SCORING.DIRTY;
      c.reasons.unshift({ kind: "uncommitted", text: "Has uncommitted edits" });
    }
    if (commits.length) {
      const top = commits[0];
      lastChange = top;
      recency = Math.max(recency, SCORING.FN_COMMIT * decay(top.ts));
      c.reasons.push({ kind: "commit", text: `Changed ${ago(top.ts)} in ${top.hash.slice(0, 7)} by ${top.author}: “${top.message}”` });
      if (commits.length > 1) c.reasons.push({ kind: "commit", text: `Also touched by ${commits.length - 1} earlier commit${commits.length > 2 ? "s" : ""} in the window` });
    } else if (fileCommits.length) {
      const top = fileCommits[0];
      lastChange ??= top;
      recency = Math.max(recency, SCORING.FILE_COMMIT * decay(top.ts));
      c.reasons.push({ kind: "file-commit", text: `File (not this function) changed ${ago(top.ts)} in ${top.hash.slice(0, 7)}` });
    }
    const kind = fileKind(c.fn.file);
    const ex = executed ? executed.get(c.fn.id) ?? null : undefined;
    const score = scoreOf({ prox: effectiveProx(c.prox, c.relation, ex), recency, kind });
    const warm = recency > SCORING.BASELINE || c.reasons.some((x) => x.kind === "value-origin" || x.kind === "field") || !!ex;
    if (opts.features) features.push({ id: c.fn.id, relation: c.relation, prox: c.prox, kind, dirty: !!r.dirty, fnTs: commits[0]?.ts ?? null, fileTs: fileCommits[0]?.ts ?? null, origin: c.reasons.some((x) => x.kind === "value-origin"), field: c.reasons.some((x) => x.kind === "field"), ran: ex === undefined ? null : !!ex, since: ex ? ex.since : null });
    suspects.push({ ...c.fn, score: Math.round(score * 1000) / 10, hops: c.hops, relation: c.relation, reasons: c.reasons, lastChange, warm } as Suspect & { warm: boolean });
  }

  // Keep stack frames even when cold; drop static neighbours with no recent change and no value-origin link.
  const ranked = (suspects as (Suspect & { warm: boolean })[])
    .filter((s) => s.relation === "crash-site" || s.relation === "in-stack" || s.warm)
    .map(({ warm: _w, ...s }) => s as Suspect)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  const keep = ranked.map((s) => s.id);
  const edges = g.q("MATCH (a:Function)-[:CALLS]->(b:Function) WHERE a.id IN $ids AND b.id IN $ids RETURN a.id AS from, b.id AS to", { ids: keep }) as { from: string; to: string }[];
  return {
    frames: parsed.frames,
    crashSite: { id: crash.fn.id, name: crash.fn.name, file: crash.fn.file, line: inWs[0].line },
    suspects: ranked,
    edges,
    note: parsed.message,
    valueOrigin,
    ...(opts.features ? { features } : {}),
  };
}

/**
 * Which field was missing or empty, from the error text or the value-origin analysis:
 *   Python   'Tqdm' object has no attribute 'total'                → class Tqdm, attr total
 *   any      the bad value came from `self.config` / `this.config` → crash function's class, attr config
 */
export function missingField(message: string | undefined, origin: ReturnType<typeof findValueOrigin>, crashFnName: string): { cls: string; attr: string; self: string; how: string } | undefined {
  const m = message && /'(\w+)' object has no attribute '(\w+)'/.exec(message);
  if (m && m[1] !== "NoneType" && m[1] !== "module") return { cls: m[1], attr: m[2], self: "self", how: "missing" };
  if (origin?.source.kind === "field") {
    const f = /^(self|this)\.(\w+)$/.exec(origin.expression) ?? /^(self|this)\.(\w+)$/.exec(origin.source.text);
    const dot = crashFnName.lastIndexOf(".");
    if (f && dot > 0) return { cls: crashFnName.slice(0, dot).split(".").pop()!, attr: f[2], self: f[1], how: origin.value };
  }
  return undefined;
}

export { fieldsReadOnLine } from "./fields";

/** `module 'a.b' has no attribute 'x'` / `<module 'a.b' from '…'> has no attribute 'x'` → { module: "a.b", attr: "x" } */
export function missingModuleAttr(message: string | undefined): { module: string; attr: string } | undefined {
  // "does not have the attribute" is unittest.mock.patch's wording for the same problem.
  const m = message && /module '([\w.]+)'(?: from '[^']*'>)? (?:has no|does not have the) attribute '(\w+)'/.exec(message);
  return m ? { module: m[1], attr: m[2] } : undefined;
}


type FnQ = FnRow & { q: string };
/** Direct methods of class `cls` (Cls.m or Outer.Cls.m), not functions nested inside them. */
function classMethods(g: CodeGraph, cls: string): FnQ[] {
  return g.q(
    `MATCH (f:Function) WHERE f.qualifiedName STARTS WITH $p OR f.qualifiedName CONTAINS $inner
     RETURN f.id AS id, f.name AS name, f.qualifiedName AS q, f.file AS file, f.startLine AS startLine, f.endLine AS endLine`,
    { p: cls + ".", inner: "." + cls + "." }
  ).filter((r) => {
    const q = r.q as string;
    const rest = q.startsWith(cls + ".") ? q.slice(cls.length + 1) : q.slice(q.indexOf("." + cls + ".") + cls.length + 2);
    return !rest.includes(".");
  }) as unknown as FnQ[];
}

/**
 * Functions that write field `cls.attr`, from the graph's WRITES edges (built at index time, fields.ts).
 * By default only assignments; with `mutations`, also in-place changes (`x[k] = …`, `.append()`, `del`).
 * With `ctorFallback`, the class's constructor when nothing writes it.
 */
function fieldWriters(g: CodeGraph, cls: string, attr: string, opts: { mutations?: boolean; ctorFallback?: boolean } = {}): (FnRow & { assigns: boolean; line: number })[] {
  const out = g.q(
    `MATCH (fn:Function)-[w:WRITES]->(:Field {id:$id})
     WHERE $mut OR w.op = 'set'
     RETURN fn.id AS id, fn.name AS name, fn.file AS file, fn.startLine AS startLine, fn.endLine AS endLine, min(w.line) AS line`,
    { id: `${cls}.${attr}`, mut: !!opts.mutations }
  ).map((r) => ({ ...(r as unknown as FnRow), assigns: true, line: r.line as number }));
  if (out.length || !opts.ctorFallback) return out;
  const ctor = classMethods(g, cls).find((f) => /(^|\.)(__init__|constructor)$/.test(f.q));
  return ctor ? [{ ...ctor, assigns: false, line: ctor.startLine }] : [];
}

/** Fields the crash function reads on the crash line, from its READS edges. */
function fieldsReadAt(g: CodeGraph, fnId: string, line: number): { cls: string; name: string }[] {
  return g.q("MATCH (:Function {id:$id})-[r:READS]->(f:Field) WHERE r.line = $line RETURN DISTINCT f.cls AS cls, f.name AS name", { id: fnId, line }) as { cls: string; name: string }[];
}

/**
 * Proximity after a deep trace. `ex`: undefined = no deep trace; null = did not run; else how it ran.
 * Ran → at least RAN / (1 + since / SINCE_K), where `since` counts project calls after its last call.
 * Did not run → × NOT_RAN, except stack frames (they obviously ran; a mapping miss shouldn't sink them).
 */
export function effectiveProx(prox: number, relation: Suspect["relation"], ex: { since: number } | null | undefined): number {
  if (ex === undefined) return prox;
  if (ex) return Math.max(prox, SCORING.RAN / (1 + ex.since / SCORING.SINCE_K));
  if (relation === "crash-site" || relation === "in-stack") return prox;
  return prox * SCORING.NOT_RAN;
}

export type FileKind = "src" | "test";
export const fileKind = (file: string): FileKind => (TEST_FILE_RE.test(file) ? "test" : "src");

/**
 * The final score in [0,1]. `recency` is already max(baseline, dirty, function commit, file commit).
 * Tests stay in the list (they explain the failure) but rank lower: a fix is rarely in the test.
 */
export function scoreOf(x: { prox: number; recency: number; kind: FileKind }): number {
  return ((x.prox * (SCORING.FLOOR + x.recency)) / (SCORING.FLOOR + SCORING.DIRTY)) * (x.kind === "test" ? SCORING.TEST_PENALTY : 1);
}

// ------------------------------------------------------------ blast radius

/** Resolve a user/agent supplied target: function id, `file:line`, file path, or bare symbol name. */
export function resolveTarget(g: CodeGraph, root: string, target: string): { ids: string[]; file: string; name: string; isFile: boolean } | undefined {
  const t = target.trim();
  const byId = g.q("MATCH (f:Function {id:$t}) RETURN f.id AS id, f.file AS file, f.name AS name", { t });
  if (byId[0]) return { ids: [t], file: byId[0].file as string, name: byId[0].name as string, isFile: false };
  const files = indexedFiles(g);
  const fl = /^(.*?):(\d+)(?::\d+)?$/.exec(t);
  if (fl) {
    const rel = mapToWorkspace(fl[1].split("\\").join("/"), root, files);
    const fn = rel && functionAtLine(g, rel, +fl[2]);
    if (fn) return { ids: [fn.id], file: fn.file, name: fn.name, isFile: false };
  }
  const rel = mapToWorkspace(t.split("\\").join("/"), root, files);
  if (rel && (rel === t || t.endsWith(rel))) {
    const ids = g.q("MATCH (f:Function {file:$rel}) WHERE f.exported = true OR f.kind = 'module' RETURN f.id AS id", { rel }).map((r) => r.id as string);
    return { ids, file: rel, name: rel, isFile: true };
  }
  const short = t.includes(".") ? t.split(".").pop()! : t;
  const byName = g.q(
    "MATCH (f:Function) WHERE f.qualifiedName = $t OR f.name = $short RETURN f.id AS id, f.file AS file, f.name AS name, f.qualifiedName = $t AS exact ORDER BY exact DESC, f.exported DESC",
    { t, short }
  );
  if (byName[0]) return { ids: [byName[0].id as string], file: byName[0].file as string, name: byName[0].name as string, isFile: false };
  return undefined;
}

export function blastRadius(g: CodeGraph, root: string, target: string, depth = 4): BlastResult | undefined {
  const t = resolveTarget(g, root, target);
  if (!t) return undefined;
  const callers = g.q(
    `MATCH (t:Function) WHERE t.id IN $ids
     MATCH p=(u:Function)-[:CALLS*1..${Math.min(Math.max(depth, 1), 8)}]->(t)
     WHERE NOT u.id IN $ids
     WITH u, min(length(p)) AS hops
     RETURN u.id AS id, u.name AS name, u.file AS file, u.startLine AS startLine, hops, coalesce(u.isTest,false) AS isTest
     ORDER BY hops, file, startLine`,
    { ids: t.ids }
  ) as unknown as BlastNode[];
  const importerFiles = g.q(
    `MATCH p=(imp:File)-[:IMPORTS*1..${Math.min(Math.max(depth, 1), 8)}]->(:File {path:$file})
     WITH imp, min(length(p)) AS hops
     RETURN imp.path AS file, hops, coalesce(imp.isTest,false) AS isTest ORDER BY hops, file`,
    { file: t.file }
  ) as { file: string; hops: number; isTest: boolean }[];
  const tests = new Set<string>();
  for (const c of callers) if (c.isTest || TEST_FILE_RE.test(c.file)) tests.add(c.file);
  for (const f of importerFiles) if (f.isTest) tests.add(f.file);
  const nodeIds = [...t.ids, ...callers.map((c) => c.id)];
  const edges = g.q("MATCH (a:Function)-[:CALLS]->(b:Function) WHERE a.id IN $ids AND b.id IN $ids RETURN a.id AS from, b.id AS to", { ids: nodeIds }) as { from: string; to: string }[];
  const callerFiles = new Set(callers.map((c) => c.file));
  const direct = callers.filter((c) => c.hops === 1).length;
  return {
    target: { id: t.isFile ? undefined : t.ids[0], name: t.name, file: t.file },
    callers,
    importerFiles,
    testsToRun: [...tests].sort(),
    edges,
    summary:
      `${t.isFile ? "File" : "Function"} ${t.name}: ${direct} direct caller${direct === 1 ? "" : "s"}, ` +
      `${callers.length} transitive across ${callerFiles.size} file${callerFiles.size === 1 ? "" : "s"}; ` +
      `${importerFiles.length} file${importerFiles.length === 1 ? " imports" : "s import"} it (transitively); ${tests.size} test file${tests.size === 1 ? "" : "s"} to run.`,
  };
}

// ----------------------------------------------------------------- cycles

export function circularDependencies(g: CodeGraph, maxLen = 6, limit = 50): string[][] {
  const rows = g.q(`MATCH p=(a:File)-[:IMPORTS*2..${maxLen}]->(a) RETURN [n IN nodes(p) | n.path] AS cyc LIMIT 2000`);
  const seen = new Set<string>();
  const out: string[][] = [];
  for (const r of rows) {
    const cyc = (r.cyc as string[]).slice(0, -1);
    if (new Set(cyc).size !== cyc.length) continue; // not a simple cycle
    const i = cyc.indexOf([...cyc].sort()[0]);
    const canon = [...cyc.slice(i), ...cyc.slice(0, i)];
    const key = canon.join(" -> ");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push([...canon, canon[0]]);
    if (out.length >= limit) break;
  }
  return out.sort((a, b) => a.length - b.length);
}

// --------------------------------------------------------- recent changes

export function recentChanges(g: CodeGraph, hours = 48, limit = 30): Row[] {
  const since = Math.floor(now() - hours * 3600);
  return g.q(
    `MATCH (f:Function) WHERE f.kind <> 'module'
     OPTIONAL MATCH (c:Commit)-[:TOUCHED]->(f) WHERE c.ts >= $since
     WITH f, max(c.ts) AS lastTs, count(c) AS commits
     WHERE coalesce(f.dirty,false) OR lastTs IS NOT NULL
     OPTIONAL MATCH (caller:Function)-[:CALLS]->(f)
     WITH f, lastTs, commits, count(DISTINCT caller) AS directCallers
     RETURN f.id AS id, f.name AS name, f.file AS file, f.startLine AS line,
            coalesce(f.dirty,false) AS uncommitted, lastTs, commits, directCallers
     ORDER BY uncommitted DESC, directCallers DESC, lastTs DESC
     LIMIT $limit`,
    { since, limit }
  ).map((r) => ({ ...r, changed: r.uncommitted ? "uncommitted" : ago(r.lastTs as number) }));
}

export function codeLensInfo(g: CodeGraph, file: string): Map<string, { callers: number; transitive: number; dirty: boolean; lastTs?: number }> {
  const rows = g.q(
    `MATCH (f:Function {file:$file}) WHERE f.kind <> 'module'
     OPTIONAL MATCH (d:Function)-[:CALLS]->(f)
     WITH f, count(DISTINCT d) AS callers
     OPTIONAL MATCH (u:Function)-[:CALLS*1..4]->(f)
     WITH f, callers, count(DISTINCT u) AS transitive
     OPTIONAL MATCH (c:Commit)-[:TOUCHED]->(f)
     RETURN f.id AS id, callers, transitive, coalesce(f.dirty,false) AS dirty, max(c.ts) AS lastTs`,
    { file }
  );
  return new Map(rows.map((r) => [r.id as string, { callers: r.callers as number, transitive: r.transitive as number, dirty: r.dirty as boolean, lastTs: (r.lastTs as number) ?? undefined }]));
}
