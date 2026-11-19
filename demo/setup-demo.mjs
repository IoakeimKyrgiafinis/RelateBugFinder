#!/usr/bin/env node
// Cross-platform (macOS / Linux / Windows): builds ./demo-shop, a small TS + Python repo whose
// git history hides a bug committed "3 hours ago".   Usage: node demo/setup-demo.mjs [target-dir]
import { execFileSync, spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(process.argv[2] ?? "demo-shop");
const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] }).toString();

fs.rmSync(dir, { recursive: true, force: true });
fs.cpSync(path.join(here, "shop"), dir, { recursive: true });
git("init", "-q");
git("checkout", "-q", "-b", "main");
git("config", "user.email", "dev@example.com");
git("config", "user.name", "Dana Dev");
git("config", "core.autocrlf", "false");

function commit(hoursAgo, author, message) {
  const date = new Date(Date.now() - hoursAgo * 3600_000).toISOString();
  git("add", "-A");
  execFileSync("git", ["commit", "-q", "-m", message], {
    cwd: dir,
    env: { ...process.env, GIT_AUTHOR_NAME: author, GIT_COMMITTER_NAME: author, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
}
const edit = (file, from, to) => {
  const p = path.join(dir, file);
  const s = fs.readFileSync(p, "utf8");
  if (!s.includes(from)) throw new Error(`demo edit failed in ${file}`);
  fs.writeFileSync(p, s.replace(from, to));
};

commit(480, "Dana Dev", "Initial shop: cart, money, coupons, checkout");
edit("src/inventory.ts", '"TEE-02": 3', '"TEE-02": 5');
commit(120, "Sam Ops", "Restock tees");
fs.copyFileSync(path.join(here, "changes", "coupons.ts"), path.join(dir, "src", "coupons.ts"));
commit(3, "Alex Rivera", "Support regional coupon pools"); // ← the bug
// Uncommitted, unrelated tweak: recent but not connected to the crash, so it must NOT rank.
edit("src/inventory.ts", "return (STOCK[sku] ?? 0) >= qty;", "return qty > 0 && (STOCK[sku] ?? 0) >= qty;");

// Capture a real crash for the CLI / tests (needs Node ≥ 22.6 for TypeScript type-stripping).
fs.appendFileSync(path.join(dir, ".git", "info", "exclude"), "trace.txt\n");
const r = spawnSync(process.execPath, ["--experimental-strip-types", "src/index.ts", "NOPE"], { cwd: dir, encoding: "utf8" });
if (r.stderr?.includes("at ")) fs.writeFileSync(path.join(dir, "trace.txt"), r.stderr);
else console.warn("Could not capture trace.txt (Node ≥ 22.6 needed to run .ts directly).");

console.log(`Demo repo ready in ${dir}`);
console.log("Reproduce the crash:  cd demo-shop && npm start -- NOPE");
