import { FunctionDef } from "./types";

/**
 * Field reads and writes of `self.x` (Python) / `this.x` (TS/JS), found per line at index time and stored
 * in the graph as (:Function)-[:READS|WRITES {line}]->(:Field {id: "Class.x"}).
 *
 * Syntactic on purpose (fast on every save, same rules for both languages). A write is an assignment
 * (`=`, `+=`, …), `setattr(self, 'x', …)`, or with op "mutate" an in-place change: `self.x[k] = …`,
 * `del self.x[k]`, `self.x.append(…)` and similar. Method calls (`self.compute()`) are not field reads.
 */
export interface FieldAccess {
  fn: string; // function id the line belongs to (innermost)
  field: string; // "Class.attr"
  cls: string;
  name: string;
  line: number;
  kind: "read" | "write";
  op?: "set" | "mutate";
}

const MUTATORS = "append|extend|insert|add|update|pop|popitem|remove|discard|clear|setdefault|push|splice|shift|unshift|set|delete|sort|reverse";
const ACCESS = /\b(self|this)\.(\w+)\b/g;

/** Fields of `self`/`this` read on one line of code (method calls excluded). */
export function fieldsReadOnLine(code: string): string[] {
  const out: string[] = [];
  for (const a of lineAccesses(code)) if (a.kind === "read" && !out.includes(a.name)) out.push(a.name);
  return out;
}

function lineAccesses(code: string): { name: string; kind: "read" | "write"; op?: "set" | "mutate" }[] {
  const out: { name: string; kind: "read" | "write"; op?: "set" | "mutate" }[] = [];
  const noComment = code.replace(/(^|\s)(#|\/\/).*$/, "");
  for (const m of noComment.matchAll(ACCESS)) {
    const name = m[2];
    const after = noComment.slice(m.index! + m[0].length);
    const before = noComment.slice(0, m.index!);
    if (/^\s*\(/.test(after)) continue; // self.method(...) is a call, not a field
    if (/^\s*(=(?!=)|[-+*/%|&^]=|\*\*=|\/\/=)/.test(after)) {
      if (!/^\s*=(?!=)/.test(after)) out.push({ name, kind: "read" }); // `+=` reads it too
      out.push({ name, kind: "write", op: "set" });
      continue;
    }
    if (new RegExp(`^\\s*\\.(${MUTATORS})\\s*\\(`).test(after) || /^\s*\[[^\]]*\]\s*(=(?!=)|[-+*/%|&^]=)/.test(after) || /\bdel\s+$/.test(before)) {
      out.push({ name, kind: "read" });
      out.push({ name, kind: "write", op: "mutate" });
      continue;
    }
    out.push({ name, kind: "read" });
  }
  const set = /setattr\(\s*self\s*,\s*['"](\w+)['"]/.exec(noComment);
  if (set) out.push({ name: set[1], kind: "write", op: "set" });
  return out;
}

/** All field accesses in a file, attributed to the innermost function and the enclosing method's class. */
export function fieldAccesses(source: string, functions: FunctionDef[]): FieldAccess[] {
  const lines = source.split(/\r?\n/);
  const fns = functions.filter((f) => f.kind !== "module").sort((a, b) => a.endLine - a.startLine - (b.endLine - b.startLine)); // innermost first
  const methods = fns.filter((f) => f.kind === "method");
  const out: FieldAccess[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const code = lines[i];
    if (!/\b(self|this)\./.test(code)) continue;
    const line = i + 1;
    const fn = fns.find((f) => f.startLine <= line && f.endLine >= line);
    const method = methods.find((f) => f.startLine <= line && f.endLine >= line);
    if (!fn || !method) continue;
    const parts = method.qualifiedName.split(".");
    if (parts.length < 2) continue;
    const cls = parts[parts.length - 2];
    for (const a of lineAccesses(code)) {
      const key = `${fn.id}|${a.name}|${line}|${a.kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ fn: fn.id, field: `${cls}.${a.name}`, cls, name: a.name, line, kind: a.kind, op: a.op });
    }
  }
  return out;
}
