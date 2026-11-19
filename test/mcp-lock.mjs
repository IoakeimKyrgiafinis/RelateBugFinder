// Usage: node test/mcp-lock.mjs <workspace>
// With VS Code closed, the MCP server must answer from an in-memory graph and must NOT hold
// .vscode/codegraph.rl, so the extension (or the CLI) can still open it while the agent session runs.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import assert from "assert";

const [root] = process.argv.slice(2);
const dist = (f) => fileURLToPath(new URL(`../dist/${f}`, import.meta.url));
const transport = new StdioClientTransport({ command: "node", args: [dist("mcp.js"), "--root", root], stderr: "pipe" });
const client = new Client({ name: "lock-test", version: "1" });
await client.connect(transport);
const res = await client.callTool({ name: "find_recent_suspects", arguments: { hours: "48" } });
const recent = JSON.parse(res.content[0].text);
assert.ok(recent.length > 0, "fallback graph has no git history");
console.log(`✓ fallback answered (${recent.length} recent suspects, string arg accepted)`);

const bad = await client.callTool({ name: "query_codegraph", arguments: { cypher: "MATCH p=(a)-[:CALLS*]->(b) RETURN count(p)" } });
assert.ok(bad.isError && /upper bound/.test(bad.content[0].text), "unbounded path query was not rejected");
console.log("✓ unbounded variable-length query rejected");

// While the MCP server is still running, a writer must be able to open the graph file.
execFileSync("node", [dist("cli.js"), "index", root], { stdio: "pipe" });
console.log("✓ graph file still openable by a writer while the MCP server runs");
await client.close();
console.log("MCP LOCK CHECKS PASSED");
