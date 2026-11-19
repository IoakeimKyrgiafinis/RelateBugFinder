import { CodeGraph, Row, TEST_FILE_RE } from "./graph";
import { mapToWorkspace, parseStackTrace } from "./stackTrace";
import { BlastNode, BlastResult, Suspect, SuspectReason, TraceResult } from "./types";

/**
 * Suspect score = recency × proximity, both in [0,1]. Deliberately simple and explainable:
 *
 *   recency   1.0                       uncommitted edits inside the function
 *             0.9 · ½^(age / 72h)       a commit's diff hunk overlaps the function
 *             0.35 · ½^(age / 72h)      only the *file* changed (function untouched)
 *             0.02                      nothing changed recently (still shown if on the stack)
 *   proximity 1.0                       crash site (top in-workspace frame)
 *             1 / (1 + 0.5·i)           i-th frame further down the stack
 *             1 / (1 + hops)            static caller N hops upstream (max 5)
 *             0.8 / (1 + hops)          callee N hops downstream (max 2) — a changed helper often *is* the bug
 */
export const SCORING = { HALF_LIFE_H: 72, DIRTY: 1.0, FN_COMMIT: 0.9, FILE_COMMIT: 0.35, BASELINE: 0.02, UP_HOPS: 5, DOWN_HOPS: 2 };

const now = () => Date.now() / 1000;
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

export function traceSuspects(g: CodeGraph, root: string, traceText: string, limit = 12): TraceResult {
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
    const score = recency * c.prox;
    suspects.push({ ...c.fn, score: Math.round(score * 1000) / 10, hops: c.hops, relation: c.relation, reasons: c.reasons, lastChange });
  }

  // Keep stack frames even when cold; drop cold static neighbours.
  const ranked = suspects
    .filter((s) => s.relation === "crash-site" || s.relation === "in-stack" || s.score > SCORING.BASELINE * 100 / 2 + 0.5)
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
  };
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
