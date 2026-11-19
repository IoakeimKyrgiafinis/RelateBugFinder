// Unit tests for the stack-trace parser (src/core/stackTrace.ts). Usage: node test/stack-trace.cjs
const path = require("path");
const fs = require("fs");
const assert = require("assert");

const out = path.join(__dirname, `.stack-trace-${process.pid}.cjs`);
require("esbuild").buildSync({ entryPoints: [path.join(__dirname, "..", "src", "core", "stackTrace.ts")], bundle: true, platform: "node", format: "cjs", outfile: out, logLevel: "error" });
const { parseStackTrace, mapToWorkspace } = require(out);
let n = 0;
const check = (name, text, expect) => {
  const r = parseStackTrace(text);
  const frames = r.frames.map((f) => `${f.file}:${f.line}`);
  try {
    if (expect.message) assert.equal(r.message, expect.message);
    assert.deepStrictEqual(frames, expect.frames);
  } catch (e) {
    console.error(`✗ ${name}\n  got: ${JSON.stringify({ message: r.message, frames })}`);
    throw e;
  }
  n++;
  console.log(`  ✓ ${name}`);
};

check("pytest default (long) format", `
__________________________ test_get_new_command __________________________

    def test_get_new_command():
>       assert get_new_command(Command('pip un+install', '')) == 'pip uninstall'

tests/rules/test_pip.py:25:
_ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _

command = Command(script=pip un+install, output=)

    def get_new_command(command):
>       broken_cmd = re.findall(r'ERROR: unknown command "([a-z]+)"', command.output)[0]
E       IndexError: list index out of range

thefuck/rules/pip_unknown_command.py:16: IndexError
`, { message: "IndexError: list index out of range", frames: ["thefuck/rules/pip_unknown_command.py:16", "tests/rules/test_pip.py:25"] });

check("pytest --tb=short", `
tests/test_a.py:5: in test_x
    f()
pkg/mod.py:12: in f
    return g().name
E   AttributeError: 'NoneType' object has no attribute 'name'
`, { message: "AttributeError: 'NoneType' object has no attribute 'name'", frames: ["pkg/mod.py:12", "tests/test_a.py:5"] });

check("pytest skips site-packages frames", `
tests/test_a.py:5:
_ _ _
venv/lib/python3.8/site-packages/requests/api.py:61: in get
    return x
pkg/net.py:9: ConnectionError
`, { frames: ["pkg/net.py:9", "tests/test_a.py:5"] });

check("Python traceback, Windows paths and stdlib skipped", `
Traceback (most recent call last):
  File "C:\\work\\app\\main.py", line 10, in <module>
    run()
  File "C:\\work\\app\\svc.py", line 4, in run
    json.loads(None)
  File "C:\\Python38\\Lib\\json\\__init__.py", line 341, in loads
    raise TypeError
TypeError: the JSON object must be str, bytes or bytearray, not NoneType
`, { message: "TypeError: the JSON object must be str, bytes or bytearray, not NoneType", frames: ["C:/work/app/svc.py:4", "C:/work/app/main.py:10"] });

check("Node with file:// URLs, node_modules and internals skipped", `
TypeError: Cannot read properties of undefined (reading 'pct')
    at Cart.total (file:///C:/shop/src/cart.ts:23:43)
    at Object.handle (C:\\shop\\node_modules\\express\\lib\\router.js:5:1)
    at checkout (file:///C:/shop/src/checkout.ts:12:10)
    at ModuleJob.run (node:internal/modules/esm/module_job:561:25)
`, { message: "TypeError: Cannot read properties of undefined (reading 'pct')", frames: ["C:/shop/src/cart.ts:23", "C:/shop/src/checkout.ts:12"] });

assert.equal(mapToWorkspace("C:/shop/src/cart.ts", "C:\\shop", ["src/cart.ts"]), "src/cart.ts");
assert.equal(mapToWorkspace("/app/src/cart.ts", "/home/me/shop", ["src/cart.ts"]), "src/cart.ts");
assert.equal(mapToWorkspace("dist/cart.js", "/x", ["src/cart.ts"]), "src/cart.ts");
console.log("  ✓ path mapping (Windows root, Docker prefix, dist → src)");

fs.rmSync(out, { force: true });
console.log(`STACK-TRACE CHECKS PASSED (${n + 1})`);
