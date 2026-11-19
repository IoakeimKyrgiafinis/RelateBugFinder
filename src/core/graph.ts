// eslint-disable-next-line @typescript-eslint/no-var-requires
const relate = require("@relate/relate") as typeof import("@relate/relate");
import type { Connection, Database } from "@relate/relate";
import { CommitInfo, DirtyInfo, FunctionDef } from "./types";
import { overlaps } from "./git";

export type Row = Record<string, unknown>;

export const TEST_FILE_RE = /(^|\/)(__tests__|tests?|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.py$/;

/**
 * Graph model (all in one `.rl` file):
 *
 *   (:File {path, lang, loc, isTest, dirty})
 *   (:Function {id, name, qualifiedName, file, startLine, endLine, exported, kind, isTest, dirty})
 *   (:Commit {hash, author, ts, message})
 *   (:File)-[:DEFINES]->(:Function)
 *   (:File)-[:IMPORTS]->(:File)
 *   (:Function)-[:CALLS {line, heuristic}]->(:Function)
 *   (:Commit)-[:MODIFIED]->(:File)
 *   (:Commit)-[:TOUCHED]->(:Function)     ← hunk ranges overlapped with the function body
 */
export class CodeGraph {
  readonly db: Database;
  readonly conn: Connection;

  private constructor(db: Database, public readonly location: string) {
    this.db = db;
    this.conn = db.connect();
  }

  static open(location: string, opts: { readOnly?: boolean } = {}): CodeGraph {
    let db: Database;
    try {
      db = relate.Database.open(location, opts);
    } catch (e) {
      const msg = (e as Error).message;
      throw new Error(
        `Could not open Relate graph at ${location} (${msg}). ` +
          `Relate allows a single writer per file — is another VS Code window or MCP server holding it?`
      );
    }
    const g = new CodeGraph(db, location);
    if (!opts.readOnly) g.ensureSchema();
    return g;
  }

  q(cypher: string, params?: Record<string, unknown>): Row[] {
    return this.conn.query(cypher, params as never).rows as Row[];
  }

  /** Run arbitrary Cypher for an agent, guaranteed side-effect free (executes in a txn that is always rolled back). */
  readOnly(cypher: string, params?: Record<string, unknown>, maxRows = 200): { columns: string[]; rows: Row[]; truncated: boolean } {
    this.conn.begin();
    try {
      const res = this.conn.query(cypher, params as never);
      const all = res.rows as Row[];
      const qt = res.consume().queryType;
      if (qt && qt !== "r") throw new Error(`Only read-only Cypher is allowed here (statement type "${qt}"). Nothing was changed.`);
      const rows = all.slice(0, maxRows).map(simplify);
      return { columns: res.columns as string[], rows, truncated: all.length > maxRows };
    } finally {
      this.conn.rollback();
    }
  }

  checkpoint() {
    try {
      this.db.checkpoint();
    } catch {
      /* :memory: or read-only */
    }
  }

  private ensureSchema() {
    for (const s of [
      "CREATE INDEX file_path IF NOT EXISTS FOR (f:File) ON (f.path)",
      "CREATE INDEX fn_id IF NOT EXISTS FOR (f:Function) ON (f.id)",
      "CREATE INDEX fn_file IF NOT EXISTS FOR (f:Function) ON (f.file)",
      "CREATE INDEX fn_name IF NOT EXISTS FOR (f:Function) ON (f.name)",
      "CREATE INDEX commit_hash IF NOT EXISTS FOR (c:Commit) ON (c.hash)",
    ]) {
      try {
        this.q(s);
      } catch {
        /* index syntax unsupported → fine, just slower */
      }
    }
  }

  txn<T>(fn: () => T): T {
    this.conn.begin();
    try {
      const r = fn();
      this.conn.commit();
      return r;
    } catch (e) {
      try {
        this.conn.rollback();
      } catch {
        /* already closed */
      }
      throw e;
    }
  }

  // ------------------------------------------------------------------ writes

  upsertFile(file: { path: string; lang: string; loc: number }, functions: FunctionDef[], importFiles: string[]) {
    const isTest = TEST_FILE_RE.test(file.path);
    this.q("MERGE (f:File {path:$path}) SET f.lang=$lang, f.loc=$loc, f.isTest=$isTest", { path: file.path, lang: file.lang, loc: file.loc, isTest });
    // Remove functions that no longer exist (keeps incoming CALLS of surviving ones intact).
    this.q("MATCH (fn:Function {file:$path}) WHERE NOT fn.id IN $ids DETACH DELETE fn", {
      path: file.path,
      ids: functions.map((f) => f.id),
    });
    this.q(
      `UNWIND $fns AS d
       MERGE (fn:Function {id:d.id})
       SET fn.name=d.name, fn.qualifiedName=d.qualifiedName, fn.file=d.file, fn.startLine=d.startLine,
           fn.endLine=d.endLine, fn.exported=d.exported, fn.kind=d.kind, fn.isTest=$isTest`,
      {
        fns: functions.map((f) => ({ id: f.id, name: f.name, qualifiedName: f.qualifiedName, file: f.file, startLine: f.startLine, endLine: f.endLine, exported: !!f.exported, kind: f.kind })),
        isTest,
      }
    );
    this.q("MATCH (f:File {path:$path}), (fn:Function {file:$path}) MERGE (f)-[:DEFINES]->(fn)", { path: file.path });
    this.q("MATCH (f:File {path:$path})-[r:IMPORTS]->() DELETE r", { path: file.path });
    if (importFiles.length)
      this.q(
        `MATCH (f:File {path:$path})
         UNWIND $targets AS t
         MERGE (g:File {path:t})
         MERGE (f)-[:IMPORTS]->(g)`,
        { path: file.path, targets: importFiles }
      );
  }

  removeFile(path: string) {
    this.q("MATCH (fn:Function {file:$path}) DETACH DELETE fn", { path });
    this.q("MATCH (f:File {path:$path}) DETACH DELETE f", { path });
  }

  /** Replace the outgoing CALLS edges of every function defined in `files`. */
  replaceCalls(files: string[], edges: { from: string; to: string; line: number; heuristic: boolean }[]) {
    this.q("MATCH (a:Function)-[r:CALLS]->() WHERE a.file IN $files DELETE r", { files });
    for (let i = 0; i < edges.length; i += 2000) {
      this.q(
        `UNWIND $edges AS e
         MATCH (a:Function {id:e.from}), (b:Function {id:e.to})
         MERGE (a)-[r:CALLS]->(b)
         SET r.line=e.line, r.heuristic=e.heuristic`,
        { edges: edges.slice(i, i + 2000) }
      );
    }
  }

  /** Rebuild the git layer: commits, MODIFIED/TOUCHED edges and dirty flags. */
  setGitHistory(commits: CommitInfo[], dirty: DirtyInfo, fnsByFile: Map<string, FunctionDef[]>) {
    this.q("MATCH (c:Commit) DETACH DELETE c");
    this.q("MATCH (f:Function) WHERE f.dirty = true SET f.dirty=false");
    this.q("MATCH (f:File) WHERE f.dirty = true SET f.dirty=false");

    const commitRows = commits.map((c) => ({ hash: c.hash, author: c.author, ts: c.ts, message: c.message.slice(0, 200) }));
    const modified: { hash: string; path: string }[] = [];
    const touched: { hash: string; id: string }[] = [];
    for (const c of commits) {
      for (const f of c.files) {
        const fns = fnsByFile.get(f.path);
        if (!fns) continue;
        modified.push({ hash: c.hash, path: f.path });
        for (const fn of fns) if (fn.kind !== "module" && overlaps(f.ranges, fn.startLine, fn.endLine)) touched.push({ hash: c.hash, id: fn.id });
      }
    }
    const dirtyFns: string[] = [];
    const dirtyFiles: string[] = [];
    for (const [path, ranges] of dirty.ranges) {
      const fns = fnsByFile.get(path);
      if (!fns) continue;
      dirtyFiles.push(path);
      for (const fn of fns) if (fn.kind !== "module" && overlaps(ranges, fn.startLine, fn.endLine)) dirtyFns.push(fn.id);
    }

    this.q("UNWIND $rows AS c CREATE (:Commit {hash:c.hash, author:c.author, ts:c.ts, message:c.message})", { rows: commitRows });
    for (let i = 0; i < modified.length; i += 2000)
      this.q("UNWIND $rows AS m MATCH (c:Commit {hash:m.hash}), (f:File {path:m.path}) MERGE (c)-[:MODIFIED]->(f)", { rows: modified.slice(i, i + 2000) });
    for (let i = 0; i < touched.length; i += 2000)
      this.q("UNWIND $rows AS m MATCH (c:Commit {hash:m.hash}), (f:Function {id:m.id}) MERGE (c)-[:TOUCHED]->(f)", { rows: touched.slice(i, i + 2000) });
    this.q("UNWIND $ids AS id MATCH (f:Function {id:id}) SET f.dirty=true", { ids: dirtyFns });
    this.q("UNWIND $paths AS p MATCH (f:File {path:p}) SET f.dirty=true", { paths: dirtyFiles });
  }

  stats(): Row {
    const r = this.q(
      `CALL { MATCH (f:File) RETURN count(f) AS files }
       CALL { MATCH (f:Function) WHERE f.kind <> 'module' RETURN count(f) AS functions }
       CALL { MATCH ()-[r:CALLS]->() RETURN count(r) AS calls }
       CALL { MATCH ()-[r:IMPORTS]->() RETURN count(r) AS imports }
       CALL { MATCH (c:Commit) RETURN count(c) AS commits }
       RETURN files, functions, calls, imports, commits`
    );
    return r[0] ?? {};
  }
}

/** Turn Relate node/relationship values into compact JSON for agents. */
function simplify(row: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) out[k] = simplifyValue(v);
  return out;
}
function simplifyValue(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return v.map(simplifyValue);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (o.kind === "node") return { _labels: o.labels, ...(o.properties as object) };
    if (o.kind === "relationship") return { _type: o.type, ...(o.properties as object) };
    const r: Row = {};
    for (const [k, x] of Object.entries(o)) r[k] = simplifyValue(x);
    return r;
  }
  return v;
}
