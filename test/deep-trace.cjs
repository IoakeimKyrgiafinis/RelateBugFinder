// Deep trace end to end: run a failing command with the recorders attached, store the run in an
// in-memory Relate graph, and check the ranking uses it. Usage: node test/deep-trace.cjs <demo-workspace>
const path = require("path");
const fs = require("fs");
const os = require("os");
const assert = require("assert");
const { execFileSync } = require("child_process");

const repo = path.join(__dirname, "..");
const out = path.join(__dirname, `.deep-trace-${process.pid}.cjs`);
require("esbuild").buildSync({
  stdin: {
    contents: `export { CodeGraph } from "./src/core/graph"; export { Workspace } from "./src/core/workspace";
               export { traceSuspects } from "./src/core/analysis"; export { runDeepTrace, recordRun } from "./src/core/deepTrace";
               export { relatedTests, testCommandFor } from "./src/core/spectrum";`,
    resolveDir: repo, loader: "ts",
  },
  bundle: true, platform: "node", format: "cjs", outfile: out, logLevel: "error", external: ["@relate/relate", "typescript"],
});
const { CodeGraph, Workspace, traceSuspects, runDeepTrace, recordRun, relatedTests, testCommandFor } = require(out);
const recorderDir = path.join(repo, "python");

async function check(name, root, command, expectTop, newcomer) {
  const g = CodeGraph.open(":memory:");
  const ws = new Workspace(root, g, { pythonScript: path.join(repo, "python", "py_index.py") });
  await ws.fullIndex();
  const res = await runDeepTrace({ root, command, recorderDir });
  assert.notStrictEqual(res.exitCode, 0, `${name}: command should fail`);
  assert.ok(res.records.length > 0, `${name}: nothing recorded`);
  const before = traceSuspects(g, root, res.output, 20);
  const run = recordRun(g, root, res.records, { command, failed: true });
  const after = traceSuspects(g, root, res.output, 20, { run: run.runId });
  const names = (r) => r.suspects.map((s) => s.id.split("#")[1]);
  const top = after.suspects[0];
  try {
    assert.strictEqual(top.id.split("#")[1], expectTop);
    assert.ok(top.reasons.some((x) => x.kind === "ran"), "top suspect has no 'ran' reason");
    if (newcomer) {
      assert.ok(!names(before).includes(newcomer), `${newcomer} should not be a suspect without the deep trace`);
      const s = after.suspects.find((x) => x.id.endsWith("#" + newcomer));
      assert.ok(s && s.relation === "ran" && s.reasons.some((x) => x.kind === "ran"), `${newcomer} should join the suspects because it ran`);
    }
  } catch (e) {
    console.error(`✗ ${name}\n  before: ${names(before).slice(0, 5).join(", ")}\n  after:  ${names(after).slice(0, 5).join(", ")}`);
    throw e;
  }
  console.log(`  ✓ ${name}: ${run.functions} functions ran (${res.ms} ms); #1 ${expectTop} — "${top.reasons.find((x) => x.kind === "ran").text}"${newcomer ? `; ${newcomer} joined the suspects only because it ran` : ""}`);
}

// Spectrum: rare() runs only in the failing test, common() also in the related passing one, so after
// comparing, rare() must outrank common() and say it ran in none of the passing tests.
async function checkSpectrum() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "br-sbfl-py-"));
  fs.mkdirSync(path.join(root, "pkg"));
  fs.mkdirSync(path.join(root, "tests"));
  fs.writeFileSync(path.join(root, "pkg", "__init__.py"), "");
  fs.writeFileSync(path.join(root, "tests", "__init__.py"), "");
  fs.writeFileSync(path.join(root, "pkg", "calc.py"), [
    "def common(x):", "    return x * 2", "",
    "def rare(x):", "    return -x", "",
    "def check(y):", "    if y < 0:", "        raise ValueError('negative')", "    return y", "",
    "def process(x):", "    y = common(x)", "    if x > 5:", "        y = rare(y)", "    return check(y)", "",
  ].join("\n"));
  fs.writeFileSync(path.join(root, "tests", "test_calc.py"), [
    "import unittest", "from pkg.calc import process", "",
    "class CalcTest(unittest.TestCase):",
    "    def test_big(self):", "        self.assertEqual(process(10), 20)", "",
    "    def test_small(self):", "        self.assertEqual(process(2), 4)", "",
  ].join("\n"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  try {
    const g = CodeGraph.open(":memory:");
    const ws = new Workspace(root, g, { pythonScript: path.join(repo, "python", "py_index.py") });
    await ws.fullIndex();
    const command = "python -m unittest -q tests.test_calc.CalcTest.test_big";
    const res = await runDeepTrace({ root, command, recorderDir });
    assert.notStrictEqual(res.exitCode, 0, "failing test should fail");
    const run = recordRun(g, root, res.records, { command, failed: true });
    const cmds = relatedTests(g, run.runId).map((t) => testCommandFor(command, t)).filter(Boolean);
    assert.deepStrictEqual(cmds, ["python -m unittest -q tests.test_calc.CalcTest.test_small"], "related tests");
    const p = await runDeepTrace({ root, command: cmds[0], recorderDir });
    assert.strictEqual(p.exitCode, 0, "related test should pass");
    recordRun(g, root, p.records, { command: cmds[0], failed: false, session: run.runId });
    const after = traceSuspects(g, root, res.output, 20, { run: run.runId });
    const pos = (n) => after.suspects.findIndex((s) => s.id.endsWith("#" + n));
    const rare = after.suspects[pos("rare")];
    assert.ok(pos("rare") >= 0 && (pos("common") < 0 || pos("rare") < pos("common")), `rare should outrank common: ${after.suspects.map((s) => s.id.split("#")[1]).join(", ")}`);
    assert.ok(rare.reasons.some((x) => /none of the 1 related passing test/.test(x.text)), "rare should say it ran in no passing test");
    console.log(`  ✓ Spectrum (related passing test ${cmds[0].split(" ").pop()}): rare #${pos("rare") + 1}, common #${pos("common") + 1} — "${rare.reasons.find((x) => /passing/.test(x.text)).text}"`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

(async () => {
  const demo = process.argv[2];
  await check("Node demo (V8 coverage, TS via type stripping)", demo, "node --experimental-strip-types src/index.ts NOPE", "lookupCoupon");

  // Python: helper() already returned before mark() crashed, so it is never on the stack; only the recording sees it.
  const py = fs.mkdtempSync(path.join(os.tmpdir(), "br-deep-py-"));
  fs.mkdirSync(path.join(py, "pkg"));
  fs.writeFileSync(path.join(py, "pkg", "__init__.py"), "");
  fs.writeFileSync(path.join(py, "pkg", "tracker.py"), [
    "class Tracker:",
    "    def __init__(self):",
    "        self.depth = 0",
    "        self.seen = {(0, 'x'): 1}",
    "    def helper(self):",
    "        return 1",
    "    def inc(self):",
    "        self.depth += self.helper()",
    "    def mark(self, k):",
    "        return self.seen[(self.depth, k)]",
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(py, "main.py"), "from pkg.tracker import Tracker\n\ndef run():\n    t = Tracker()\n    t.inc()\n    return t.mark('x')\n\nrun()\n");
  execFileSync("git", ["init", "-q"], { cwd: py });
  await check("Python, helper that already returned (sys.setprofile recorder)", py, "python main.py", "Tracker.mark", "Tracker.helper");
  fs.rmSync(py, { recursive: true, force: true });

  await checkSpectrum();

  fs.rmSync(out, { force: true });
  console.log("DEEP-TRACE CHECKS PASSED");
})().catch((e) => {
  fs.rmSync(out, { force: true });
  console.error(e);
  process.exit(1);
});
