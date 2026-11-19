import { build } from "esbuild";
const common = { bundle: true, platform: "node", format: "cjs", target: "node18", sourcemap: true,
  external: ["vscode", "@relate/relate", "typescript"], logLevel: "info" };
await build({ ...common, entryPoints: { extension: "src/extension.ts", cli: "src/cli.ts", mcp: "src/mcp/server.ts" }, outdir: "dist" });
