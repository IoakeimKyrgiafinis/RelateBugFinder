// Builds one VSIX per platform: Relate (and koffi) ship native binaries per OS/arch.
import { execSync } from "child_process";
import fs from "fs";
const targets = [["darwin", "arm64"], ["darwin", "x64"], ["linux", "x64"], ["linux", "arm64"], ["win32", "x64"]];
const only = process.argv[2];
const v = JSON.parse(fs.readFileSync("node_modules/@relate/relate/package.json", "utf8")).version;
const kv = JSON.parse(fs.readFileSync("node_modules/koffi/package.json", "utf8")).version;
const sh = (c) => execSync(c, { stdio: "inherit" });
fs.mkdirSync("dist-vsix", { recursive: true });
sh("node esbuild.mjs");
for (const [os, cpu] of targets) {
  const t = `${os}-${cpu}`;
  if (only && only !== t) continue;
  fs.rmSync("node_modules/@koromix", { recursive: true, force: true });
  for (const d of fs.readdirSync("node_modules/@relate")) if (d.startsWith("relate-") && d !== "relate-wasm") fs.rmSync(`node_modules/@relate/${d}`, { recursive: true, force: true });
  sh(`npm install --no-save --force --os=${os} --cpu=${cpu} @relate/relate-${t}@${v} @koromix/koffi-${t}@${kv}`);
  sh(`npx vsce package --target ${t} -o dist-vsix/blast-radius-${t}.vsix`);
}
// restore host binaries
sh("npm install --no-save --force");
