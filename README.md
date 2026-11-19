# Blast Radius — Error Trace & Impact Graph for VS Code

**Click a stack trace → get the ranked list of functions that most likely caused it, including the ones that aren't on the stack.**
**Before a refactor → see every caller, importer and test that will feel it.**
**Your AI assistant gets the same graph over MCP, answering in milliseconds instead of reading 30 files.**

Built on [Relate by Neo4j](https://relatedb.ai), the embedded graph database. The whole graph lives in one file, `.vscode/codegraph.rl`, with no server and no Docker.

![Trace panel](media/screenshot-trace.png)

---

## The problem

A test fails. The stack trace points at `Cart.total`, which hasn't changed in three weeks. The real cause is `lookupCoupon`, a helper that `Cart.total` calls. Someone changed it three hours ago so it can return `undefined`. It **isn't in the stack trace at all**, because the function already returned before the crash.

Finding it means grepping, `git log -p`, and reading code. Blast Radius finds it straight from the trace:

| # | Suspect | Why |
|---|---|---|
| **1** | `lookupCoupon` · `src/coupons.ts:10` | Called by the crash site 1 hop down · **changed 3h ago** in f84b1d8 by Alex Rivera: "Support regional coupon pools" |
| 2 | `Cart.total` · `src/cart.ts:19` | Error thrown here · last changed 20d ago |
| 3 | `Cart.summary` | On the stack, frame #2 |

The uncommitted edit in `inventory.ts` is *more recent*, but it is **not ranked**: it isn't connected to the crash in the call graph. Recency alone is noise; recency × graph distance is signal.

## How it works

```
 on open / on save                         Relate (.vscode/codegraph.rl)
 ┌──────────────────────┐   UNWIND/MERGE   ┌───────────────────────────────────────────┐
 │ TS compiler API      │ ───────────────▶ │ (:File)-[:IMPORTS]->(:File)               │
 │ Python ast (stdlib)  │                  │ (:File)-[:DEFINES]->(:Function)           │
 │ git log -U0 -p       │                  │ (:Function)-[:CALLS]->(:Function)         │
 │ git diff HEAD -U0    │                  │ (:Commit)-[:MODIFIED]->(:File)            │
 └──────────────────────┘                  │ (:Commit)-[:TOUCHED]->(:Function) ◀ hunks │
                                           └───────────────────────────────────────────┘
        ▲                                        ▲                 ▲
 terminal shell-integration           Webview panel + CodeLens   MCP server (stdio)
 captures failing commands            (Cypher, in-process)       → localhost bridge → live graph
```

* **Function-level git history.** Every commit's diff hunks (`-U0`) are intersected with function line ranges. The result is a `TOUCHED` edge to the exact function, not just the file. Uncommitted edits (`git diff HEAD`) set `dirty = true`, the strongest signal.
* **Stable function ids** (`src/cart.ts#Cart.total`) survive edits that shift lines. On save, only that file and its importers are re-resolved (~300 ms). Incoming `CALLS` edges are preserved.
* **Suspect scoring is plain Cypher plus an explainable formula** (see `src/core/analysis.ts`):

  ```
  score = recency × proximity
  recency   = 1.0 uncommitted | 0.9·½^(age/72h) function changed | 0.35·½^(age/72h) only file changed | 0.02
  proximity = 1.0 crash site | 1/(1+0.5·i) i-th stack frame | 1/(1+hops) caller ≤5 hops up | 0.8/(1+hops) callee ≤2 hops down
  ```

  Every suspect ships with human-readable reasons, so the ranking is never a black box.

## Features

| | |
|---|---|
| **Auto-trace failed terminal commands** | With VS Code shell integration, when `npm test` / `pytest` / `node app.js` exits with a stack trace, a notification names the top suspect. One click opens the panel. |
| **Paste any trace** | `Blast Radius: Trace Error` (Ctrl/Cmd+Alt+T) uses the selection or clipboard. Parses Node/V8, Chrome/Firefox/Vite/webpack URLs, Python tracebacks, pytest, and `tsc` errors. Docker/CI paths are mapped by suffix. |
| **Blast radius** | CodeLens above every function: `3 callers · 12 transitive · changed 3h ago`. Click it (or Ctrl/Cmd+Alt+B) for transitive callers, importing files and **which test files to run**. |
| **MCP tools for agents** | `trace_error_suspects`, `get_blast_radius`, `find_recent_suspects`, `find_circular_dependencies`, and `query_codegraph` (read-only Cypher; writes are rejected and rolled back). |
| **Zero-config Copilot** | Registered through VS Code's MCP provider API, so Copilot agent mode sees the tools immediately. `Blast Radius: Register MCP Server` writes `.mcp.json` (Claude Code) and `.cursor/mcp.json`. |
| **"Ask AI to fix"** | Sends the ranked suspects plus reasons to your chat as a ready-made prompt. |

### Why the MCP server talks to the extension

Relate allows **one writer per `.rl` file**, and the extension holds it. The MCP server therefore forwards calls to a token-protected `127.0.0.1` endpoint inside the extension, so agents query the *live* graph, including a file saved a second ago. If VS Code isn't running, the MCP server opens (and if needed builds) the graph file itself, so it also works from a plain terminal with Claude Code.

## Quick start (development)

```bash
git clone https://github.com/YOUR_USER/blast-radius && cd blast-radius
npm install
npm run build
npm run demo            # creates ./demo-shop with a bug hidden in git history
code .                  # press F5 → "Extension Development Host", then File ▸ Open Folder ▸ demo-shop
```

In the dev host's terminal:

```bash
node --experimental-strip-types src/index.ts NOPE     # crashes → notification → "Show suspects"
```

CLI (same engine, no VS Code):

```bash
node dist/cli.js index  demo-shop
node dist/cli.js trace  demo-shop < trace.txt
node dist/cli.js blast  demo-shop applyDiscount
node dist/cli.js cycles demo-shop
node dist/cli.js cypher demo-shop "MATCH (c:Commit)-[:TOUCHED]->(f) RETURN c.author, collect(f.name)"
```

MCP for Claude Code from a terminal:

```bash
claude mcp add blast-radius -- node /abs/path/blast-radius/dist/mcp.js --root /abs/path/your-project
```

## Tests

```bash
npm run typecheck
node test/e2e.cjs demo-shop trace.txt   # real dist/extension.js against a mocked VS Code API:
                                        # activation, terminal auto-trace, panel, CodeLens, incremental
                                        # re-index, git-commit refresh, MCP through the live bridge
node test/mcp-e2e.mjs demo-shop trace.txt
```

Measured here: zod (525 files / 3,030 functions / 3,255 call edges) fully indexes in 2.9 s. psf/requests (37 files / 711 functions) in 0.5 s. Graph queries take 1–30 ms.

## Packaging

Relate ships its native engine per platform, so build one VSIX per target:

```bash
npm run package:all     # dist-vsix/blast-radius-{darwin-arm64,darwin-x64,linux-x64,linux-arm64,win32-x64}.vsix
code --install-extension dist-vsix/blast-radius-darwin-arm64.vsix
```

## Limits (v1, honest)

* Call resolution is syntactic (no type checker), for speed on every save. It resolves local functions, imports (named, default, namespace, CommonJS, re-exports, Python relative and absolute), `this.`/`self.` methods, and `new X()`. Unknown-receiver calls (`obj.method()`) link only when the method name is unique, and those edges carry `heuristic: true`.
* Line mapping for older commits drifts as later edits shift lines. Recency weighting keeps that harmless in practice.
* No source-map support yet: `dist/x.js` frames fall back to `src/x.ts` by name. ts-node, tsx, vitest, jest and Node type-stripping already print TS positions.
* Single-root workspaces (first folder).

## Roadmap

Go/Java via web-tree-sitter (WASM, no native builds) · source maps · test-result API integration · PR-diff blast radius in CI · vector search over function bodies in the same Relate graph.

---

Built for the **Relate by Neo4j Hackathon 2026** ("Context, Connected"). Apache-2.0.
