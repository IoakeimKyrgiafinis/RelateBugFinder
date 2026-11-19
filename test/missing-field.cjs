// Unit tests for "which field was missing?" (src/core/analysis.ts missingField). Usage: node test/missing-field.cjs
const path = require("path");
const fs = require("fs");
const assert = require("assert");

const out = path.join(__dirname, `.missing-field-${process.pid}.cjs`);
require("esbuild").buildSync({ entryPoints: [path.join(__dirname, "..", "src", "core", "analysis.ts")], bundle: true, platform: "node", format: "cjs", outfile: out, logLevel: "error", external: ["@relate/relate", "typescript"] });
const { missingField } = require(out);
let n = 0;
const check = (name, got, want) => {
  assert.deepStrictEqual(got, want, name);
  n++;
  console.log(`  ✓ ${name}`);
};
const field = (expression, text, value = "None") => ({ value, expression, source: { kind: "field", text } });

check("Python: object has no attribute", missingField("AttributeError: 'tqdm' object has no attribute 'total'", undefined, "tqdm.__len__"), { cls: "tqdm", attr: "total", self: "self", how: "missing" });
check("Python: NoneType is not a class to search", missingField("AttributeError: 'NoneType' object has no attribute 'x'", undefined, "A.f"), undefined);
check("Python: module attribute is not a field", missingField("AttributeError: 'module' object has no attribute 'x'", undefined, "f"), undefined);
check("None read from self.field", missingField("AttributeError: 'NoneType' object has no attribute 'read'", field("self.stream", "self.stream"), "Reader.next"), { cls: "Reader", attr: "stream", self: "self", how: "None" });
check("undefined read from this.field (nested class name)", missingField("TypeError: x", field("this.config", "this.config", "undefined"), "Outer.Cart.total"), { cls: "Cart", attr: "config", self: "this", how: "undefined" });
check("field of another object is not resolved", missingField("TypeError: x", field("req.body", "req.body", "undefined"), "Cart.total"), undefined);
check("free function has no class", missingField("TypeError: x", field("this.config", "this.config", "undefined"), "total"), undefined);

const { fieldsReadOnLine, missingModuleAttr } = require(out);
check("fields read on a crash line (method calls excluded)", fieldsReadOnLine("        self.bracket_match.pop((self.depth, leaf.type))"), ["bracket_match", "depth"]);
check("this.fields in TS, call skipped", fieldsReadOnLine("return this.rates[this.region] * this.compute(x)"), ["rates", "region"]);
check("no self on the line", fieldsReadOnLine("return total(x)"), []);
check("module attribute, Python 3 wording", missingModuleAttr("AttributeError: module 'thefuck.rules.no_command' has no attribute 'get_x'"), { module: "thefuck.rules.no_command", attr: "get_x" });
check("module attribute, repr wording", missingModuleAttr("AttributeError: <module 'a.b' from 'C:\\\\x\\\\a\\\\b.py'> has no attribute 'f'"), { module: "a.b", attr: "f" });
check("module attribute, mock.patch wording", missingModuleAttr("AttributeError: <module 'thefuck.rules.no_command' from 'C:\\\\w\\\\no_command.py'> does not have the attribute 'which'"), { module: "thefuck.rules.no_command", attr: "which" });
check("object attribute is not a module", missingModuleAttr("AttributeError: 'tqdm' object has no attribute 'total'"), undefined);

// Field reads/writes stored in the graph at index time (src/core/fields.ts).
const fo = path.join(__dirname, `.fields-${process.pid}.cjs`);
require("esbuild").buildSync({ entryPoints: [path.join(__dirname, "..", "src", "core", "fields.ts")], bundle: true, platform: "node", format: "cjs", outfile: fo, logLevel: "error" });
const { fieldAccesses } = require(fo);
const src = [
  "class Tracker:",                                      // 1
  "    def __init__(self):",                             // 2
  "        self.depth = 0",                              // 3
  "        self.seen = {}",                              // 4
  "    def mark(self, leaf):",                           // 5
  "        self.seen.pop((self.depth, leaf))  # crash",  // 6
  "    def inc(self):",                                  // 7
  "        self.depth += 1",                             // 8
  "        def inner():",                                // 9
  "            self.seen[1] = 2",                        // 10
  "        self.go()",                                   // 11
].join("\n");
const fns = [
  { id: "t.py#Tracker.__init__", qualifiedName: "Tracker.__init__", kind: "method", startLine: 2, endLine: 4 },
  { id: "t.py#Tracker.mark", qualifiedName: "Tracker.mark", kind: "method", startLine: 5, endLine: 6 },
  { id: "t.py#Tracker.inc", qualifiedName: "Tracker.inc", kind: "method", startLine: 7, endLine: 11 },
  { id: "t.py#Tracker.inc.inner", qualifiedName: "Tracker.inc.inner", kind: "function", startLine: 9, endLine: 10 },
];
const acc = fieldAccesses(src, fns).map((a) => `${a.fn.split("#")[1]} ${a.kind}${a.op ? ":" + a.op : ""} ${a.field} @${a.line}`);
check("index-time field accesses (assign, +=, mutate, nested function, call skipped)", acc, [
  "Tracker.__init__ write:set Tracker.depth @3",
  "Tracker.__init__ write:set Tracker.seen @4",
  "Tracker.mark read Tracker.seen @6",
  "Tracker.mark write:mutate Tracker.seen @6",
  "Tracker.mark read Tracker.depth @6",
  "Tracker.inc read Tracker.depth @8",
  "Tracker.inc write:set Tracker.depth @8",
  "Tracker.inc.inner read Tracker.seen @10",
  "Tracker.inc.inner write:mutate Tracker.seen @10",
]);
fs.rmSync(fo, { force: true });

fs.rmSync(out, { force: true });
console.log(`MISSING-FIELD CHECKS PASSED (${n})`);
