/** Shared types for the code graph. Paths are always workspace-relative, POSIX-style. */

export type Lang = "ts" | "js" | "py";

export interface FunctionDef {
  /** Stable id: `<relPath>#<qualifiedName>` (suffix `~2` etc. for duplicate names). Survives edits that move lines. */
  id: string;
  name: string;
  qualifiedName: string;
  file: string;
  startLine: number; // 1-based, inclusive
  endLine: number; // 1-based, inclusive
  exported: boolean;
  kind: "function" | "method" | "arrow" | "module";
}

/** A call found syntactically inside a function body, before resolution. */
export interface CallRef {
  fromId: string;
  /** Callee identifier as written: `foo`, or the property name for `obj.foo()`. */
  name: string;
  /** For `ns.foo()` / `obj.foo()`: the receiver identifier (`ns`/`obj`), else undefined. */
  receiver?: string;
  line: number;
}

export interface ImportBinding {
  /** Local name in the importing file. */
  local: string;
  /** Exported name in the source module (`default`, `*` for namespace imports). */
  imported: string;
  /** Raw module specifier. */
  spec: string;
  /** Resolved workspace-relative file, if the specifier points inside the workspace. */
  resolved?: string;
}

export interface ParsedFile {
  path: string;
  lang: Lang;
  loc: number;
  functions: FunctionDef[];
  calls: CallRef[];
  imports: ImportBinding[];
  /** Resolved workspace files this file imports (deduped). */
  importFiles: string[];
}

export interface CommitInfo {
  hash: string;
  author: string;
  ts: number; // epoch seconds
  message: string;
  files: { path: string; ranges: [number, number][] }[];
}

export interface DirtyInfo {
  /** file -> changed line ranges (current working tree numbering) */
  ranges: Map<string, [number, number][]>;
}

export interface StackFrame {
  raw: string;
  fn?: string;
  file: string; // as printed
  relPath?: string; // mapped into workspace
  line: number;
  col?: number;
}

export interface SuspectReason {
  kind: "uncommitted" | "commit" | "file-commit" | "in-stack" | "caller" | "callee";
  text: string;
}

export interface Suspect {
  id: string;
  name: string;
  file: string;
  startLine: number;
  endLine: number;
  score: number;
  hops: number;
  relation: "crash-site" | "in-stack" | "upstream" | "downstream";
  reasons: SuspectReason[];
  lastChange?: { hash: string; author: string; ts: number; message: string };
}

export interface TraceResult {
  frames: StackFrame[];
  crashSite?: { id: string; name: string; file: string; line: number };
  suspects: Suspect[];
  /** Edges among crash site + suspects, for drawing. */
  edges: { from: string; to: string }[];
  note?: string;
}

export interface BlastNode {
  id: string;
  name: string;
  file: string;
  startLine: number;
  hops: number;
  isTest: boolean;
}

export interface BlastResult {
  target: { id?: string; name: string; file: string };
  callers: BlastNode[];
  importerFiles: { file: string; hops: number; isTest: boolean }[];
  testsToRun: string[];
  edges: { from: string; to: string }[];
  summary: string;
}
