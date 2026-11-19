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
      "Paste a stack trace / error output (Node, browser, Python, pytest, tsc). Returns the crash site and a ranked list of the functions most " +
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

export function callTool(g: CodeGraph, root: string, name: string, args: Record<string, unknown>): unknown {
  switch (name) {
    case "trace_error_suspects": {
      const r = traceSuspects(g, root, String(args.stack_trace ?? ""), Number(args.limit ?? 10));
      return {
        error: r.note,
        crashSite: r.crashSite,
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
        scoring: `score = recency × proximity (half-life ${SCORING.HALF_LIFE_H}h; uncommitted=1.0)`,
      };
    }
    case "get_blast_radius":
      return blastRadius(g, root, String(args.target ?? ""), Number(args.depth ?? 4)) ?? { error: `Nothing in the graph matches "${args.target}".` };
    case "find_recent_suspects":
      return recentChanges(g, Number(args.hours ?? 48));
    case "find_circular_dependencies": {
      const cycles = circularDependencies(g, Number(args.max_length ?? 6));
      return { count: cycles.length, cycles: cycles.map((c) => c.join(" -> ")) };
    }
    case "query_codegraph":
      return g.readOnly(String(args.cypher ?? ""), (args.params as Record<string, unknown>) ?? {});
    default:
      throw new Error(`Unknown tool ${name}`);
  }
}
