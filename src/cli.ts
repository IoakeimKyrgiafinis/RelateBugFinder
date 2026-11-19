#!/usr/bin/env node
/**
 * blast-radius CLI — same engine as the VS Code extension.
 *   blast-radius index   [root]
 *   blast-radius trace   [root] < stacktrace.txt
 *   blast-radius blast   [root] <file|file:line|symbol>
 *   blast-radius cycles  [root]
 *   blast-radius recent  [root] [hours]
 *   blast-radius cypher  [root] "<read-only cypher>"
 */
import * as fs from "fs";
import * as path from "path";
import { CodeGraph } from "./core/graph";
import { Workspace } from "./core/workspace";
import { blastRadius, circularDependencies, recentChanges, traceSuspects } from "./core/analysis";

export function graphPath(root: string) {
  return path.join(root, ".vscode", "codegraph.rl");
}

async function main() {
  const [cmd, rootArg, ...rest] = process.argv.slice(2);
  const root = path.resolve(rootArg ?? ".");
  if (!cmd) {
    console.log("usage: blast-radius <index|trace|blast|cycles|recent|cypher> [root] [...]");
    process.exit(1);
  }
  fs.mkdirSync(path.join(root, ".vscode"), { recursive: true });
  const g = CodeGraph.open(graphPath(root));
  const ws = new Workspace(root, g, { pythonScript: path.join(__dirname, "..", "python", "py_index.py"), log: (m) => console.error(m) });
  const out = (o: unknown) => console.log(JSON.stringify(o, null, 2));

  switch (cmd) {
    case "index": {
      const s = await ws.fullIndex();
      out({ ...s, graph: g.stats() });
      break;
    }
    case "trace": {
      const text = fs.readFileSync(0, "utf8");
      out(traceSuspects(g, root, text));
      break;
    }
    case "blast":
      out(blastRadius(g, root, rest.join(" ")) ?? { error: `No function or file matches ${rest.join(" ")}` });
      break;
    case "cycles":
      out(circularDependencies(g));
      break;
    case "recent":
      out(recentChanges(g, Number(rest[0] ?? 48)));
      break;
    case "cypher":
      out(g.readOnly(rest.join(" ")));
      break;
    default:
      console.error(`unknown command ${cmd}`);
      process.exit(1);
  }
  g.checkpoint();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
});
