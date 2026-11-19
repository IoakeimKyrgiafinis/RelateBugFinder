// Which values does an error name, and which recorded function returned them first? Usage: node test/bad-values.cjs
const path = require("path");
const fs = require("fs");
const assert = require("assert");
const out = path.join(__dirname, `.bad-values-${process.pid}.cjs`);
require("esbuild").buildSync({
  stdin: { contents: `export { badValues, sameValue } from "./src/core/badValues"; export { returnedBad } from "./src/core/analysis";`, resolveDir: path.join(__dirname, ".."), loader: "ts" },
  bundle: true, platform: "node", format: "cjs", outfile: out, logLevel: "error", external: ["@relate/relate", "typescript"],
});
const { badValues, sameValue, returnedBad } = require(out);
fs.rmSync(out, { force: true });

let n = 0;
const check = (name, msg, trace, want) => {
  const got = badValues(msg, trace).map((b) => `${b.v}:${b.role}`);
  assert.deepStrictEqual(got, want, `${name}: got ${JSON.stringify(got)}`);
  n++;
};
check("unittest assertEqual", "AssertionError: -10.000000000000014 != 90", "", ["-10.000000000000014:actual", "90:mentioned"]);
check("unittest strings", "AssertionError: 'EUR' != 'eur'", "", ["'EUR':actual", "'eur':mentioned"]);
check("unittest with msg", "AssertionError: 3 != 4 : wrong count", "", ["3:actual", "4:mentioned"]);
check("pytest assert + where", "AssertionError: assert -10.0 == 90", "E       AssertionError: assert -10.0 == 90\nE        +  where -10.0 = order_total(10)", ["-10.0:actual", "90:mentioned"]);
check("pytest bare assert line", "assert 3 == 4", "E       assert 3 == 4", ["3:actual", "4:mentioned"]);
check("ValueError with number", "ValueError: negative total: -10.000000000000014", "", ["-10.000000000000014:mentioned"]);
check("KeyError", "KeyError: 'eur'", "", ["'eur':mentioned"]);
check("NoneType attribute", "AttributeError: 'NoneType' object has no attribute 'pct'", "", ["None:actual", "'pct':mentioned"]);
check("complex sides are skipped", "AssertionError: [1, 2, 3] != [1, 2]", "", []);
check("no values", "RuntimeError: boom", "", []);
assert.ok(sameValue("90", "90.0") && sameValue("'eur'", '"eur"') && !sameValue("'eur'", "'EUR'"));
n++;

// Origin = the producer that returned the value earliest in the chain (largest "ago").
const ex = (rets) => ({ count: 1, since: 0, lines: [], rets: rets.map(([v, ago]) => ({ v, n: 1, ago })) });
const executed = new Map([
  ["p#bulk_discount", ex([["-10.0", 2]])],
  ["p#validate", ex([["-10.0", 1]])],
  ["p#order_total", ex([["-10.0", 0]])],
  ["p#subtotal", ex([["100", 3]])],
  ["p#log", ex([["None", 0]])], // a procedure: always None, never "produces" None
  ["p#find", ex([["None", 4], ["<Coupon>", 9]])],
]);
const r = returnedBad(executed, [{ v: "-10.0", role: "actual" }]);
assert.deepStrictEqual(r.filter((x) => x.origin).map((x) => x.id), ["p#bulk_discount"]);
assert.strictEqual(r.length, 3);
const none = returnedBad(executed, [{ v: "None", role: "actual" }]);
assert.deepStrictEqual(none.map((x) => x.id), ["p#find"]);
n++;
console.log(`BAD-VALUE CHECKS PASSED (${n})`);
