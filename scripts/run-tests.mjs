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

run(["test/value-origin.cjs"], "Where did the undefined come from? (TS/JS/Python unit cases)");
const a = fresh();
run(["test/mcp-lock.mjs", a], "MCP server with VS Code closed (in-memory graph, no file lock)");
run(["test/mcp-e2e.mjs", a, path.join(a, "trace.txt")], "MCP tools, standalone");
const b = fresh();
run(["test/e2e.cjs", b, path.join(b, "trace.txt")], "Extension end to end (mocked VS Code API) + MCP via live bridge");

for (const d of [a, b]) fs.rmSync(d, { recursive: true, force: true });
console.log("\nALL TEST SUITES PASSED");
