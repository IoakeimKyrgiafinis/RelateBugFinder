// Unit tests for "where did the undefined come from?" (src/core/valueOrigin.ts).
// Usage: node test/value-origin.cjs      (bundles the module on the fly with esbuild)
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

const out = path.join(__dirname, `.value-origin-${process.pid}.cjs`); // next to the repo so `typescript` resolves
require("esbuild").buildSync({ entryPoints: [path.join(__dirname, "..", "src", "core", "valueOrigin.ts")], bundle: true, platform: "node", format: "cjs", outfile: out, external: ["typescript"], logLevel: "error" });
const { parseNullishError, findValueOrigin } = require(out);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "vo-"));

let n = 0;
/** `src` marks the crash line with `// <-` (or `# <-`); the column is where `prop` appears on it. */
function check(name, file, src, message, expect) {
  const lines = src.replace(/^\n/, "").split("\n");
  const idx = lines.findIndex((l) => /(\/\/|#) <-/.test(l));
  assert.ok(idx >= 0, `${name}: no crash marker`);
  const clean = lines.map((l) => l.replace(/\s*(\/\/|#) <-.*$/, "")).join("\n");
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), clean);
  const err = parseNullishError(message);
  assert.ok(err, `${name}: message not recognised: ${message}`);
  const col = err.property ? lines[idx].indexOf(err.property) + 1 : undefined;
  const o = findValueOrigin(root, file, idx + 1, col || undefined, err);
  assert.ok(o, `${name}: no origin found`);
  try {
    for (const [k, v] of Object.entries(expect)) {
      const got = k === "expression" ? o.expression : k === "summary" ? o.summary : o.source[k];
      if (v instanceof RegExp) assert.match(String(got), v, k);
      else assert.deepStrictEqual(got, v, k);
    }
  } catch (e) {
    console.error(`✗ ${name}\n  got: ${JSON.stringify(o)}`);
    throw e;
  }
  n++;
  console.log(`  ✓ ${name}: ${o.summary}`);
}

const V8 = (p) => `TypeError: Cannot read properties of undefined (reading '${p}')`;

// ---------------------------------------------------------------- TypeScript / JavaScript
check("const from a call (the demo)", "a.ts", `
export function total(code: string) {
  const coupon = lookupCoupon(code);
  return coupon.pct; // <-
}`, V8("pct"), { expression: "coupon", kind: "call", callee: "lookupCoupon", line: 2, code: "const coupon = lookupCoupon(code)" });

check("parameter: the caller passed it", "b.ts", `
export function greet(prefix: string, user: User) {
  return prefix + user.name; // <-
}`, V8("name"), { expression: "user", kind: "param", param: "user", index: 1, fnName: "greet", summary: /passed undefined \(or left it out\) as argument #2/ });

check("call used directly", "c.ts", `
function f() {
  return getUser().name; // <-
}`, V8("name"), { expression: "getUser()", kind: "call", callee: "getUser" });

check("latest reassignment wins", "d.js", `
function f(a) {
  let x = first();
  if (a) x = second(a);
  return x.value; // <-
}`, V8("value"), { kind: "call", callee: "second", line: 3 });

check("destructured from a call", "e.ts", `
async function f() {
  const { coupon, items } = await getCart();
  return coupon.pct; // <-
}`, V8("pct"), { kind: "call", callee: "getCart" });

check("Array.find returned undefined", "f.ts", `
function f(items: Item[], sku: string) {
  const item = items.find((i) => i.sku === sku);
  return item.price; // <-
}`, V8("price"), { kind: "call", callee: "find", calleeText: "items.find" });

check("index lookup", "g.ts", `
function f(users: Record<string, User>, id: string) {
  const u = users[id];
  return u.email; // <-
}`, V8("email"), { kind: "index", text: "users[id]" });

check("field set elsewhere in the class", "h.ts", `
class Client {
  config?: Config;
  init() { this.config = loadConfig(); }
  timeout() {
    return this.config.timeout; // <-
  }
}`, V8("timeout"), { expression: "this.config", kind: "field", line: 3 });

check("nested function's variable is ignored", "i.ts", `
function outer(order: Order) {
  const helper = () => { const order = other(); return order; };
  return order.id; // <-
}`, V8("id"), { kind: "param", param: "order" });

check("two accesses on one line: column picks the right one", "j.ts", `
function f(a: A) {
  const b = make();
  return a.size + b.size; // <-
}`, V8("size"), { expression: "a", kind: "param" }); // column points at the first .size (a)

check("null, old V8 wording", "k.js", `
function f() {
  const el = document.getElementById("app");
  el.innerHTML = "hi"; // <-
}`, "TypeError: Cannot set properties of null (setting 'innerHTML')", { kind: "call", callee: "getElementById", summary: /when setting \.innerHTML/ });

check("Firefox wording", "l.ts", `
function f() {
  const coupon = lookupCoupon("X");
  return coupon.pct; // <-
}`, `TypeError: can't access property "pct", coupon is undefined`, { expression: "coupon", kind: "call", callee: "lookupCoupon" });

check("Safari wording", "m.ts", `
function f() {
  const coupon = lookupCoupon("X");
  return coupon.pct; // <-
}`, "TypeError: undefined is not an object (evaluating 'coupon.pct')", { expression: "coupon", kind: "call", callee: "lookupCoupon" });

check("destructuring an undefined result", "n.ts", `
function f() {
  const { name } = findUser(); // <-
  return name;
}`, "TypeError: Cannot destructure property 'name' of 'findUser(...)' as it is undefined.", { kind: "call", callee: "findUser" });

// ------------------------------------------------------------------------------- Python
check("Python: assigned from a method call", "svc/users.py", `
def display_name(repo, user_id):
    user = repo.get(user_id)
    return user.name  # <-
`, "AttributeError: 'NoneType' object has no attribute 'name'", { expression: "user", kind: "call", callee: "get", calleeText: "repo.get", line: 2 });

check("Python: parameter (self skipped)", "svc/report.py", `
class Report:
    def render(self, data, style):
        return style.color  # <-
`, "AttributeError: 'NoneType' object has no attribute 'color'", { kind: "param", param: "style", index: 1, fnName: "render" });

check("Python: not subscriptable", "svc/cfg.py", `
def port():
    cfg = load_config()
    return cfg["port"]  # <-
`, "TypeError: 'NoneType' object is not subscriptable", { expression: "cfg", kind: "call", callee: "load_config" });

check("Python: self field", "svc/client.py", `
class Client:
    def connect(self):
        self.conn = open_socket()
    def send(self, msg):
        return self.conn.write(msg)  # <-
`, "AttributeError: 'NoneType' object has no attribute 'write'", { expression: "self.conn", kind: "field", line: 3, code: "self.conn = open_socket()" });

// ------------------------------------------------------------------------- not this kind
assert.equal(parseNullishError("TypeError: x.map is not a function"), undefined);
assert.equal(parseNullishError("ReferenceError: foo is not defined"), undefined);
console.log("  ✓ unrelated errors are left alone");

fs.rmSync(root, { recursive: true, force: true });
fs.rmSync(out, { force: true });
console.log(`VALUE-ORIGIN CHECKS PASSED (${n + 1})`);
