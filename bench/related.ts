/**
 * Pick the related passing tests to record for one bug, the same way the extension does:
 * index the workspace, store the failing deep-trace run, ask the graph (spectrum.ts relatedTests).
 *
 *   node bench/.dist/related.cjs <workspace> <deepTraceDir> <failingCommand> [max]   → prints JSON [commands]
 */
import * as path from "path";
import { CodeGraph } from "../src/core/graph";
import { Workspace } from "../src/core/workspace";
import { readRecords, recordRun } from "../src/core/deepTrace";
import { relatedTests, testCommandFor } from "../src/core/spectrum";

async function main() {
  const [root, deepDir, failing, maxStr] = process.argv.slice(2);
  const g = CodeGraph.open(":memory:");
  const ws = new Workspace(root, g, { pythonPath: process.env.BENCH_INDEX_PYTHON || "python", pythonScript: path.join(__dirname, "..", "..", "python", "py_index.py"), gitSinceDays: 30 });
  await ws.fullIndex();
  const records = readRecords(deepDir, root);
  if (!records.length) return console.log("[]");
  const run = recordRun(g, root, records, { command: "bench", failed: true });
  const cmds = relatedTests(g, run.runId, Number(maxStr ?? 8)).map((t) => testCommandFor(failing, t)).filter(Boolean);
  console.log(JSON.stringify(cmds));
}
main().catch((e) => {
  console.error(String(e?.stack ?? e));
  console.log("[]");
});
