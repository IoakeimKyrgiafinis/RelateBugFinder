import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { randomBytes } from "crypto";
import { CodeGraph } from "../core/graph";
import { callTool } from "../core/tools";

export interface BridgeInfo {
  port: number;
  token: string;
  pid: number;
  root: string;
}

export function bridgeFile(root: string) {
  return path.join(root, ".vscode", "codegraph.bridge.json");
}

/**
 * Relate allows one writer per `.rl` file, and the extension holds it. So instead of the MCP server
 * opening the file, it forwards tool calls here: a localhost-only HTTP endpoint guarded by a random token.
 * The agent then queries the *live* in-memory graph, including edits that were saved a second ago.
 */
export function startBridge(root: string, getGraph: () => CodeGraph | undefined, log: (m: string) => void): Promise<{ info: BridgeInfo; close: () => void }> {
  const token = randomBytes(24).toString("hex");
  const server = http.createServer((req, res) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    };
    if (req.headers.authorization !== `Bearer ${token}`) return send(401, { error: "bad token" });
    if (req.method === "GET" && req.url === "/health") return send(200, { ok: true, root });
    if (req.method !== "POST" || req.url !== "/tool") return send(404, { error: "not found" });
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const g = getGraph();
      if (!g) return send(503, { error: "Graph is still indexing, retry in a moment." });
      try {
        const { name, args } = JSON.parse(body);
        const t0 = Date.now();
        const result = callTool(g, root, name, args ?? {});
        log(`MCP ${name} answered in ${Date.now() - t0}ms`);
        send(200, { result });
      } catch (e) {
        send(400, { error: (e as Error).message });
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      const info: BridgeInfo = { port, token, pid: process.pid, root };
      fs.mkdirSync(path.dirname(bridgeFile(root)), { recursive: true });
      fs.writeFileSync(bridgeFile(root), JSON.stringify(info, null, 2), { mode: 0o600 });
      resolve({
        info,
        close: () => {
          server.close();
          try {
            const cur = JSON.parse(fs.readFileSync(bridgeFile(root), "utf8"));
            if (cur.token === token) fs.unlinkSync(bridgeFile(root));
          } catch {
            /* already gone */
          }
        },
      });
    });
  });
}
