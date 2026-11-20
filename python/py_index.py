"""Relate Bug Finder Python indexer.

Reads JSON {"root": str, "files": [relPath, ...]} on stdin, writes one JSON object per file
(same shape as the TS indexer's ParsedFile) as a JSON array on stdout. Pure stdlib.
"""
import ast
import json
import os
import sys

MODULE_FN = "<module>"


class Indexer(ast.NodeVisitor):
    def __init__(self, rel):
        self.rel = rel
        self.functions = []
        self.calls = []
        self.imports = []
        self.specs = set()
        self.seen = {}
        self.stack = []  # (fn dict)
        self.class_stack = []

    def add_fn(self, qname, name, node, kind):
        n = self.seen.get(qname, 0) + 1
        self.seen[qname] = n
        fid = f"{self.rel}#{qname}" + (f"~{n}" if n > 1 else "")
        start = node.lineno
        if getattr(node, "decorator_list", None):
            start = min([d.lineno for d in node.decorator_list] + [start])
        fn = {
            "id": fid,
            "name": name,
            "qualifiedName": qname,
            "file": self.rel,
            "startLine": start,
            "endLine": getattr(node, "end_lineno", node.lineno),
            "exported": not name.startswith("_") and not self.stack[1:] ,
            "kind": kind,
        }
        self.functions.append(fn)
        return fn

    # ---- definitions -------------------------------------------------------
    def _visit_fn(self, node):
        cls = self.class_stack[-1] if self.class_stack else None
        in_fn = len(self.stack) > 1
        if cls and not in_fn:
            qname, kind = f"{cls}.{node.name}", "method"
        elif in_fn:
            qname, kind = f"{self.stack[-1]['qualifiedName']}.{node.name}", "function"
        else:
            qname, kind = node.name, "function"
        fn = self.add_fn(qname, node.name, node, kind)
        if cls and not in_fn:
            fn["exported"] = not cls.startswith("_") and not node.name.startswith("__") or node.name == "__init__"
        self.stack.append(fn)
        saved = self.class_stack
        self.class_stack = []
        self.generic_visit(node)
        self.class_stack = saved
        self.stack.pop()

    visit_FunctionDef = _visit_fn
    visit_AsyncFunctionDef = _visit_fn

    def visit_ClassDef(self, node):
        self.class_stack.append(node.name)
        self.generic_visit(node)
        self.class_stack.pop()

    # ---- imports -----------------------------------------------------------
    def visit_Import(self, node):
        for a in node.names:
            self.specs.add(a.name)
            # `import pkg.mod` binds `pkg`; `import pkg.mod as m` binds m -> pkg.mod
            local = a.asname or a.name.split(".")[0]
            spec = a.name if a.asname else a.name.split(".")[0]
            self.imports.append({"local": local, "imported": "*", "spec": spec})

    def visit_ImportFrom(self, node):
        base = "." * (node.level or 0) + (node.module or "")
        self.specs.add(base)
        for a in node.names:
            if a.name == "*":
                continue
            # `from pkg import mod` may import a submodule: record both possibilities
            self.imports.append({"local": a.asname or a.name, "imported": a.name, "spec": base})

    # ---- calls -------------------------------------------------------------
    def visit_Call(self, node):
        cur = self.stack[-1]
        f = node.func
        if isinstance(f, ast.Name):
            self.calls.append({"fromId": cur["id"], "name": f.id, "line": node.lineno})
        elif isinstance(f, ast.Attribute):
            v = f.value
            recv = "this" if isinstance(v, ast.Name) and v.id in ("self", "cls") else (v.id if isinstance(v, ast.Name) else "?")
            self.calls.append({"fromId": cur["id"], "name": f.attr, "receiver": recv, "line": node.lineno})
        self.generic_visit(node)


def parse(root, rel):
    path = os.path.join(root, rel)
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        src = fh.read()
    loc = src.count("\n") + 1
    idx = Indexer(rel)
    module = {"id": f"{rel}#{MODULE_FN}", "name": MODULE_FN, "qualifiedName": MODULE_FN, "file": rel,
              "startLine": 1, "endLine": loc, "exported": False, "kind": "module"}
    idx.functions.append(module)
    idx.stack.append(module)
    try:
        tree = ast.parse(src, filename=rel)
        idx.visit(tree)
    except SyntaxError as e:
        return {"path": rel, "lang": "py", "loc": loc, "functions": idx.functions, "calls": [], "imports": [],
                "importFiles": [], "reexports": [], "exportMap": {}, "error": str(e)}
    export_map = {f["name"]: f["name"] for f in idx.functions if f["exported"] and "." not in f["qualifiedName"]}
    return {"path": rel, "lang": "py", "loc": loc, "functions": idx.functions, "calls": idx.calls,
            "imports": idx.imports, "importFiles": sorted(idx.specs), "reexports": [], "exportMap": export_map}


def main():
    req = json.load(sys.stdin)
    out = []
    for rel in req["files"]:
        try:
            out.append(parse(req["root"], rel))
        except OSError:
            pass
    json.dump(out, sys.stdout)


if __name__ == "__main__":
    main()
