#!/usr/bin/env node
/**
 * Blast-Radius MCP server (stdio).
 *
 *   node dist/mcp.js --root /path/to/workspace
 *
 * Fast path: forwards each tool call to the running VS Code extension, which owns the live graph.
 * Fallback (VS Code closed): opens `.vscode/codegraph.rl` itself and re-indexes the workspace first.
 */
import * as fs from "fs";
import * as path from "path";
import * as http from "http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { TOOLS, callTool } from "../core/tools";
import { CodeGraph } from "../core/graph";
import { Workspace } from "../core/workspace";
import { bridgeFile, BridgeInfo } from "./bridge";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const ROOT = path.resolve(arg("root") ?? process.env.CODEGRAPH_ROOT ?? process.cwd());
const log = (m: string) => process.stderr.write(`[blast-radius] ${m}\n`);

function viaBridge(name: string, args: unknown): Promise<unknown> {
  let info: BridgeInfo;
  try {
    info = JSON.parse(fs.readFileSync(bridgeFile(ROOT), "utf8"));
  } catch {
    return Promise.reject(Object.assign(new Error("no bridge"), { code: "NOBRIDGE" }));
  }
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: info.port, path: "/tool", method: "POST", headers: { authorization: `Bearer ${info.token}`, "content-type": "application/json" }, timeout: 30_000 },
      (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => {
          try {
            const j = JSON.parse(body);
            if (res.statusCode === 200) resolve(j.result);
            else reject(new Error(j.error ?? `bridge HTTP ${res.statusCode}`));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on("error", (e) => reject(Object.assign(e, { code: (e as NodeJS.ErrnoException).code ?? "NOBRIDGE" })));
    req.end(JSON.stringify({ name, args }));
  });
}

let local: CodeGraph | undefined;
async function viaLocal(name: string, args: Record<string, unknown>): Promise<unknown> {
  if (!local) {
    const file = path.join(ROOT, ".vscode", "codegraph.rl");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    local = CodeGraph.open(file);
    const ws = new Workspace(ROOT, local, { pythonScript: path.join(__dirname, "..", "python", "py_index.py"), log });
    // Always re-index: code may have changed while VS Code was closed, and the git layer can only be
    // linked to functions the Workspace has parsed (a bare refreshGit on an empty Workspace would wipe it).
    log(`indexing ${ROOT} …`);
    const s = await ws.fullIndex();
    log(`indexed ${s.files} files, ${s.functions} functions, ${s.calls} calls in ${s.ms}ms`);
  }
  return callTool(local, ROOT, name, args);
}

async function dispatch(name: string, args: Record<string, unknown>): Promise<unknown> {
  if (!local) {
    try {
      return await viaBridge(name, args);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "NOBRIDGE" && code !== "ECONNREFUSED" && code !== "ECONNRESET") throw e;
      log("VS Code extension not reachable → using the graph file directly");
    }
  }
  return viaLocal(name, args);
}

async function main() {
  const server = new McpServer({ name: "blast-radius", version: "0.1.0" });
  for (const t of TOOLS) {
    const shape: Record<string, z.ZodTypeAny> = {};
    for (const [k, p] of Object.entries(t.params)) {
      let s: z.ZodTypeAny = p.type === "number" ? z.number() : p.type === "object" ? z.record(z.string(), z.any()) : z.string();
      s = s.describe(p.description);
      shape[k] = p.optional ? s.optional() : s;
    }
    server.registerTool(
      t.name,
      { description: t.description, inputSchema: shape, annotations: { readOnlyHint: true, openWorldHint: false } },
      async (args: Record<string, unknown>) => {
        try {
          const result = await dispatch(t.name, args);
          return { content: [{ type: "text" as const, text: JSON.stringify(result, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2) }] };
        } catch (e) {
          return { isError: true, content: [{ type: "text" as const, text: (e as Error).message }] };
        }
      }
    );
  }
  await server.connect(new StdioServerTransport());
  log(`ready for ${ROOT}`);
}

main().catch((e) => {
  log(String(e?.stack ?? e));
  process.exit(1);
});
