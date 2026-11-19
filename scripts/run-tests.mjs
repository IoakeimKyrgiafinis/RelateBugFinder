#!/usr/bin/env node
// `npm test`: builds a throwaway copy of the demo in the OS temp dir and runs every suite against it,
// so tests never touch ./demo-shop (the extension test commits a file into its workspace).
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const run = (args, label) => {
  console.log(`\n── ${label}`);
  execFileSync("node", args, { cwd: repo, stdio: "inherit" });
};
const fresh = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blast-radius-test-"));
  execFileSync("node", [path.join(repo, "demo", "setup-demo.mjs"), dir], { stdio: "pipe" });
  return dir;
};

if (!fs.existsSync(path.join(repo, "dist", "extension.js"))) run(["esbuild.mjs"], "build");

run(["test/stack-trace.cjs"], "Stack-trace parsing (pytest long/short, Python, Node, Windows paths)");
run(["test/value-origin.cjs"], "Where did the undefined come from? (TS/JS/Python unit cases)");
run(["test/missing-field.cjs"], "Which field was missing? (Python AttributeError, self./this. fields)");
const a = fresh();
run(["test/mcp-lock.mjs", a], "MCP server with VS Code closed (in-memory graph, no file lock)");
run(["test/mcp-e2e.mjs", a, path.join(a, "trace.txt")], "MCP tools, standalone");
run(["test/deep-trace.cjs", a], "Deep trace: re-run with recorders (Node V8 coverage, Python sys.setprofile) into Relate");
run(["test/e2e-deep.cjs"], "Deep trace through the extension UI: notification, panel buttons, confirmations, runs in the live graph");
const b = fresh();
run(["test/e2e.cjs", b, path.join(b, "trace.txt")], "Extension end to end (mocked VS Code API) + MCP via live bridge");

for (const d of [a, b]) fs.rmSync(d, { recursive: true, force: true });
console.log("\nALL TEST SUITES PASSED");
