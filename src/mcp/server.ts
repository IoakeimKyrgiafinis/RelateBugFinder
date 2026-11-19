#!/usr/bin/env node
/**
 * Blast-Radius MCP server (stdio).
 *
 *   node dist/mcp.js --root /path/to/workspace
 *
 * Fast path: forwards each tool call to the running VS Code extension, which owns the live graph.
 * Fallback (VS Code closed): indexes the workspace into an in-memory graph (never locks the .rl file).
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

/**
 * Fallback graph, built IN MEMORY. Relate only releases a file's writer lock when the process exits, and
 * this server lives as long as the agent session — opening `.vscode/codegraph.rl` here would stop the
 * VS Code extension from starting later. Indexing takes ~1–3 s, so rebuilding when stale is cheap.
 */
const STALE_MS = 15_000;
let local: { graph: CodeGraph; ws: Workspace; at: number } | undefined;
let indexing: Promise<void> | undefined;

async function viaLocal(name: string, args: Record<string, unknown>): Promise<unknown> {
  if (!local) {
    const graph = CodeGraph.open(":memory:");
    local = { graph, ws: new Workspace(ROOT, graph, { pythonScript: path.join(__dirname, "..", "python", "py_index.py"), log }), at: 0 };
  }
  if (Date.now() - local.at > STALE_MS) {
    indexing ??= (async () => {
      const s = await local!.ws.fullIndex();
      local!.at = Date.now();
      log(`indexed ${s.files} files, ${s.functions} functions, ${s.calls} calls in ${s.ms}ms (in memory)`);
    })().finally(() => (indexing = undefined));
    await indexing;
  }
  return callTool(local.graph, ROOT, name, args);
}

async function dispatch(name: string, args: Record<string, unknown>): Promise<unknown> {
  // Always prefer the live graph: VS Code may have been opened since the last call.
  try {
    return await viaBridge(name, args);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "NOBRIDGE" && code !== "ECONNREFUSED" && code !== "ECONNRESET") throw e;
    if (!local) log("VS Code extension not reachable → indexing the workspace in memory");
  }
  return viaLocal(name, args);
}

async function main() {
  const server = new McpServer({ name: "blast-radius", version: "0.1.0" });
  for (const t of TOOLS) {
    const shape: Record<string, z.ZodTypeAny> = {};
    for (const [k, p] of Object.entries(t.params)) {
      let s: z.ZodTypeAny = p.type === "number" ? z.coerce.number() : p.type === "object" ? z.record(z.string(), z.any()) : z.string();
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
