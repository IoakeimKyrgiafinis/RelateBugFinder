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

fs.rmSync(out, { force: true });
console.log(`MISSING-FIELD CHECKS PASSED (${n})`);
