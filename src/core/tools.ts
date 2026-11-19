import { CodeGraph } from "./graph";
import { blastRadius, circularDependencies, recentChanges, SCORING, traceSuspects } from "./analysis";

export const GRAPH_SCHEMA = `Graph schema (Relate / Cypher):
(:File {path, lang, loc, isTest, dirty})
(:Function {id, name, qualifiedName, file, startLine, endLine, exported, kind, isTest, dirty})  // id = "<path>#<qualifiedName>"
(:Commit {hash, author, ts /*epoch s*/, message})
(:File)-[:DEFINES]->(:Function)   (:File)-[:IMPORTS]->(:File)
(:Function)-[:CALLS {line, heuristic}]->(:Function)
(:Commit)-[:MODIFIED]->(:File)    (:Commit)-[:TOUCHED]->(:Function)
dirty=true means uncommitted edits. Paths are workspace-relative with forward slashes.`;

export interface ToolDef {
  name: string;
  description: string;
  params: Record<string, { type: "string" | "number" | "object"; description: string; optional?: boolean }>;
}

export const TOOLS: ToolDef[] = [
  {
    name: "trace_error_suspects",
    description:
      "Paste a stack trace / error output (Node, browser, Python, pytest, tsc). For undefined/null/None errors it also says where the bad value came from (the call, parameter or field that produced it). Returns the crash site and a ranked list of the functions most " +
      "likely to have caused it: stack frames plus static callers (≤5 hops up) and callees (≤2 hops down) from the pre-built call graph, " +
      "weighted by how recently git (or uncommitted edits) touched each function. Use this BEFORE reading files to decide where to look.",
    params: {
      stack_trace: { type: "string", description: "Raw error text including the stack frames." },
      limit: { type: "number", description: "Max suspects (default 10).", optional: true },
    },
  },
  {
    name: "get_blast_radius",
    description:
      "Before changing a function or file, find everything that depends on it: transitive callers (with hop distance), files that import it, " +
      "and the test files to run. Target may be a function id ('src/a.ts#Cart.total'), 'file:line', a file path, or a symbol name.",
    params: {
      target: { type: "string", description: "Function id, file:line, file path, or symbol name." },
      depth: { type: "number", description: "Max hops (default 4, max 8).", optional: true },
    },
  },
  {
    name: "find_recent_suspects",
    description:
      "List functions with uncommitted edits or commits in the last N hours, ordered by how many callers depend on them. " +
      "Good first step for 'what did we just break?' when there is no stack trace.",
    params: { hours: { type: "number", description: "Look-back window in hours (default 48).", optional: true } },
  },
  {
    name: "find_circular_dependencies",
    description: "List file-level import cycles (shortest first).",
    params: { max_length: { type: "number", description: "Longest cycle to search for (default 6).", optional: true } },
  },
  {
    name: "query_codegraph",
    description: `Run a READ-ONLY Cypher query against the workspace code graph (writes are rejected and rolled back). ${GRAPH_SCHEMA}`,
    params: {
      cypher: { type: "string", description: "Cypher statement. Use $params for values." },
      params: { type: "object", description: "Query parameters.", optional: true },
    },
  },
];

/** Agents send strings, floats or nothing: clamp to a sane integer instead of producing NaN Cypher. */
function int(v: unknown, def: number, min: number, max: number): number {
  const n = Math.round(Number(v ?? def));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
}

/** Relate executes synchronously on the extension host thread, so an unbounded path query would freeze VS Code. */
const UNBOUNDED = /\*\s*\]|\*\s*(?:\d+\s*)?\.\.\s*\]/; // [*]  [*..]  [*2..]  — but not [*3] or [*..5]

export function callTool(g: CodeGraph, root: string, name: string, args: Record<string, unknown>): unknown {
  switch (name) {
    case "trace_error_suspects": {
      const r = traceSuspects(g, root, String(args.stack_trace ?? ""), int(args.limit, 10, 1, 50));
      return {
        error: r.note,
        crashSite: r.crashSite,
        valueOrigin: r.valueOrigin && { summary: r.valueOrigin.summary, expression: r.valueOrigin.expression, value: r.valueOrigin.value, source: r.valueOrigin.source },
        suspects: r.suspects.map((s) => ({
          rank: 0,
          id: s.id,
          location: `${s.file}:${s.startLine}-${s.endLine}`,
          score: s.score,
          relation: s.relation,
          why: s.reasons.map((x) => x.text),
        })).map((s, i) => ({ ...s, rank: i + 1 })),
        callEdges: r.edges,
        frames: r.frames.map((f) => `${f.relPath ?? f.file}:${f.line}${f.fn ? ` (${f.fn})` : ""}${f.relPath ? "" : " [outside workspace]"}`),
        scoring: `score = proximity × (${SCORING.FLOOR} + recency), ×${SCORING.TEST_PENALTY} for tests (half-life ${SCORING.HALF_LIFE_H / 24}d; uncommitted=1.0)`,
      };
    }
    case "get_blast_radius":
      return blastRadius(g, root, String(args.target ?? ""), int(args.depth, 4, 1, 8)) ?? { error: `Nothing in the graph matches "${args.target}".` };
    case "find_recent_suspects":
      return recentChanges(g, int(args.hours, 48, 1, 24 * 365));
    case "find_circular_dependencies": {
      const cycles = circularDependencies(g, int(args.max_length, 6, 2, 10));
      return { count: cycles.length, cycles: cycles.map((c) => c.join(" -> ")) };
    }
    case "query_codegraph": {
      const cypher = String(args.cypher ?? "");
      if (UNBOUNDED.test(cypher))
        throw new Error("Variable-length patterns need an upper bound, e.g. [:CALLS*1..6] (unbounded paths can take minutes on a large graph).");
      return g.readOnly(cypher, (args.params as Record<string, unknown>) ?? {});
    }
    default:
      throw new Error(`Unknown tool ${name}`);
  }
}
