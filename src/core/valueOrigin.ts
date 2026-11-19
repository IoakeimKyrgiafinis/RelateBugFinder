import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

/**
 * "Where did the undefined come from?"
 *
 * For errors like `Cannot read properties of undefined (reading 'pct')` or Python's
 * `'NoneType' object has no attribute 'pct'`, find the expression that held the bad value at the
 * crash site (`coupon` in `coupon.pct`), then walk back through the enclosing function to where that
 * value was produced: a call (`const coupon = lookupCoupon(code)`), a parameter (the caller passed it),
 * a field (`this.config`) or an index lookup (`items[i]`).
 *
 * Purely syntactic and local to one function: fast, explainable, and wrong only in ways the
 * explanation makes obvious.
 */

export type NullishKind = "undefined" | "null" | "None";

export interface NullishError {
  value: NullishKind;
  /** Property / attribute that was read, when the message says (`pct`). */
  property?: string;
  /** Expression the runtime printed, when it does (Safari, Firefox). */
  expression?: string;
  /** "read" (x.p), "call" (x() / x.p()), "index" (x[i]), "iterate", "destructure". */
  op: "read" | "write" | "call" | "index" | "iterate" | "destructure";
}

export type OriginSource =
  | { kind: "call"; callee: string; calleeText: string; line: number; code: string }
  | { kind: "param"; param: string; index: number; fnName: string }
  | { kind: "field"; text: string; line?: number; code?: string }
  | { kind: "index"; text: string; line?: number; code?: string }
  | { kind: "unknown"; line?: number; code?: string };

export interface ValueOrigin {
  value: NullishKind;
  property?: string;
  op: NullishError["op"];
  /** The expression that was undefined/null at the crash site. */
  expression: string;
  file: string;
  line: number;
  source: OriginSource;
  /** One plain-language sentence for the panel, notification and agents. */
  summary: string;
}

// ------------------------------------------------------------------- messages

const MESSAGE_PATTERNS: [RegExp, (m: RegExpExecArray) => NullishError][] = [
  // V8 (Node, Chrome, Edge)
  [/Cannot read propert(?:y|ies) of (undefined|null) \(reading '([^']+)'\)/, (m) => ({ value: m[1] as NullishKind, property: m[2], op: "read" })],
  [/Cannot read property '([^']+)' of (undefined|null)/, (m) => ({ value: m[2] as NullishKind, property: m[1], op: "read" })],
  [/Cannot set propert(?:y|ies) of (undefined|null) \(setting '([^']+)'\)/, (m) => ({ value: m[1] as NullishKind, property: m[2], op: "write" })],
  [/Cannot destructure property '([^']+)' of '([^']+)' as it is (undefined|null)/, (m) => ({ value: m[3] as NullishKind, property: m[1], expression: m[2], op: "destructure" })],
  [/Cannot destructure '([^']+)' as it is (undefined|null)/, (m) => ({ value: m[2] as NullishKind, expression: m[1], op: "destructure" })],
  // Firefox
  [/can't access property "([^"]+)", (\S+) is (undefined|null)/, (m) => ({ value: m[3] as NullishKind, property: m[1], expression: m[2], op: "read" })],
  // Safari
  [/(undefined|null) is not an object \(evaluating '([^']+)'\)/, (m) => {
    const full = m[2];
    const dot = full.lastIndexOf(".");
    return { value: m[1] as NullishKind, expression: dot > 0 ? full.slice(0, dot) : full, property: dot > 0 ? full.slice(dot + 1) : undefined, op: "read" };
  }],
  // Python
  [/'NoneType' object has no attribute '([^']+)'/, (m) => ({ value: "None", property: m[1], op: "read" })],
  [/'NoneType' object is not subscriptable/, () => ({ value: "None", op: "index" })],
  [/'NoneType' object is not iterable|cannot unpack non-iterable NoneType/, () => ({ value: "None", op: "iterate" })],
  [/'NoneType' object is not callable/, () => ({ value: "None", op: "call" })],
];

export function parseNullishError(message: string | undefined): NullishError | undefined {
  if (!message) return undefined;
  for (const [re, f] of MESSAGE_PATTERNS) {
    const m = re.exec(message);
    if (m) return f(m);
  }
  return undefined;
}

// ------------------------------------------------------------------ public

export function findValueOrigin(root: string, relPath: string, line: number, col: number | undefined, err: NullishError): ValueOrigin | undefined {
  let text: string;
  try {
    text = fs.readFileSync(path.join(root, relPath), "utf8");
  } catch {
    return undefined;
  }
  const found = relPath.endsWith(".py") ? pythonOrigin(text, line, err) : tsOrigin(relPath, text, line, col, err);
  if (!found) return undefined;
  const o: ValueOrigin = { value: err.value, property: err.property, op: err.op, expression: found.expression, file: relPath, line, source: found.source, summary: "" };
  o.summary = summarise(o);
  return o;
}

function summarise(o: ValueOrigin): string {
  const verb = o.op === "write" ? "setting" : o.op === "destructure" ? "destructuring" : "reading";
  const what = `\`${o.expression}\` was ${o.value}` + (o.property ? ` when ${verb} .${o.property}` : "");
  const s = o.source;
  switch (s.kind) {
    case "call":
      return `${what}. It came from ${s.calleeText}(), at ${o.file}:${s.line}: ${s.code}`;
    case "param":
      return `${what}. It's a parameter of ${s.fnName}(), so the caller passed ${o.value}${o.value === "undefined" ? " (or left it out)" : ""} as argument #${s.index + 1}.`;
    case "field":
      return `${what}. It's read from ${s.text}, which ` + (s.line ? `is assigned at ${o.file}:${s.line} (${s.code}) but hadn't been set, or was set to ${o.value}, at that point.` : `is never assigned in this file.`);
    case "index":
      return `${what}. It came from an index lookup (${s.text}), which had no entry for that key` + (s.line ? ` (${o.file}:${s.line}: ${s.code})` : "") + ".";
    default:
      return `${what}` + (s.line ? `. Last assigned at ${o.file}:${s.line}: ${s.code}` : "") + ".";
  }
}

// --------------------------------------------------------------- TypeScript

type Found = { expression: string; source: OriginSource };

function tsOrigin(relPath: string, text: string, line: number, col: number | undefined, err: NullishError): Found | undefined {
  const kind = /\.tsx$/.test(relPath) ? ts.ScriptKind.TSX : /\.jsx$/.test(relPath) ? ts.ScriptKind.JSX : /\.[cm]?js$/.test(relPath) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(relPath, text, ts.ScriptTarget.Latest, true, kind);
  const starts = sf.getLineStarts();
  if (line < 1 || line > starts.length) return undefined;
  const lineStart = starts[line - 1];
  const lineEnd = line < starts.length ? starts[line] : text.length;

  // 1. The receiver expression on the crash line.
  const receiver = findReceiver(sf, lineStart, lineEnd, col === undefined ? undefined : lineStart + col - 1, err);
  if (!receiver) return undefined;
  const expression = receiver.getText(sf);
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const codeOf = (n: ts.Node) => oneLine(n.getText(sf));

  // 2. Where that value came from.
  const inner = unwrap(receiver);
  if (ts.isCallExpression(inner)) return { expression, source: callSource(inner, sf, lineOf(inner), codeOf(inner)) };
  if (ts.isElementAccessExpression(inner)) return { expression, source: { kind: "index", text: codeOf(inner) } };
  if (ts.isPropertyAccessExpression(inner)) {
    const asg = lastAssignmentTo(sf, inner.getText(sf), receiver.getStart(sf));
    return { expression, source: { kind: "field", text: codeOf(inner), line: asg && lineOf(asg), code: asg && codeOf(asg) } };
  }
  if (ts.isIdentifier(inner)) {
    const fn = enclosingFunction(receiver);
    const name = inner.text;
    // Latest local declaration or assignment before the crash position.
    const def = fn && latestDefinition(fn, name, receiver.getStart(sf), sf);
    if (def) {
      const init = unwrap(def.value);
      // Show `const coupon = …`, not just `coupon = …`.
      const list = def.node.parent;
      const stmt = ts.isVariableDeclaration(def.node) && ts.isVariableDeclarationList(list) && list.declarations.length === 1 && ts.isVariableStatement(list.parent) ? list.parent : def.node;
      const code = codeOf(stmt);
      if (ts.isCallExpression(init)) return { expression, source: callSource(init, sf, lineOf(def.node), code) };
      if (ts.isElementAccessExpression(init)) return { expression, source: { kind: "index", text: codeOf(init), line: lineOf(def.node), code } };
      if (ts.isPropertyAccessExpression(init)) return { expression, source: { kind: "field", text: codeOf(init), line: lineOf(def.node), code } };
      return { expression, source: { kind: "unknown", line: lineOf(def.node), code } };
    }
    if (fn) {
      const idx = fn.parameters.findIndex((p) => ts.isIdentifier(p.name) && p.name.text === name);
      if (idx >= 0) return { expression, source: { kind: "param", param: name, index: idx, fnName: functionName(fn) } };
    }
  }
  return { expression, source: { kind: "unknown" } };
}

function findReceiver(sf: ts.SourceFile, from: number, to: number, pos: number | undefined, err: NullishError): ts.Expression | undefined {
  const hits: { recv: ts.Expression; at: number }[] = [];
  const visit = (n: ts.Node) => {
    if (n.end < from || n.getStart(sf) > to) return;
    let recv: ts.Expression | undefined;
    let at = n.getStart(sf);
    if (ts.isPropertyAccessExpression(n) && (!err.property || n.name.text === err.property)) {
      recv = n.expression;
      at = n.name.getStart(sf);
    } else if (ts.isElementAccessExpression(n) && (err.op === "index" || (err.property && ts.isStringLiteral(n.argumentExpression) && n.argumentExpression.text === err.property))) {
      recv = n.expression;
    } else if (err.op === "destructure" && ts.isVariableDeclaration(n) && ts.isObjectBindingPattern(n.name) && n.initializer) {
      recv = n.initializer;
    }
    if (recv && at >= from && at < to && (!err.expression || recv.getText(sf) === err.expression || err.op === "destructure")) hits.push({ recv, at });
    ts.forEachChild(n, visit);
  };
  visit(sf);
  if (!hits.length) return undefined;
  if (pos === undefined) return hits[0].recv;
  // V8 points the column at the property name (or the start of the access): nearest wins.
  return hits.sort((a, b) => Math.abs(a.at - pos) - Math.abs(b.at - pos))[0].recv;
}

function unwrap(e: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(e) || ts.isAwaitExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) || ts.isTypeAssertionExpression(e) || (ts.isSatisfiesExpression?.(e) ?? false))
    e = (e as ts.ParenthesizedExpression).expression;
  return e;
}

function callSource(call: ts.CallExpression, sf: ts.SourceFile, line: number, code: string): OriginSource {
  const callee = unwrap(call.expression);
  const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : callee.getText(sf);
  return { kind: "call", callee: name, calleeText: oneLine(callee.getText(sf)), line, code };
}

type FnLike = ts.FunctionLikeDeclaration;
function enclosingFunction(n: ts.Node): FnLike | undefined {
  for (let p = n.parent; p; p = p.parent) if (ts.isFunctionLike(p) && "body" in p && (p as FnLike).body) return p as FnLike;
  return undefined;
}

function functionName(fn: FnLike): string {
  if (fn.name && ts.isIdentifier(fn.name)) return fn.name.text;
  const p = fn.parent;
  if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
  if (p && ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) return p.name.text;
  return "this function";
}

/** Latest `const|let|var name = …`, destructuring of `name`, or `name = …` before `before`, within `fn`. */
function latestDefinition(fn: FnLike, name: string, before: number, sf: ts.SourceFile): { node: ts.Node; value: ts.Expression } | undefined {
  let best: { node: ts.Node; value: ts.Expression; at: number } | undefined;
  const consider = (node: ts.Node, value: ts.Expression) => {
    const at = node.getStart(sf);
    if (at < before && (!best || at > best.at)) best = { node, value, at };
  };
  const visit = (n: ts.Node) => {
    if (n !== fn && ts.isFunctionLike(n)) return; // don't descend into nested functions
    if (ts.isVariableDeclaration(n) && n.initializer) {
      if (ts.isIdentifier(n.name) && n.name.text === name) consider(n, n.initializer);
      else if ((ts.isObjectBindingPattern(n.name) || ts.isArrayBindingPattern(n.name)) && bindsName(n.name, name)) consider(n, n.initializer);
    } else if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(n.left) && n.left.text === name) {
      consider(n, n.right);
    }
    ts.forEachChild(n, visit);
  };
  if (fn.body) visit(fn.body);
  return best;
}

function bindsName(p: ts.BindingPattern, name: string): boolean {
  return p.elements.some((e) => ts.isBindingElement(e) && (ts.isIdentifier(e.name) ? e.name.text === name : bindsName(e.name, name)));
}

/** Last `this.x = …` / `obj.x = …` anywhere in the file before `before` (fields are often set in another method). */
function lastAssignmentTo(sf: ts.SourceFile, target: string, before: number): ts.Node | undefined {
  let beforeCrash: ts.Node | undefined;
  let any: ts.Node | undefined;
  const visit = (n: ts.Node) => {
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && n.left.getText(sf) === target) {
      any ??= n;
      if (n.getStart(sf) < before) beforeCrash = n;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return beforeCrash ?? any; // a field set in a later method (e.g. init()) still explains where it should come from
}

const oneLine = (s: string) => {
  const t = s.replace(/\s+/g, " ").trim().replace(/;$/, "");
  return t.length > 90 ? t.slice(0, 89) + "…" : t;
};

// ------------------------------------------------------------------- Python

function pythonOrigin(text: string, line: number, err: NullishError): Found | undefined {
  const lines = text.split(/\r?\n/);
  const src = lines[line - 1];
  if (src === undefined) return undefined;
  const code = src.replace(/#.*$/, "");

  // 1. Receiver on the crash line.
  const atom = String.raw`[A-Za-z_][\w.]*(?:\([^()]*\))?`;
  let m: RegExpExecArray | null = null;
  if (err.property) m = new RegExp(`(${atom})\\.${err.property}\\b`).exec(code);
  else if (err.op === "index") m = new RegExp(`(${atom})\\[`).exec(code);
  else if (err.op === "iterate") m = new RegExp(`\\bin\\s+(${atom})|=\\s*(${atom})\\s*$`).exec(code);
  else if (err.op === "call") m = new RegExp(`(${atom})\\(`).exec(code);
  const expression = m && (m[1] ?? m[2]);
  if (!expression) return undefined;

  const callRe = /^(?:await\s+)?([A-Za-z_][\w.]*)\s*\(/;
  const callOf = (rhs: string, at: number, codeLine: string): OriginSource => {
    const c = callRe.exec(rhs)!;
    return { kind: "call", callee: c[1].split(".").pop()!, calleeText: c[1], line: at, code: codeLine.trim() };
  };
  if (callRe.test(expression)) return { expression, source: callOf(expression, line, src) };
  if (expression.includes(".")) {
    // Last `self.conn = …` in the file (often set in __init__ or a connect() method).
    const target = new RegExp(String.raw`^\s*` + expression.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + String.raw`\s*(?::[^=]+)?=(?!=)`);
    let at = -1;
    lines.forEach((l, i) => {
      if (target.test(l)) at = i;
    });
    return { expression, source: { kind: "field", text: expression, line: at >= 0 ? at + 1 : undefined, code: at >= 0 ? lines[at].trim() : undefined } };
  }

  // 2. Walk back to the latest assignment inside the enclosing def.
  const indent = (s: string) => /^\s*/.exec(s)![0].length;
  const crashIndent = indent(src);
  for (let i = line - 2; i >= 0; i--) {
    const l = lines[i];
    if (!l.trim() || l.trim().startsWith("#")) continue;
    const def = /^\s*(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)/.exec(l);
    if (def && indent(l) < crashIndent) {
      const params = def[2].split(",").map((p) => p.trim().split(/[:=\s]/)[0]).filter(Boolean);
      const idx = params.indexOf(expression);
      if (idx >= 0) {
        const selfOffset = params[0] === "self" || params[0] === "cls" ? 1 : 0;
        return { expression, source: { kind: "param", param: expression, index: idx - selfOffset, fnName: def[1] } };
      }
      break;
    }
    const asg = new RegExp(`^\\s*${expression}\\s*(?::[^=]+)?=(?!=)\\s*(.+)$`).exec(l);
    if (asg) {
      const rhs = asg[1].trim();
      if (callRe.test(rhs)) return { expression, source: callOf(rhs, i + 1, l) };
      if (/\[[^\]]*\]\s*$/.test(rhs)) return { expression, source: { kind: "index", text: rhs, line: i + 1, code: l.trim() } };
      if (/^[\w.]+$/.test(rhs) && rhs.includes(".")) return { expression, source: { kind: "field", text: rhs, line: i + 1, code: l.trim() } };
      return { expression, source: { kind: "unknown", line: i + 1, code: l.trim() } };
    }
  }
  return { expression, source: { kind: "unknown" } };
}
