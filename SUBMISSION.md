# Devpost submission: draft and checklist

## Checklist (from the Official Rules)

- [ ] **Public GitHub repo** `IoakeimKyrgiafinis/RelateBugFinder`, with the Apache-2.0 license (included)
- [ ] **Topic `relate` on the repo (required)**, plus `relate-neo4j-hackathon` (recommended). It must stay public and tagged through judging and the winner announcement (Dec 17).
- [ ] **Setup instructions** a judge can follow: README → "Try it in 3 minutes". Test them on a clean machine, ideally on Windows too.
- [x] **5 `.vsix` files built** in `dist-vsix/` (`npm run package:all`); the release is created by `scripts\publish.ps1`
- [x] **Setup from a fresh clone tested** (Option B, CLI, demo, `npm test`) on Windows 11
- [ ] **Demo video ≤ 2 minutes**, recorded and edited by you, viewable without a login (YouTube unlisted works). Shot list: `demo/VIDEO_SCRIPT.md`. Use only music you have rights to. Run `npm run demo` again just before recording, so the "3h ago" is fresh.
- [ ] **Statement of Relate capabilities, third-party tools and AI tools**: README "Built with" section. **Check the AI paragraph so it's accurate.**
- [x] Repo URL filled in README.md and package.json (`IoakeimKyrgiafinis/RelateBugFinder`)
- [x] **Screenshots** for the Devpost gallery: `media/screenshot-trace.png`, `media/screenshot-deep.png`, `media/screenshot-blast.png` (the real panel HTML from the tests, rendered in headless Chrome with VS Code's Dark+ colours)
- [ ] Submit before **Fri Dec 11, 2026, 6:00 PM PST** (= Sat Dec 12, 04:00 Athens time)

One-time publish (GitHub CLI; the 5 VSIX files are already built in `dist-vsix/`):

```powershell
gh auth login
powershell -ExecutionPolicy Bypass -File scripts\publish.ps1
```

It creates the public repo `RelateBugFinder` with a description starting "Neo4j-Relate-Hackathon entry", adds the topics `relate` (required), `relate-neo4j-hackathon`, `neo4j`, `vscode-extension`, `mcp` and `debugging`, and publishes release v0.1.0 with the VSIX files and `scripts/release-notes.md`. If you change the code afterwards, run `npm run package:all` again first.

---

## Title

**Relate Bug Finder: from stack trace to root cause in one click, with a code graph your AI can query**

## Tagline (≤ 200 chars)

Click a stack trace in VS Code and get the functions that most likely caused it, even ones not on the stack. Before a refactor, see who breaks. The same graph powers your AI over MCP.

## What it does

Relate Bug Finder is a VS Code extension. It keeps a live graph of your codebase in an embedded Relate database: files, functions, imports, calls, and git history down to the individual function.

- **Error → root cause.** When a terminal command fails with a stack trace, Relate Bug Finder ranks the likely culprits by *recency of change × distance in the call graph*, and says why for each one. That catches bugs that aren't on the stack at all. In our demo, a crash in `Cart.total` is really caused by a helper it called, `lookupCoupon`, which a teammate changed 3 hours ago. That helper already returned, so it isn't on the stack. Relate Bug Finder reads the crash line (`coupon.pct`), traces `coupon` back to `const coupon = lookupCoupon(couponCode)`, ranks `lookupCoupon` #1 and says why. The same value tracing works for Python's `'NoneType' object has no attribute …`.
- **Deep trace (opt-in).** One click re-runs the failing command with a recorder attached, after showing the exact command. Python uses a small stdlib-only hook (`sys.monitoring` on 3.12+, `sys.setprofile`/`settrace` before), limited to project code; Node uses its built-in V8 coverage. Nothing to install. It records what ran, how often, how close to the crash, which lines ran and what each function returned, and stores it in the graph as a `(:Run)`. Functions that ran just before the crash rank higher. When the error names a value (`-10.0 != 90`, `negative total: -10.0`, `None`), the function that returned it first moves up: the producer of the bad value, even though it is long off the stack. In the demo's Python scene, the changed helper `bulk_discount` goes from #3 to #1 this way. Each suspect lists the lines that ran, and the editor highlights them. It re-runs the way your terminal did, in the same shell and with your project's Python environment, and it can be cancelled.
- **Compare with passing tests (Python).** The call graph picks related tests, which run the same way. Functions that also run in passing tests rank lower (spectrum-based fault localization, computed in Cypher), and each suspect shows the lines that ran only in the failing test.
- **Before a refactor → blast radius.** CodeLens above every function shows its callers and recent changes. One click shows transitive callers, importing files, and the exact test files to run.
- **For AI assistants → MCP tools.** Copilot (auto-registered), Claude Code and Cursor get `trace_error_suspects`, `get_blast_radius`, `find_recent_suspects`, `find_circular_dependencies` and read-only `query_codegraph`. They answer in milliseconds, so the agent doesn't burn tokens reading whole directories. "Ask AI to fix" hands the chat the suspects, reasons, returned values, highlighted lines and code.

## Why it's useful

Every developer hits this several times a day: something broke, and the stack trace points at code nobody touched. The answer is usually "what changed recently that's connected to this?" and "which function produced the bad value?". Those are questions about relationships between code, history and what actually ran, which is exactly what a graph answers.

## How we built it (connected context)

- **Graph model:** `(:File)-[:IMPORTS]->(:File)`, `(:File)-[:DEFINES]->(:Function)`, `(:Function)-[:CALLS]->(:Function)`, `(:Commit)-[:MODIFIED]->(:File)`, `(:Commit)-[:TOUCHED]->(:Function)`, `(:Function)-[:READS|WRITES]->(:Field)` and `(:Run)-[:EXECUTED {count, since, lines, rets}]->(:Function)`. Static structure, history and recorded executions live in one graph, so "which method sets the field this crash read?" and "which functions ran in the failing test but not in the passing ones?" are each a single Cypher query. The `TOUCHED` edges come from intersecting `git log -U0` diff hunks with function line ranges. Uncommitted edits are flagged from `git diff HEAD`.
- **Engine:** Relate runs embedded in the extension host and stores everything in one `.vscode/codegraph.rl` file. Suspect ranking, blast radius, related-test selection, spectrum scores and cycle detection are Cypher (variable-length traversals and aggregations).
- **Incremental updates:** on save, only that file and its importers are re-resolved (~300 ms). Stable function ids keep incoming edges intact.
- **Relate's single-writer lock, turned into a feature.** The MCP server forwards to a token-protected localhost bridge inside the extension, so agents always query the *live* graph, including recorded runs. When VS Code is closed, it builds an in-memory Relate graph instead, so it never blocks the extension.
- **Safe agent Cypher:** every agent query runs in a transaction that is always rolled back, and write statements are rejected.

## Challenges

- **Relate's single-writer lock:** a second process can't open the graph file, even read-only, while the extension holds it. That forced the bridge design above, which turned out better.
- **A lock that never lets go:** Relate releases a file's writer lock only when the process exits. Our first standalone MCP server opened the graph file, so a long agent session silently stopped VS Code's extension from starting. It now indexes into an in-memory graph, and a test checks the file stays openable while the server runs.
- **TypeScript 7:** npm's latest TypeScript is the Go-native compiler and no longer exposes the JS compiler API, so we pinned 5.9.
- **A git flag that silently drops history:** `git log --since` stops walking at the first commit older than the cutoff, so one out-of-order date (a rebase, cherry-pick or backdated commit) hid all recent changes. The benchmark caught it: 143 of 144 bugs saw zero commits. We now use `--since-as-filter`.
- **Recording without getting in the way:** the first recorder slowed some test files 11× (100× on Python 3.14) and was switched off by `pytest --cov`. It now reports each line once and then disables that location, uses `sys.monitoring` as its own tool on 3.12+, and keeps calls and return values when a coverage tool takes over line tracing on older Pythons. Median cost for a failing test: 1.6×.
- **Textbook fault localization didn't transfer.** Plain Ochiai made the ranking worse on our benchmark. With a single failing test, the buggy function usually also runs in the passing tests. We kept only what helped on the dev half: passing tests only, no penalty for stack frames, and a softened score. We report the small held-out gain as it is.
- **Lost line numbers:** git hunks use each commit's own line numbering, which drifts. We map older commits approximately and let recency weighting absorb the error.

## Accomplishments

- **Measured on real bugs.** BugsInPy: 114 reproduced bugs from 12 Python projects. Weights were tuned on one half; these numbers are the other half (n = 59), never used for tuning:

  | Method | Right function #1 | In top 3 | MRR |
  |---|---|---|---|
  | Reading the stack top-down | 20% | 27% | 0.23 |
  | Sentry-style (stack frames, newest change first) | 22% | 27% | 0.24 |
  | **Relate Bug Finder, instant (trace only)** | **31%** | **39%** | **0.35** |
  | **+ Deep trace** (one recorded re-run) | **44%** | **54%** | **0.53** |
  | **+ related passing tests** | **46%** | **56%** | **0.54** |

- **Where it matters most** (all 114 bugs). On failing assertions (n = 70), where the stack ends in the test, reading the stack gets the right function first in 6% of bugs; Relate Bug Finder with Deep trace gets 46%, and 47% after comparing with passing tests. On crashes fixed somewhere off the stack (n = 18), every baseline gets 0; with Deep trace and passing tests, Relate Bug Finder gets 4 at #1 and 5 in the top 3.
- **Lines, honestly.** The lines the panel highlights (about 9 of a function's 29) include a line the real fix changed in 94% of bugs. It narrows the reading; it doesn't pinpoint.
- **Cheap enough to click.** Recording costs a median 1.6× the test's normal run time (`bench/OVERHEAD.md`).
- **It works on real code:** zod (525 files, 3,030 functions, 3,255 call edges) fully indexes in 2.9 s. Graph queries take 1–30 ms.
- **Tested end to end:** `npm test` runs 10 suites, including the real built extension against a mocked VS Code API (terminal auto-trace, panel, CodeLens, incremental re-indexing, MCP through the live bridge), the judges' Python scene clicked through the panel's real HTML, real re-runs in a project `.venv` with PowerShell/bash syntax, Cancel and a coverage tool active, and every MCP tool with VS Code closed.
- **An honest benchmark:** 74 failures where the test broke before reaching the bug (import errors, Windows-only asyncio gaps) are set aside by explicit rules applied to every method alike. Ideas that didn't help on the dev half (plain Ochiai, a "newest change wins" bonus) are documented and not shipped.
- **Honest about prior art:** Sentry's Suspect Commits and several code-graph MCP servers cover parts of this. Ours is the combination that ranks suspects that aren't on the stack (see the README's comparison table).

## What's next

Return values and call order for Node's Deep trace, Go and Java via web-tree-sitter (WASM), source maps, test-explorer integration, PR blast-radius comments in CI, and vector search over function bodies in the same Relate graph.

## Built with

relate · neo4j · cypher · typescript · python · vscode · mcp · git · esbuild

## Statement of tools (required)

Copy the README's "Built with: Relate capabilities, third-party tools and AI use" section here, **after checking the AI paragraph matches what you actually did**.
