import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import { parseTsFile, ParsedFileExtra } from "./tsIndexer";
import { CodeGraph } from "./graph";
import { dirtyRanges, isGitRepo, listGitFiles, recentCommits } from "./git";
import { FunctionDef } from "./types";
import { FieldAccess, fieldAccesses } from "./fields";

const TS_EXT = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];
const PY_EXT = [".py"];
const IGNORE_DIR = /(^|\/)(node_modules|dist|build|out|coverage|\.git|\.vscode|\.venv|venv|__pycache__|\.next|\.turbo|vendor|site-packages)(\/|$)/;
const MAX_FILE_BYTES = 1_000_000;

/** Method names too generic to resolve by name alone. */
const COMMON = new Set(
  ("push pop map filter reduce forEach find some every get set has delete add clear keys values entries then catch finally " +
    "toString valueOf join split slice splice concat includes indexOf replace trim log error warn info debug emit on off once " +
    "send write read close open start stop run call apply bind next init update render append extend items format copy sort " +
    "parse stringify resolve reject json text query exec execute load save create remove insert dispatch handle")
    .split(" ")
);

export interface IndexStats {
  files: number;
  functions: number;
  calls: number;
  ms: number;
  gitCommits: number;
  pythonSkipped?: string;
}

export interface WorkspaceOptions {
  pythonPath?: string;
  gitSinceDays?: number;
  pythonScript?: string;
  log?: (msg: string) => void;
}

const toPosix = (p: string) => p.split(path.sep).join("/");

export function isIndexable(rel: string): boolean {
  if (IGNORE_DIR.test(rel)) return false;
  if (rel.endsWith(".d.ts") || /\.min\.js$/.test(rel)) return false;
  const ext = path.extname(rel);
  return TS_EXT.includes(ext) || PY_EXT.includes(ext);
}

export class Workspace {
  readonly files = new Map<string, ParsedFileExtra>();
  private methodIndex = new Map<string, FunctionDef[]>();
  private lastHead = "";
  private opts: Required<Omit<WorkspaceOptions, "log">> & { log: (m: string) => void };

  constructor(public readonly root: string, public readonly graph: CodeGraph, opts: WorkspaceOptions = {}) {
    this.opts = {
      pythonPath: opts.pythonPath ?? (process.platform === "win32" ? "python" : "python3"),
      gitSinceDays: opts.gitSinceDays ?? 30,
      pythonScript: opts.pythonScript ?? path.join(__dirname, "..", "python", "py_index.py"),
      log: opts.log ?? (() => undefined),
    };
  }

  // ---------------------------------------------------------------- discovery

  async listFiles(): Promise<string[]> {
    let all: string[];
    if (await isGitRepo(this.root)) all = await listGitFiles(this.root);
    else all = walk(this.root, "");
    return all.map(toPosix).filter(isIndexable).filter((rel) => {
      try {
        return fs.statSync(path.join(this.root, rel)).size <= MAX_FILE_BYTES;
      } catch {
        return false;
      }
    });
  }

  // ------------------------------------------------------------------ parsing

  private parseTs(rel: string): ParsedFileExtra | undefined {
    try {
      return parseTsFile(rel, fs.readFileSync(path.join(this.root, rel), "utf8"));
    } catch (e) {
      this.opts.log(`parse failed ${rel}: ${(e as Error).message}`);
      return undefined;
    }
  }

  private parsePython(rels: string[]): Promise<ParsedFileExtra[]> {
    if (!rels.length) return Promise.resolve([]);
    return new Promise((resolve, reject) => {
      const p = spawn(this.opts.pythonPath, [this.opts.pythonScript], { cwd: this.root, windowsHide: true });
      let out = "", err = "";
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (err += d));
      p.on("error", reject);
      p.on("close", (code) => {
        if (code !== 0) return reject(new Error(`python indexer exited ${code}: ${err.slice(0, 500)}`));
        try {
          resolve(JSON.parse(out));
        } catch (e) {
          reject(e);
        }
      });
      p.stdin.end(JSON.stringify({ root: this.root, files: rels }));
    });
  }

  // --------------------------------------------------------------- resolution

  private exists(rel: string) {
    return this.files.has(rel);
  }

  private resolveTsSpec(from: string, spec: string): string | undefined {
    const bases: string[] = [];
    if (spec.startsWith(".")) bases.push(path.posix.normalize(path.posix.join(path.posix.dirname(from), spec)));
    else if (spec.startsWith("@/") || spec.startsWith("~/")) bases.push("src/" + spec.slice(2));
    else bases.push(spec, "src/" + spec); // tsconfig baseUrl-style
    for (const b0 of bases) {
      const b = b0.replace(/\.(m|c)?js$/, "");
      const candidates = [b0, ...TS_EXT.map((e) => b + e), ...TS_EXT.map((e) => `${b}/index${e}`)];
      for (const c of candidates) if (this.exists(c)) return c;
    }
    return undefined;
  }

  private resolvePySpec(from: string, spec: string): string | undefined {
    const m = /^(\.*)(.*)$/.exec(spec)!;
    const level = m[1].length;
    const mod = m[2] ? m[2].split(".").join("/") : "";
    const roots: string[] = [];
    if (level > 0) {
      let d = path.posix.dirname(from);
      for (let i = 1; i < level; i++) d = path.posix.dirname(d);
      roots.push(d === "." ? "" : d);
    } else roots.push("", "src", path.posix.dirname(from) === "." ? "" : path.posix.dirname(from));
    for (const r of roots) {
      const b = [r, mod].filter(Boolean).join("/");
      for (const c of [`${b}.py`, `${b}/__init__.py`]) if (this.exists(c)) return c;
    }
    return undefined;
  }

  private resolveImports(pf: ParsedFileExtra) {
    const res = (spec: string) => (pf.lang === "py" ? this.resolvePySpec(pf.path, spec) : this.resolveTsSpec(pf.path, spec));
    const targets = new Set<string>();
    for (const spec of pf.importFiles) {
      const r = res(spec);
      if (r && r !== pf.path) targets.add(r);
    }
    for (const b of pf.imports) {
      b.resolved = res(b.spec);
      // Python `from pkg import mod` where mod is a submodule → treat as namespace import.
      if (pf.lang === "py" && b.imported !== "*") {
        const sub = this.resolvePySpec(pf.path, `${b.spec}${b.spec.endsWith(".") ? "" : "."}${b.imported}`);
        if (sub && !this.findExport(b.resolved, b.imported)) {
          b.resolved = sub;
          b.imported = "*";
        }
      }
      if (b.resolved && b.resolved !== pf.path) targets.add(b.resolved);
    }
    for (const r of pf.reexports) r.resolved = res(r.spec);
    return [...targets];
  }

  private topLevel(pf: ParsedFileExtra, name: string): FunctionDef | undefined {
    return pf.functions.find((f) => f.qualifiedName === name);
  }

  /** Find what `name` refers to when exported from `file` (follows re-exports). */
  private findExport(file: string | undefined, name: string, depth = 0): { fn?: FunctionDef; file: string; symbol: string } | undefined {
    if (!file || depth > 4) return undefined;
    const pf = this.files.get(file);
    if (!pf) return undefined;
    let local = name === "default" ? pf.defaultExport : pf.exportMap[name] ?? name;
    if (!local) return undefined;
    const fn = this.topLevel(pf, local);
    if (fn) return { fn, file, symbol: local };
    if (pf.functions.some((f) => f.qualifiedName.startsWith(local + "."))) return { file, symbol: local }; // class / object
    for (const r of pf.reexports) {
      if (r.exported === name || r.exported === "*") {
        const hit = this.findExport(r.resolved, r.exported === "*" ? name : r.imported, depth + 1);
        if (hit) return hit;
      }
    }
    // Imported then re-exported via `export { x }`
    const b = pf.imports.find((i) => i.local === local);
    if (b?.resolved) return this.findExport(b.resolved, b.imported === "*" ? name : b.imported, depth + 1);
    return undefined;
  }

  private rebuildMethodIndex() {
    this.methodIndex.clear();
    for (const pf of this.files.values())
      for (const f of pf.functions) {
        if (f.kind === "module") continue;
        const arr = this.methodIndex.get(f.name) ?? [];
        arr.push(f);
        this.methodIndex.set(f.name, arr);
      }
  }

  private resolveCalls(pf: ParsedFileExtra): { from: string; to: string; line: number; heuristic: boolean }[] {
    const edges = new Map<string, { from: string; to: string; line: number; heuristic: boolean }>();
    const byId = new Map(pf.functions.map((f) => [f.id, f]));
    const add = (from: string, to: FunctionDef | undefined, line: number, heuristic = false) => {
      if (!to || to.id === from) return;
      const k = `${from}->${to.id}`;
      const prev = edges.get(k);
      if (!prev || (prev.heuristic && !heuristic)) edges.set(k, { from, to: to.id, line, heuristic });
    };
    const importedFiles = new Set(pf.imports.map((i) => i.resolved).filter(Boolean) as string[]);

    for (const c of pf.calls) {
      const caller = byId.get(c.fromId);
      if (!caller) continue;
      if (!c.receiver) {
        if (c.name.endsWith(".constructor")) {
          const cls = c.name.slice(0, -".constructor".length);
          const local = this.topLevel(pf, c.name);
          if (local) { add(c.fromId, local, c.line); continue; }
          const b = pf.imports.find((i) => i.local === cls);
          const hit = b && this.findExport(b.resolved, b.imported === "*" ? cls : b.imported);
          if (hit) add(c.fromId, this.files.get(hit.file)?.functions.find((f) => f.qualifiedName === `${hit.symbol}.constructor` || f.qualifiedName === `${hit.symbol}.__init__`), c.line);
          continue;
        }
        // Python: Class() → Class.__init__
        const pyInit = pf.lang === "py" ? this.topLevel(pf, `${c.name}.__init__`) : undefined;
        const local = this.topLevel(pf, c.name) ?? pf.functions.find((f) => f.name === c.name && f.kind !== "method") ?? pyInit;
        if (local) { add(c.fromId, local, c.line); continue; }
        const b = pf.imports.find((i) => i.local === c.name);
        if (b) {
          const hit = this.findExport(b.resolved, b.imported);
          if (hit?.fn) add(c.fromId, hit.fn, c.line);
          else if (hit) add(c.fromId, this.files.get(hit.file)?.functions.find((f) => f.qualifiedName === `${hit.symbol}.__init__` || f.qualifiedName === `${hit.symbol}.constructor`), c.line);
        }
        continue;
      }

      if (c.receiver === "this") {
        const cls = caller.qualifiedName.includes(".") ? caller.qualifiedName.slice(0, caller.qualifiedName.lastIndexOf(".")) : undefined;
        const m = cls && this.topLevel(pf, `${cls}.${c.name}`);
        if (m) { add(c.fromId, m, c.line); continue; }
      }

      const b = c.receiver !== "?" && c.receiver !== "this" ? pf.imports.find((i) => i.local === c.receiver) : undefined;
      if (b?.resolved) {
        if (b.imported === "*") {
          const hit = this.findExport(b.resolved, c.name);
          if (hit?.fn) { add(c.fromId, hit.fn, c.line); continue; }
        } else {
          const hit = this.findExport(b.resolved, b.imported);
          const m = hit && this.files.get(hit.file)?.functions.find((f) => f.qualifiedName === `${hit.symbol}.${c.name}`);
          if (m) { add(c.fromId, m, c.line); continue; }
        }
      }
      const localObj = c.receiver && c.receiver !== "?" ? this.topLevel(pf, `${c.receiver}.${c.name}`) : undefined;
      if (localObj) { add(c.fromId, localObj, c.line); continue; }

      // Heuristic: `cart.total()` where only one `total` method exists — prefer files this one imports.
      if (COMMON.has(c.name) || c.name.length < 4) continue;
      const cands = (this.methodIndex.get(c.name) ?? []).filter((f) => f.kind === "method" || f.kind === "function");
      const near = cands.filter((f) => f.file === pf.path || importedFiles.has(f.file));
      if (near.length === 1) add(c.fromId, near[0], c.line, true);
      else if (cands.length === 1) add(c.fromId, cands[0], c.line, true);
    }
    return [...edges.values()];
  }

  /** self.x / this.x reads and writes in a file (see fields.ts). */
  private fieldsOf(pf: { path: string; functions: FunctionDef[] }): FieldAccess[] {
    try {
      return fieldAccesses(fs.readFileSync(path.join(this.root, pf.path), "utf8"), pf.functions);
    } catch {
      return [];
    }
  }

  // ------------------------------------------------------------------- public

  async fullIndex(): Promise<IndexStats> {
    const t0 = Date.now();
    const rels = await this.listFiles();
    this.files.clear();
    const py: string[] = [];
    for (const rel of rels) {
      if (rel.endsWith(".py")) py.push(rel);
      else {
        const pf = this.parseTs(rel);
        if (pf) this.files.set(rel, pf);
      }
    }
    let pythonSkipped: string | undefined;
    try {
      for (const pf of await this.parsePython(py)) this.files.set(pf.path, pf);
    } catch (e) {
      pythonSkipped = (e as Error).message;
      this.opts.log(`Python indexing skipped: ${pythonSkipped}`);
    }
    this.rebuildMethodIndex();

    const g = this.graph;
    const resolvedImports = new Map<string, string[]>();
    for (const pf of this.files.values()) resolvedImports.set(pf.path, this.resolveImports(pf));

    let calls = 0;
    g.txn(() => {
      // Drop files that vanished since the last session.
      g.q("MATCH (f:File) WHERE NOT f.path IN $paths DETACH DELETE f", { paths: [...this.files.keys()] });
      g.q("MATCH (fn:Function) WHERE NOT fn.file IN $paths DETACH DELETE fn", { paths: [...this.files.keys()] });
      for (const pf of this.files.values()) g.upsertFile(pf, pf.functions, resolvedImports.get(pf.path)!);
      const all = [...this.files.values()].flatMap((pf) => this.resolveCalls(pf));
      calls = all.length;
      g.replaceCalls([...this.files.keys()], all);
      g.replaceFields([...this.files.keys()], [...this.files.values()].flatMap((pf) => this.fieldsOf(pf)));
    });
    const gitCommits = await this.refreshGit(true);
    g.checkpoint();
    const functions = [...this.files.values()].reduce((n, pf) => n + pf.functions.length - 1, 0);
    return { files: this.files.size, functions, calls, gitCommits, ms: Date.now() - t0, pythonSkipped };
  }

  /** Re-index a single file after save/create, plus the call edges of files that import it. */
  async updateFile(rel: string): Promise<void> {
    rel = toPosix(rel);
    if (!isIndexable(rel)) return;
    if (!fs.existsSync(path.join(this.root, rel))) return this.deleteFile(rel);
    const pf = rel.endsWith(".py") ? (await this.parsePython([rel]).catch(() => []))[0] : this.parseTs(rel);
    if (!pf) return;
    const isNew = !this.files.has(rel);
    this.files.set(rel, pf);
    this.rebuildMethodIndex();
    const imports = this.resolveImports(pf);
    const dependents = [...this.files.values()].filter((o) => o.path !== rel && (isNew || o.imports.some((i) => i.resolved === rel) || o.reexports.some((r) => r.resolved === rel)));
    if (isNew) for (const d of dependents) this.resolveImports(d);
    const affected = [pf, ...dependents];
    this.graph.txn(() => {
      this.graph.upsertFile(pf, pf.functions, imports);
      this.graph.replaceCalls(affected.map((a) => a.path), affected.flatMap((a) => this.resolveCalls(a)));
      this.graph.replaceFields([pf.path], this.fieldsOf(pf));
    });
    await this.refreshGit(false);
    this.graph.checkpoint();
  }

  async deleteFile(rel: string) {
    rel = toPosix(rel);
    if (!this.files.delete(rel)) return;
    this.rebuildMethodIndex();
    this.graph.txn(() => this.graph.removeFile(rel));
    this.graph.checkpoint();
  }

  /** Refresh commit history when HEAD moved (or forced), and dirty ranges always. Returns commit count when refreshed. */
  async refreshGit(force: boolean): Promise<number> {
    if (!(await isGitRepo(this.root))) return 0;
    // Nothing parsed yet → we can't link commits to functions; rebuilding now would wipe the git layer.
    if (this.files.size === 0) return 0;
    const head = await headHash(this.root);
    const fnsByFile = new Map([...this.files.values()].map((pf) => [pf.path, pf.functions]));
    const dirty = await dirtyRanges(this.root);
    if (force || head !== this.lastHead) {
      this.lastHead = head;
      const commits = await recentCommits(this.root, this.opts.gitSinceDays);
      this.graph.txn(() => this.graph.setGitHistory(commits, dirty, fnsByFile));
      return commits.length;
    }
    // Fast path: only dirty flags changed.
    const commitsUnchanged = (this.graph.q("MATCH (c:Commit) RETURN count(c) AS n")[0]?.n as number) ?? 0;
    this.graph.txn(() => this.updateDirty(dirty, fnsByFile));
    return commitsUnchanged;
  }

  private updateDirty(dirty: Awaited<ReturnType<typeof dirtyRanges>>, fnsByFile: Map<string, FunctionDef[]>) {
    const ids: string[] = [], paths: string[] = [];
    for (const [p, ranges] of dirty.ranges) {
      const fns = fnsByFile.get(p);
      if (!fns) continue;
      paths.push(p);
      for (const f of fns) if (f.kind !== "module" && ranges.some(([a, b]) => a <= f.endLine && b >= f.startLine)) ids.push(f.id);
    }
    this.graph.q("MATCH (f:Function) WHERE f.dirty = true AND NOT f.id IN $ids SET f.dirty=false", { ids });
    this.graph.q("UNWIND $ids AS id MATCH (f:Function {id:id}) SET f.dirty=true", { ids });
    this.graph.q("MATCH (f:File) WHERE f.dirty = true AND NOT f.path IN $paths SET f.dirty=false", { paths });
    this.graph.q("UNWIND $paths AS p MATCH (f:File {path:p}) SET f.dirty=true", { paths });
  }

  functionAt(rel: string, line: number): FunctionDef | undefined {
    const pf = this.files.get(toPosix(rel));
    if (!pf) return undefined;
    return pf.functions
      .filter((f) => f.startLine <= line && f.endLine >= line)
      .sort((a, b) => a.endLine - a.startLine - (b.endLine - b.startLine))[0];
  }
}

async function headHash(root: string): Promise<string> {
  try {
    const { execFileSync } = await import("child_process");
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "";
  }
}

function walk(root: string, rel: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!IGNORE_DIR.test(r + "/") && !e.name.startsWith(".")) walk(root, r, out);
    } else out.push(r);
  }
  return out;
}
