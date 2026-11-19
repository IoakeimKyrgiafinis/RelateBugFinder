import * as ts from "typescript";
import { CallRef, FunctionDef, ImportBinding, ParsedFile } from "./types";

export interface ParsedFileExtra extends ParsedFile {
  /** `export { x as y } from './z'` / `export * from './z'` */
  reexports: { exported: string; imported: string; spec: string; resolved?: string }[];
  /** Local name bound to the default export, if any. */
  defaultExport?: string;
  /** Local names exported (`export { a, b as c }` → a→a, b→c). Maps exported name → local name. */
  exportMap: Record<string, string>;
}

const MODULE_FN = "<module>";

function scriptKind(path: string): ts.ScriptKind {
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (path.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.(m|c)?js$/.test(path)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function hasExportModifier(node: ts.Node): boolean {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return !!mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}
function hasDefaultModifier(node: ts.Node): boolean {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return !!mods?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
}

function propName(n: ts.PropertyName | ts.BindingName | undefined): string | undefined {
  if (!n) return undefined;
  if (ts.isIdentifier(n) || ts.isPrivateIdentifier(n)) return n.text;
  if (ts.isStringLiteral(n) || ts.isNumericLiteral(n)) return n.text;
  return undefined;
}

/**
 * Parse one JS/TS file syntactically (no type checker → fast enough to run on every save).
 * Calls are attributed to the innermost *named* enclosing function; anonymous callbacks
 * (`items.map(x => price(x))`) roll up into their named parent, which is what you want for blame.
 */
export function parseTsFile(relPath: string, text: string): ParsedFileExtra {
  const sf = ts.createSourceFile(relPath, text, ts.ScriptTarget.Latest, true, scriptKind(relPath));
  const lineOf = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const loc = sf.getLineAndCharacterOfPosition(sf.end).line + 1;
  const lang = /\.(m|c)?jsx?$/.test(relPath) ? "js" : "ts";

  const functions: FunctionDef[] = [];
  const calls: CallRef[] = [];
  const imports: ImportBinding[] = [];
  const reexports: ParsedFileExtra["reexports"] = [];
  const exportMap: Record<string, string> = {};
  const importSpecs = new Set<string>();
  let defaultExport: string | undefined;
  const seen = new Map<string, number>();

  const moduleFn: FunctionDef = {
    id: `${relPath}#${MODULE_FN}`,
    name: MODULE_FN,
    qualifiedName: MODULE_FN,
    file: relPath,
    startLine: 1,
    endLine: loc,
    exported: false,
    kind: "module",
  };
  functions.push(moduleFn);

  const addFn = (qualifiedName: string, name: string, node: ts.Node, exported: boolean, kind: FunctionDef["kind"]) => {
    const n = (seen.get(qualifiedName) ?? 0) + 1;
    seen.set(qualifiedName, n);
    const fn: FunctionDef = {
      id: `${relPath}#${qualifiedName}${n > 1 ? `~${n}` : ""}`,
      name,
      qualifiedName,
      file: relPath,
      startLine: lineOf(node.getStart(sf)),
      endLine: lineOf(node.end),
      exported,
      kind,
    };
    functions.push(fn);
    return fn;
  };

  const isFnLike = (n: ts.Node | undefined): n is ts.ArrowFunction | ts.FunctionExpression =>
    !!n && (ts.isArrowFunction(n) || ts.isFunctionExpression(n));

  const visit = (node: ts.Node, current: FunctionDef, className?: string) => {
    // ---- imports / exports -------------------------------------------------
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text;
      importSpecs.add(spec);
      const clause = node.importClause;
      if (clause?.name) imports.push({ local: clause.name.text, imported: "default", spec });
      const nb = clause?.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) imports.push({ local: nb.name.text, imported: "*", spec });
      if (nb && ts.isNamedImports(nb))
        for (const el of nb.elements)
          imports.push({ local: el.name.text, imported: (el.propertyName ?? el.name).text, spec });
      return;
    }
    if (ts.isExportDeclaration(node)) {
      const spec = node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : undefined;
      if (spec) importSpecs.add(spec);
      const ec = node.exportClause;
      if (ec && ts.isNamedExports(ec)) {
        for (const el of ec.elements) {
          const local = (el.propertyName ?? el.name).text;
          if (spec) reexports.push({ exported: el.name.text, imported: local, spec });
          else exportMap[el.name.text] = local;
        }
      } else if (!ec && spec) reexports.push({ exported: "*", imported: "*", spec });
      return;
    }
    if (ts.isExportAssignment(node) && ts.isIdentifier(node.expression)) {
      defaultExport = node.expression.text;
    }

    // ---- CommonJS: require / module.exports --------------------------------
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer)) {
      const c = node.initializer;
      if (ts.isIdentifier(c.expression) && c.expression.text === "require" && c.arguments[0] && ts.isStringLiteral(c.arguments[0])) {
        const spec = c.arguments[0].text;
        importSpecs.add(spec);
        if (ts.isIdentifier(node.name)) imports.push({ local: node.name.text, imported: "*", spec });
        else if (ts.isObjectBindingPattern(node.name))
          for (const el of node.name.elements) {
            const local = propName(el.name);
            if (local) imports.push({ local, imported: propName(el.propertyName) ?? local, spec });
          }
      }
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left)
    ) {
      const l = node.left;
      const isModuleExports = ts.isIdentifier(l.expression) && l.expression.text === "module" && l.name.text === "exports";
      const isExportsX = ts.isIdentifier(l.expression) && l.expression.text === "exports";
      if (isModuleExports && ts.isObjectLiteralExpression(node.right)) {
        for (const p of node.right.properties) {
          if (ts.isShorthandPropertyAssignment(p)) exportMap[p.name.text] = p.name.text;
          else if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.initializer)) exportMap[propName(p.name) ?? ""] = p.initializer.text;
        }
      } else if (isModuleExports && ts.isIdentifier(node.right)) defaultExport = node.right.text;
      else if (isExportsX && ts.isIdentifier(node.right)) exportMap[l.name.text] = node.right.text;
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const a = node.arguments[0];
      if (a && ts.isStringLiteral(a)) importSpecs.add(a.text);
    }

    // ---- function definitions ---------------------------------------------
    let next = current;
    let nextClass = className;
    if (ts.isFunctionDeclaration(node) && node.name) {
      const exp = hasExportModifier(node);
      if (exp && hasDefaultModifier(node)) defaultExport = node.name.text;
      next = addFn(node.name.text, node.name.text, node, exp, "function");
    } else if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      nextClass = node.name?.text ?? className ?? "<anon>";
      if (ts.isClassDeclaration(node) && node.name && hasExportModifier(node)) {
        exportMap[node.name.text] = node.name.text;
        if (hasDefaultModifier(node)) defaultExport = node.name.text;
      }
    } else if ((ts.isMethodDeclaration(node) || ts.isGetAccessor(node)) && node.body) {
      const nm = propName(node.name) ?? "<computed>";
      const parentIsObj = ts.isObjectLiteralExpression(node.parent);
      const owner = parentIsObj ? objectOwnerName(node.parent as ts.ObjectLiteralExpression) : className;
      next = addFn(owner ? `${owner}.${nm}` : nm, nm, node, !!owner && exportMap[owner] !== undefined, "method");
    } else if (ts.isConstructorDeclaration(node) && node.body) {
      next = addFn(`${className ?? "<anon>"}.constructor`, "constructor", node, false, "method");
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && isFnLike(node.initializer)) {
      const stmt = node.parent?.parent;
      const exp = !!stmt && ts.isVariableStatement(stmt) && hasExportModifier(stmt);
      next = addFn(node.name.text, node.name.text, node.initializer, exp, "arrow");
      visitChildren(node.initializer, next, nextClass);
      return;
    } else if (ts.isPropertyDeclaration(node) && isFnLike(node.initializer)) {
      const nm = propName(node.name) ?? "<computed>";
      next = addFn(`${className ?? "<anon>"}.${nm}`, nm, node.initializer, false, "method");
      visitChildren(node.initializer, next, nextClass);
      return;
    } else if (ts.isPropertyAssignment(node) && isFnLike(node.initializer)) {
      const nm = propName(node.name) ?? "<computed>";
      const owner = objectOwnerName(node.parent as ts.ObjectLiteralExpression);
      next = addFn(owner ? `${owner}.${nm}` : nm, nm, node.initializer, false, "method");
      visitChildren(node.initializer, next, nextClass);
      return;
    }

    // ---- calls -------------------------------------------------------------
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const e = node.expression;
      const line = lineOf(node.getStart(sf));
      if (ts.isIdentifier(e) && e.text !== "require") calls.push({ fromId: current.id, name: ts.isNewExpression(node) ? `${e.text}.constructor` : e.text, line });
      else if (ts.isPropertyAccessExpression(e)) {
        const recv = e.expression;
        const receiver = recv.kind === ts.SyntaxKind.ThisKeyword ? "this" : ts.isIdentifier(recv) ? recv.text : undefined;
        calls.push({ fromId: current.id, name: e.name.text, receiver: receiver ?? "?", line });
      }
    }

    visitChildren(node, next, nextClass);
  };
  const visitChildren = (node: ts.Node, current: FunctionDef, className?: string) =>
    ts.forEachChild(node, (c) => visit(c, current, className));

  visitChildren(sf, moduleFn);

  // Exported variables (`export const foo = () => ...`) are already flagged; apply export lists now.
  const exportedLocals = new Set(Object.values(exportMap));
  if (defaultExport) exportedLocals.add(defaultExport);
  for (const f of functions) {
    const top = f.qualifiedName.split(".")[0];
    if (exportedLocals.has(f.qualifiedName) || exportedLocals.has(top)) f.exported = true;
    if (f.exported && !f.qualifiedName.includes(".")) exportMap[f.name] ??= f.name;
  }

  return {
    path: relPath,
    lang,
    loc,
    functions,
    calls,
    imports,
    importFiles: [...importSpecs], // resolved later by the orchestrator
    reexports,
    defaultExport,
    exportMap,
  };
}

/** `const api = { load() {} }` → "api";  `module.exports = { ... }` → undefined */
function objectOwnerName(obj: ts.ObjectLiteralExpression): string | undefined {
  const p = obj.parent;
  if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
  if (p && ts.isPropertyAssignment(p)) return propName(p.name);
  return undefined;
}
