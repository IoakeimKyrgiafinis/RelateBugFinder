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

fs.rmSync(out, { force: true });
console.log(`MISSING-FIELD CHECKS PASSED (${n})`);
