// Deep trace on a real developer machine: the project's venv, the user's shell, Cancel, coverage tools.
// Usage: node test/run-env.cjs
const path = require("path");
const fs = require("fs");
const os = require("os");
const assert = require("assert");
const { execFileSync } = require("child_process");

const repo = path.join(__dirname, "..");
const out = path.join(__dirname, `.run-env-${process.pid}.cjs`);
require("esbuild").buildSync({
  stdin: { contents: `export { runDeepTrace, explainDeepTrace } from "./src/core/deepTrace"; export { findProjectVenv, shellRun } from "./src/core/pyenv";`, resolveDir: repo, loader: "ts" },
  bundle: true, platform: "node", format: "cjs", outfile: out, logLevel: "error", external: ["@relate/relate", "typescript"],
});
const { runDeepTrace, explainDeepTrace, findProjectVenv } = require(out);
fs.rmSync(out, { force: true });
const recorderDir = path.join(repo, "python");
const ok = (m) => console.log("  ✓ " + m);
const WIN = process.platform === "win32";
const which = (exe) => { try { return execFileSync(WIN ? "where" : "which", [exe], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split(/\r?\n/)[0].trim(); } catch { return undefined; } };

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "br-run-env-"));
  try {
    fs.mkdirSync(path.join(root, "pkg"));
    fs.writeFileSync(path.join(root, "pkg", "__init__.py"), "");
    fs.writeFileSync(path.join(root, "pkg", "work.py"), "def f(x):\n    if x > 1:\n        return x * 2\n    return 0\n");

    // 1. The project's .venv is used (first on PATH, VIRTUAL_ENV set), not whatever python the host has.
    execFileSync("python", ["-m", "venv", "--without-pip", path.join(root, ".venv")], { stdio: "ignore" });
    const venv = findProjectVenv(root);
    assert.ok(venv && venv.source === ".venv", "findProjectVenv should find .venv");
    const r1 = await runDeepTrace({ root, recorderDir, pyEnv: venv, command: `python -c "import sys; print('PREFIX=' + sys.prefix)"` });
    const prefix = /PREFIX=(.*)/.exec(r1.output)?.[1]?.trim();
    assert.ok(prefix && path.resolve(prefix).toLowerCase() === path.join(root, ".venv").toLowerCase(), `ran with ${prefix}, expected the project's .venv`);
    ok(`project .venv used: sys.prefix = ${prefix}`);

    // 2. The user's shell: PowerShell syntax (Windows) / bash syntax survives, and the exit code comes back.
    const ps = WIN ? which("pwsh") ?? which("powershell") : undefined;
    const sh = WIN ? ps : which("bash");
    if (sh) {
      const cmd = WIN ? `$env:BR_X = '42'; python -c "import os, sys; sys.exit(int(os.environ['BR_X']))"` : `BR_X=42 python -c "import os, sys; sys.exit(int(os.environ['BR_X']))"`;
      const r2 = await runDeepTrace({ root, recorderDir, command: cmd, shellPath: sh });
      assert.strictEqual(r2.exitCode, 42, `exit code through ${path.basename(sh)}: ${r2.exitCode}\n${r2.output}`);
      ok(`${path.basename(sh)} syntax re-runs as typed, exit code 42 comes back: ${cmd}`);
    } else ok("(no PowerShell/bash found: shell check skipped)");

    // 3. Cancel stops the whole process tree quickly; nothing is recorded.
    const marker = path.join(root, "still-running.txt");
    const ac = new AbortController();
    const t0 = Date.now();
    setTimeout(() => ac.abort(), 1500);
    const r3 = await runDeepTrace({ root, recorderDir, signal: ac.signal, command: `python -c "import time, pathlib; time.sleep(6); pathlib.Path(r'${marker}').write_text('x')"` });
    const took = Date.now() - t0;
    await new Promise((r) => setTimeout(r, 6500));
    assert.strictEqual(r3.stopped, "cancelled");
    assert.ok(took < 5000, `cancel took ${took} ms`);
    assert.ok(!fs.existsSync(marker), "the python child kept running after Cancel");
    assert.match(explainDeepTrace(r3).text, /cancelled/);
    ok(`Cancel stopped the shell and its python child after ${took} ms`);

    // 4. A coverage tool's tracer doesn't switch the recorder off.
    const competitor = [
      "import sys",
      "def other(frame, event, arg):",
      "    return other",
      "sys.settrace(other)  # what coverage's tracer does (pre-3.12 path)",
      "mon = getattr(sys, 'monitoring', None)",
      "if mon:",
      "    mon.use_tool_id(mon.COVERAGE_ID, 'fake-coverage')",
      "    mon.register_callback(mon.COVERAGE_ID, mon.events.LINE, lambda code, n: None)",
      "    mon.set_events(mon.COVERAGE_ID, mon.events.LINE)",
      "from pkg.work import f",
      "f(5)",
      "raise SystemExit(1)",
    ].join("\n");
    fs.writeFileSync(path.join(root, "main.py"), competitor);
    const fRec = (r) => r.records.find((x) => x.name === "f");
    const r4 = await runDeepTrace({ root, recorderDir, command: "python main.py" });
    const modern = r4.recorders[0]?.mode === "monitoring";
    assert.ok(fRec(r4), "f() should be recorded despite another tracer");
    assert.deepStrictEqual(fRec(r4).rets.map((x) => x.v), ["10"]);
    if (modern) {
      assert.deepStrictEqual(fRec(r4).lines, [2, 3], "lines should still be recorded with sys.monitoring");
      ok(`Python ${r4.recorders[0].version} (sys.monitoring): with a fake coverage tool active, f() still recorded: returned 10, lines 2–3`);
    }
    const r5 = await runDeepTrace({ root, recorderDir, command: "python main.py", env: { ...process.env, BR_TRACE_LEGACY: "1" } });
    assert.ok(fRec(r5), "legacy path: f() should still be recorded (setprofile)");
    assert.deepStrictEqual(fRec(r5).rets.map((x) => x.v), ["10"]);
    assert.strictEqual(r5.recorders[0].lines, "replaced");
    assert.match(explainDeepTrace(r5).text, /took over line recording/);
    ok(`pre-3.12 path: calls and return values survive a replaced tracer, and the user is told lines are missing`);

    // 5. Messages that say what went wrong.
    const r6 = await runDeepTrace({ root, recorderDir, command: `python -c "import not_installed_pkg_xyz"` });
    assert.match(explainDeepTrace(r6).text, /could not import your code/);
    const r7 = await runDeepTrace({ root, recorderDir, command: "definitely-not-a-command-xyz" });
    assert.match(explainDeepTrace(r7).text, /not found/);
    const r8 = await runDeepTrace({ root, recorderDir, command: `python -c "from pkg.work import f; f(1)"` });
    assert.match(explainDeepTrace(r8).text, /passed when re-run/);
    const r9 = await runDeepTrace({ root, recorderDir, timeoutMs: 800, command: `python -c "import time; time.sleep(5)"` });
    assert.match(explainDeepTrace(r9).text, /time limit/);
    ok("clear messages: wrong environment (import error), command not found, passed this time (flaky), time limit");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log("RUN-ENV CHECKS PASSED");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
