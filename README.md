# Blast Radius — Error Trace & Impact Graph for VS Code

**Click a stack trace → get the ranked list of functions that most likely caused it, including the ones that aren't on the stack.**
**Before a refactor → see every caller, importer and test that will feel it.**
**Your AI assistant gets the same graph over MCP, answering in milliseconds instead of reading 30 files.**

Built on [Relate by Neo4j](https://relatedb.ai), the embedded graph database. The whole graph lives in one file, `.vscode/codegraph.rl`, with no server and no Docker.

![Trace panel](media/screenshot-trace.png)

---

## The problem

A test fails. The stack trace points at `Cart.total`, which hasn't changed in three weeks. The real cause is `lookupCoupon`, a helper that `Cart.total` calls. Someone changed it three hours ago so it can return `undefined`. It **isn't in the stack trace at all**, because the function already returned before the crash.

Finding it means grepping, `git log -p`, and reading code. Blast Radius finds it straight from the trace. First it reads the crash line and says where the bad value came from:

> **Where the undefined came from:** `coupon` was undefined when reading .pct. It came from lookupCoupon(), at src/cart.ts:22: const coupon = lookupCoupon(couponCode)

Then it ranks the suspects:

| # | Suspect | Score | Why |
|---|---|---|---|
| **1** | `lookupCoupon` · `src/coupons.ts:10` | 91.9 | **Produced the undefined `coupon`** · called by the crash site · **changed 3h ago** by Alex Rivera: "Support regional coupon pools" |
| 2 | `Cart.total` · `src/cart.ts:19` | 48.8 | Error thrown here · last changed 20d ago |
| 3 | `Cart.summary` | 32.5 | On the stack, frame #2 |

The uncommitted edit in `inventory.ts` is *more recent*, but it is **not ranked**: it isn't connected to the crash in the call graph. Recency alone is noise; recency × graph distance is signal.

## How it differs from existing tools

Parts of this exist already, and it's worth being precise about which part is new.

| Tool | What it answers | Why it misses `lookupCoupon` |
|---|---|---|
| **Sentry Suspect Commits** | "Who last changed the code *in the stack trace*?" | It only looks at stack frames, so it blames the 3-week-old commit that wrote `Cart.total`. It also works on production errors in a hosted service, after the code has shipped. |
| **Code-graph MCP servers** (codegraph, code-graph-mcp, Arbor, …) | "What is connected to this function?" (call graphs, impact analysis for agents) | They have the call graph but don't read stack traces or rank by change history. You'd have to ask "what does `Cart.total` call?" and then run `git log` on each result yourself. |
| **Blast Radius** | "Where did the bad value come from, and what changed recently *in the code connected to this error*?" | Reads the crash line to trace the undefined value to the call that produced it, then combines stack frames + call-graph neighbours, weighted by function-level git history. Runs locally, in your editor, while you develop. |

Blast radius ("what breaks if I change this?") and MCP tools for agents are useful supporting features, but they are not new on their own. The new part is ranking suspects **off the stack** from a trace.

## How it works

```
 on open / on save                         Relate (.vscode/codegraph.rl)
 ┌──────────────────────┐   UNWIND/MERGE   ┌───────────────────────────────────────────┐
 │ TS compiler API      │ ───────────────▶ │ (:File)-[:IMPORTS]->(:File)               │
 │ Python ast (stdlib)  │                  │ (:File)-[:DEFINES]->(:Function)           │
 │ git log -U0 -p       │                  │ (:Function)-[:CALLS]->(:Function)         │
 │ git diff HEAD -U0    │                  │ (:Commit)-[:MODIFIED]->(:File)            │
 │ field reads/writes   │                  │ (:Commit)-[:TOUCHED]->(:Function) ◀ hunks │
 │ Deep trace recorder  │                  │ (:Function)-[:READS|WRITES]->(:Field)     │
 └──────────────────────┘                  │ (:Run)-[:EXECUTED]->(:Function)           │
                                           └───────────────────────────────────────────┘
        ▲                                        ▲                 ▲
 terminal shell-integration           Webview panel + CodeLens   MCP server (stdio)
 captures failing commands            (Cypher, in-process)       → localhost bridge → live graph
```

* **Function-level git history.** Every commit's diff hunks (`-U0`) are intersected with function line ranges. The result is a `TOUCHED` edge to the exact function, not just the file. Uncommitted edits (`git diff HEAD`) set `dirty = true`, the strongest signal.
* **Stable function ids** (`src/cart.ts#Cart.total`) survive edits that shift lines. On save, only that file and its importers are re-resolved (~300 ms). Incoming `CALLS` edges are preserved.
* **Suspect scoring is plain Cypher plus an explainable formula** (see `src/core/analysis.ts`):

  ```
  score = proximity × (0.3 + recency) / 1.3, × 0.2 if the function is test code
  recency   = 1.0 uncommitted | 0.9·½^(age/14d) function changed | 0.15·½^(age/14d) only file changed | 0.02
  proximity = 1.0 crash site | 1/(1+0.5·i) i-th stack frame | 1/(1+hops) caller ≤5 hops up
            | 0.8/(1+hops) callee of the crash site ≤2 hops down | 0.4 × frame proximity for a direct callee of another frame
            | 1.0 the call that produced the undefined/null value | 0.9 the caller that passed it as an argument
            | 0.6 a method that sets the missing or empty field | 0.5 the constructor, if no method sets it
            | 0.4 a method of the crash's class that changes a field the crash line reads | 0.3 another method of the class, or function of the module, that lacked an attribute
  ```

  Every suspect ships with human-readable reasons, so the ranking is never a black box. The weights were tuned on half of a real-bug benchmark and checked on the other half (below).

## Features

| | |
|---|---|
| **Auto-trace failed terminal commands** | With VS Code shell integration, when `npm test` / `pytest` / `node app.js` exits with a stack trace, a notification names the top suspect. One click opens the panel. |
| **Where the undefined came from** | For `Cannot read properties of undefined/null`, Firefox/Safari equivalents and Python `'NoneType' object has no attribute …`, it reads the crash line, finds the expression that was empty (`coupon` in `coupon.pct`) and walks back to what produced it: a call (`const coupon = lookupCoupon(code)`, including destructuring and reassignment), a parameter the caller passed, a field, or an index lookup. The producing function becomes the top-weighted suspect. When a field was missing or empty (`'X' object has no attribute 'y'`, or the value came from `self.y` / `this.y`), the methods of that class that set `y` become suspects too. If no method sets it, the constructor does. That code already returned, so it is never on the stack. |
| **Deep trace** (opt-in) | When the crash came from a terminal command, the panel offers to re-run it with a recorder attached (Python: `sys.setprofile` via `PYTHONPATH`, no install; Node: built-in `NODE_V8_COVERAGE`). Which of your functions ran, how often, and how close to the crash is stored as a `(:Run)` in Relate. Functions that ran just before the crash rank higher, and helpers that already returned (never on the stack) can join the suspects. It always asks first, showing the exact command. |
| **Compare with related passing tests** (opt-in, Python) | After a deep trace, Cypher picks the test functions that call the code that ran just before the crash, runs them the same way (pytest or unittest) with the recorder, and stores them in the same session. Ochiai's spectrum score, computed in Cypher, then lowers functions that also run in passing tests. |
| **Paste any trace** | `Blast Radius: Trace Error` (Ctrl/Cmd+Alt+T) uses the selection or clipboard. Parses Node/V8, Chrome/Firefox/Vite/webpack URLs, Python tracebacks, pytest, and `tsc` errors. Docker/CI paths are mapped by suffix. |
| **Blast radius** | CodeLens above every function: `3 callers · 12 transitive · changed 3h ago`. Click it (or Ctrl/Cmd+Alt+B) for transitive callers, importing files and **which test files to run**. |
| **MCP tools for agents** | `trace_error_suspects`, `get_blast_radius`, `find_recent_suspects`, `find_circular_dependencies`, and `query_codegraph` (read-only Cypher; writes are rejected and rolled back). |
| **Zero-config Copilot** | Registered through VS Code's MCP provider API, so Copilot agent mode sees the tools immediately. `Blast Radius: Register MCP Server` writes `.mcp.json` (Claude Code) and `.cursor/mcp.json`. |
| **"Ask AI to fix"** | Sends the ranked suspects plus reasons to your chat as a ready-made prompt. |

### Why the MCP server talks to the extension

Relate allows **one writer per `.rl` file**, and the extension holds it. The MCP server therefore forwards calls to a token-protected `127.0.0.1` endpoint inside the extension, so agents query the *live* graph, including a file saved a second ago. If VS Code isn't running, the MCP server indexes the workspace into an **in-memory** Relate graph (about 1–3 s, refreshed when older than 15 s), so it also works from a plain terminal with Claude Code. It deliberately never opens the `.rl` file: Relate releases a writer lock only when the process exits, and an agent session can run for hours, so holding the file would stop the extension from starting.

## Try it in 3 minutes (judges start here)

**Needs:** VS Code ≥ 1.101, Node.js ≥ 22.6 (to run the TypeScript demo directly), git. Python 3 is optional (for indexing `.py` files). Works on macOS, Windows and Linux.

**Option A: install the prebuilt extension (no build step)**

1. Download the `.vsix` for your platform from [Releases](https://github.com/YOUR_USER/blast-radius/releases) (`darwin-arm64` = Apple Silicon, `darwin-x64`, `win32-x64`, `linux-x64`, `linux-arm64`).
2. `code --install-extension blast-radius-<platform>.vsix`
3. Create the demo project and open it:
   ```bash
   git clone https://github.com/YOUR_USER/blast-radius && cd blast-radius
   node demo/setup-demo.mjs demo-shop
   code demo-shop
   ```

**Option B: run from source**

```bash
git clone https://github.com/YOUR_USER/blast-radius && cd blast-radius
npm install && npm run build
npm run demo            # creates ./demo-shop with a bug hidden in git history
code .                  # press F5: a new VS Code window opens on demo-shop with the extension loaded
```

**Then, in demo-shop:**

1. The status bar (bottom left) shows `20 fns · 20 calls` once indexing finishes (under a second).
2. In the integrated terminal, run `npm start -- NOPE`. It crashes with `TypeError … reading 'pct'`. A notification says `"coupon" was undefined: it came from lookupCoupon()` and names it as the top suspect. Click **Show suspects**.
3. Open `src/money.ts`. Click the CodeLens above `applyDiscount` to see its blast radius and the tests to run.
4. Copilot agent mode lists the *Blast Radius* MCP tools automatically. For Claude Code or Cursor, run **Blast Radius: Register MCP Server**.

No shell integration in your terminal? Copy the error output and run **Blast Radius: Trace Error** (Ctrl/Cmd+Alt+T), which reads the clipboard.

CLI (same engine, no VS Code):

```bash
node dist/cli.js index  demo-shop
node dist/cli.js trace  demo-shop < demo-shop/trace.txt
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
npm test     # builds throwaway demos in your temp folder (never touches ./demo-shop) and runs:
             #  · the real dist/extension.js against a mocked VS Code API: activation, terminal auto-trace,
             #    panel, CodeLens, incremental re-index, git-commit refresh, MCP through the live bridge
             #  · every MCP tool with VS Code closed, with assertions on the ranking and git history
             #  · that the standalone MCP server never locks the graph file
             #  · 19 "where did the undefined come from?" cases (TS/JS/Python, V8/Firefox/Safari wording)
             #  · 15 "which field was missing?" cases (AttributeError wordings incl. mock.patch, self. / this. fields read on a line, field reads/writes)
             #  · Deep trace end to end (Node V8 coverage, Python recorder) and spectrum ranking against a related passing test
```

Also verified by hand in real VS Code on Windows 11 (F5 → demo-shop → crash in the terminal → notification → panel).

Measured here: zod (525 files / 3,030 functions / 3,255 call edges) fully indexes in 2.9 s. psf/requests (37 files / 711 functions) in 0.5 s. Graph queries take 1–30 ms.

## Benchmark on real bugs

[BugsInPy](https://github.com/soarsmu/BugsInPy) is a published set of real bugs from real Python projects. `bench/bugsinpy.mjs` checks out each buggy commit with its real git history, runs the test that exposes the bug, and asks each method where the fix belongs, with the clock pinned to when the bug was hit. 229 bugs from 12 projects were attempted. 114 reproduced on Windows 11 / Python 3.8 and have a function to point at. Ground truth is the function(s) the real fix changed.

A failing test only counts if it actually ran into the bug. 74 bugs were set aside because the test broke first, with the same rules for every method ([bench/classify.mjs](bench/classify.mjs)):
* 48: no frame in the project's own code,
* 22: an import failed while loading the test or a module (for example, Scrapy's pinned OpenSSL lacks `TLS_METHOD`),
* 4: Windows' asyncio has no `add_reader`.

Weights were chosen on a fixed half of the bugs (`bench/tune.mjs`). On the **other half**, never used for tuning (n = 59):

| Method | Top 1 | Top 3 | MRR |
|---|---|---|---|
| **Blast Radius** (trace only, instant) | **31%** | **39%** | **0.35** |
| **+ Deep trace** (one recorded re-run of the failing test) | **42%** | **56%** | **0.51** |
| **+ related passing tests** (spectrum, after a deep trace) | **46%** | **56%** | **0.53** |
| Read the stack top-down | 20% | 27% | 0.23 |
| Stack frames, most recently changed first (Sentry-style) | 22% | 27% | 0.24 |
| Most recently changed functions (ignores the trace) | 12% | 17% | 0.16 |

Where the gain comes from (all 114 bugs, full tables in [bench/RESULTS.md](bench/RESULTS.md)):

* **Failing assertions** (a test's `assert` fails, n = 70): the right function is #1 in 24% of bugs, vs 6% for reading the stack. The stack ends in the test, so the useful suspects are the code the test called that changed recently.
* **Crashes** (n = 44): a little better than reading the stack (top 1: 48% vs 43%, top 3: 61% vs 57%). The stack is already a strong signal here.
* **Crashes fixed somewhere off the stack** (n = 18): Blast Radius gets 3 into the top 3, and no baseline gets any. Each comes from a link read from the error itself:
  * thefuck:12, `module … does not have the attribute 'which'` → the module's functions → `match` is #1.
  * scrapy:19, `'WrappedRequest' object has no attribute 'full_url'` → the class's other methods → #2.
  * tqdm:5, `'tqdm' object has no attribute 'total'` → the method that sets `self.total` → `__init__` is #2.

  The same rule cost one place in tqdm:6. It has the same error, but there the fix was in the crash site itself (#1 → #2). The other 15 involve dict keys, async futures and APIs the fix had yet to add, which need real data-flow analysis.

  These three rules were designed after looking at the off-stack failures in *both* halves of the benchmark. Their weights are fixed by principle (below the crash site), not tuned, but for these signals the held-out number is not fully blind.

**Deep trace** (`bench/deeptrace.mjs` re-runs each failing test with the same recorder the extension uses):
* **Failing assertions:** #1 rises from 24% to 41% of bugs, top 3 from 27% to 53%. The stack stops in the test, but the recording shows which project functions the test actually exercised, and which ran last.
* **Off-stack crashes:** 5 of 18 in the top 3, up from 3. These are functions that had already returned before the crash, so no stack-based method can see them.
* **The cost:** the test runs once more (seconds for a single test). It is opt-in and always asks first.

**Related passing tests** (spectrum-based fault localization):
* Plain Ochiai made the ranking *worse* (held-out MRR 0.48 vs 0.51). With one failing test, the faulty function usually also runs in the passing tests; the bug needs a specific input.
* What ships is the version chosen on the dev half: only tests that passed count, stack frames are not penalised, and the Ochiai score is softened (exponent 0.25).
* On the held-out half that adds 2 more bugs at #1 (42% → 46%) and leaves the top 3 unchanged. It is a tie-breaker, not a big signal.

Reproduce: `node bench/bugsinpy.mjs --jobs 4` (needs `uv`; downloads the projects into `../bench-cache`; a few hours), then `node bench/deeptrace.mjs` and `node bench/deeptrace.mjs --passing` (recordings), `node bench/rescore.mjs`, `node bench/tune.mjs` and `node bench/report.mjs`. After changing the ranking, `node bench/rescore.mjs` re-scores in minutes without re-running any tests.

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
* Value tracing is syntactic and stays inside the crashing function: it follows declarations, reassignments, destructuring and parameters, but not values that pass through other variables, closures or object fields set at runtime (a missing `self.x` / `this.x` field is resolved to the methods that set it; fields of other objects are only explained). It runs only for undefined/null/None errors. Other off-stack suspects come from call structure plus history, so a changed helper that's connected but innocent can still rank high; its reasons say why it was picked.
* Single-root workspaces (first folder), and one VS Code window per folder (Relate allows one writer per graph file).

## Built with: Relate capabilities, third-party tools and AI use

**Relate capabilities used**
- **Embedded Node.js engine** (`@relate/relate`): runs in the VS Code extension host, with no server.
- **Single-file persistence** (`.vscode/codegraph.rl`) and `checkpoint()` after every update.
- **Cypher:** `UNWIND`/`MERGE` batch upserts, variable-length paths (`[:CALLS*1..5]`, `[:IMPORTS*2..6]` for cycles), aggregation, list comprehensions, `CALL {}` subqueries, and indexes. Field data flow is a graph query (`(:Function)-[:WRITES]->(:Field)`), and spectrum-based fault localization (Ochiai over `(:Run)-[:EXECUTED]->(:Function)`) is a single aggregation query.
- **Runs as data:** each deep trace and related test run is a `(:Run)` node linked to the functions that executed, so recorded executions and static structure are queried together.
- **Transactions:** `begin`/`commit` for atomic re-indexing. `begin`/`rollback` plus statement-type checks make the agent's Cypher tool provably read-only.
- **Agent access over MCP:** our own MCP server exposes graph-backed tools and raw read-only Cypher to Copilot, Claude Code and Cursor.

**Third-party libraries:**
- TypeScript compiler API 5.9 (parsing)
- Python `ast` (stdlib)
- `@modelcontextprotocol/sdk`
- `zod`
- `esbuild`
- `@vscode/vsce`
- `jsdom` (dev only)
- git CLI

All are open-source, used under their licenses. No pre-existing code of mine was reused. The project was started during the contest period (November 2026).

**AI tools:** <!-- CHECK THIS before submitting: add what you did yourself, remove anything that isn't true -->
This project was built with heavy use of Claude (Anthropic). Claude wrote nearly all of the code, tests and documentation: first in a claude.ai conversation (the initial implementation, tested in a cloud sandbox), then in Claude Code on my own machine (running the extension in real VS Code on Windows, a code review, and fixes such as the MCP fallback that wiped git history and held the graph's file lock). I chose the idea and the hackathon, set the scope and priorities, decided which findings to act on, and tested the extension in VS Code myself. The demo video is my own recording.

## Roadmap

Go/Java via web-tree-sitter (WASM, no native builds) · source maps · test-result API integration · PR-diff blast radius in CI · vector search over function bodies in the same Relate graph.

---

Built for the **Relate by Neo4j Hackathon 2026** ("Context, Connected"). Apache-2.0.
