// Usage: node test/mcp-e2e.mjs <workspace> <trace-file>
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "fs";
import assert from "assert";
import { fileURLToPath } from "url";
const [root, traceFile] = process.argv.slice(2);
const transport = new StdioClientTransport({ command: "node", args: [fileURLToPath(new URL("../dist/mcp.js", import.meta.url)), "--root", root], stderr: "inherit" });
const client = new Client({ name: "e2e", version: "1" });
await client.connect(transport);
const { tools } = await client.listTools();
console.log("tools:", tools.map((t) => t.name).join(", "));
const call = async (name, args) => { const t0 = Date.now(); const r = await client.callTool({ name, arguments: args }); return { ms: Date.now() - t0, isError: r.isError, data: JSON.parse(r.content[0].text.startsWith("{") || r.content[0].text.startsWith("[") ? r.content[0].text : JSON.stringify(r.content[0].text)) }; };
const tr = await call("trace_error_suspects", { stack_trace: fs.readFileSync(traceFile, "utf8"), limit: 3 });
console.log(`trace (${tr.ms}ms):`, tr.data.suspects.map((s) => `#${s.rank} ${s.id} ${s.score}`).join(" | "));
const br = await call("get_blast_radius", { target: "applyDiscount" });
console.log(`blast (${br.ms}ms):`, br.data.summary);
const cy = await call("find_circular_dependencies", {});
console.log(`cycles (${cy.ms}ms):`, cy.data.cycles);
const rc = await call("find_recent_suspects", { hours: 24 });
console.log(`recent (${rc.ms}ms):`, rc.data.map((r) => `${r.id} (${r.changed})`).join(", "));
const q = await call("query_codegraph", { cypher: "MATCH (c:Commit)-[:TOUCHED]->(f:Function) WHERE c.author = $a RETURN f.id AS fn", params: { a: "Alex Rivera" } });
console.log(`cypher (${q.ms}ms):`, JSON.stringify(q.data.rows));
const w = await call("query_codegraph", { cypher: "MATCH (f:Function) DETACH DELETE f" });
console.log("write attempt:", w.isError, w.data);

// The graph must carry git history in every mode (a past bug wiped it in the standalone fallback).
assert.equal(tools.length, 5);
assert.equal(tr.data.suspects[0].id, "src/coupons.ts#lookupCoupon", "wrong top suspect");
assert.match(br.data.summary, /applyDiscount/);
assert.ok(cy.data.count >= 1, "expected the demo's import cycle");
assert.ok(rc.data.some((r) => r.id === "src/coupons.ts#lookupCoupon"), "recent changes lost");
assert.deepEqual(q.data.rows, [{ fn: "src/coupons.ts#lookupCoupon" }]);
assert.ok(w.isError, "write query was not rejected");
console.log("MCP E2E CHECKS PASSED");
await client.close();
