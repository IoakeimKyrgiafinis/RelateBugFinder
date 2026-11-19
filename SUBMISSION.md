# Devpost submission: draft and checklist

## Checklist (from the Official Rules)

- [ ] **Public GitHub repo** with an open-source license (Apache-2.0 included)
- [ ] **Topic `relate` on the repo (required)**, plus `relate-neo4j-hackathon` (recommended)
- [ ] **Setup instructions** a judge can follow: README → "Try it in 3 minutes". Test them on a clean machine, ideally on Windows too.
- [ ] **Release with the 5 `.vsix` files** so judges can skip the build
- [ ] **Demo video ≤ 2 minutes**, recorded and edited by you, viewable without a login (YouTube unlisted works). Shot list: `demo/VIDEO_SCRIPT.md`. Use only music you have rights to.
- [ ] **Statement of Relate capabilities, third-party tools and AI tools**: README "Built with" section. **Edit the AI paragraph so it's accurate.**
- [ ] Replace every `YOUR_USER` in README.md and package.json
- [ ] Submit before **Fri Dec 11, 2026, 6:00 PM PST** (= Sat Dec 12, 04:00 Athens time)

```bash
# one-time publish (GitHub CLI)
gh repo create blast-radius --public --source . --push
gh repo edit --add-topic relate --add-topic relate-neo4j-hackathon --add-topic vscode-extension --add-topic mcp
gh release create v0.1.0 dist-vsix/*.vsix --title "Blast Radius v0.1.0" --notes "Install: code --install-extension blast-radius-<platform>.vsix"
```

---

## Title

**Blast Radius: from stack trace to root cause in one click, with a code graph your AI can query**

## Tagline (≤ 200 chars)

Click a stack trace in VS Code and get the functions that most likely caused it, even ones not on the stack. Before a refactor, see who breaks. The same graph powers your AI over MCP.

## What it does

Blast Radius is a VS Code extension. It keeps a live graph of your codebase in an embedded Relate database: files, functions, imports, calls, and git history down to the individual function.

- **Error → root cause.** When a terminal command fails with a stack trace, Blast Radius ranks the likely culprits by *recency of change × distance in the call graph*. That catches bugs that aren't on the stack at all. In our demo, a crash in `Cart.total` is really caused by a helper it called, `lookupCoupon`, which a teammate changed 3 hours ago. That helper already returned, so it isn't on the stack. Blast Radius reads the crash line (`coupon.pct`), traces `coupon` back to `const coupon = lookupCoupon(couponCode)`, ranks `lookupCoupon` #1 and says why. The same value tracing works for Python's `'NoneType' object has no attribute …`.
- **Deep trace (opt-in).** One click re-runs the failing command with a recorder attached (Python `sys.setprofile`, Node's built-in V8 coverage; nothing to install). What ran, how often and how close to the crash is stored in the graph as a `(:Run)`. Functions that ran just before the crash rank higher, and helpers that already returned join the suspects. For Python tests it can then pick related passing tests from the call graph, run them the same way, and compare them with the failure (spectrum-based fault localization, computed in Cypher).
- **Before a refactor → blast radius.** CodeLens above every function shows its callers and recent changes. One click shows transitive callers, importing files, and the exact test files to run.
- **For AI assistants → MCP tools.** Copilot (auto-registered), Claude Code and Cursor get `trace_error_suspects`, `get_blast_radius`, `find_recent_suspects`, `find_circular_dependencies` and read-only `query_codegraph`. They answer in milliseconds, so the agent doesn't burn tokens reading whole directories.

## Why it's useful

Every developer hits this several times a day: something broke, and the stack trace points at code nobody touched. The answer is usually "what changed recently that's connected to this?". That question is about relationships between code and history, which is exactly what a graph answers.

## How we built it (connected context)

- **Graph model:** `(:File)-[:IMPORTS]->(:File)`, `(:File)-[:DEFINES]->(:Function)`, `(:Function)-[:CALLS]->(:Function)`, `(:Commit)-[:MODIFIED]->(:File)`, `(:Commit)-[:TOUCHED]->(:Function)`, `(:Function)-[:READS|WRITES]->(:Field)` and `(:Run)-[:EXECUTED {count, since}]->(:Function)`. Static structure, history and recorded executions live in one graph, so "which method sets the field this crash read?" and "which functions ran in the failing test but not in the passing ones?" are each a single Cypher query. The `TOUCHED` edges come from intersecting `git log -U0` diff hunks with function line ranges. Uncommitted edits are flagged from `git diff HEAD`.
- **Engine:** Relate runs embedded in the extension host and stores everything in one `.vscode/codegraph.rl` file. Suspect ranking, blast radius and cycle detection are Cypher variable-length traversals.
- **Incremental updates:** on save, only that file and its importers are re-resolved (~300 ms). Stable function ids keep incoming edges intact.
- **Relate's single-writer lock, turned into a feature.** The MCP server forwards to a token-protected localhost bridge inside the extension, so agents always query the *live* graph. When VS Code is closed, it builds an in-memory Relate graph instead, so it never blocks the extension.
- **Safe agent Cypher:** every agent query runs in a transaction that is always rolled back, and write statements are rejected.

## Challenges

- **Relate's single-writer lock:** a second process can't open the graph file, even read-only, while the extension holds it. That forced the bridge design above, which turned out better.
- **A lock that never lets go:** Relate releases a file's writer lock only when the process exits. Our first standalone MCP server opened the graph file, so a long agent session silently stopped VS Code's extension from starting. It now indexes into an in-memory graph, and a test checks the file stays openable while the server runs.
- **TypeScript 7:** npm's latest TypeScript is the Go-native compiler and no longer exposes the JS compiler API, so we pinned 5.9.
- **A git flag that silently drops history:** `git log --since` stops walking at the first commit older than the cutoff, so one out-of-order date (a rebase, cherry-pick or backdated commit) hid all recent changes. The benchmark caught it: 143 of 144 bugs saw zero commits. We now use `--since-as-filter`.
- **Textbook fault localization didn't transfer.** Plain Ochiai (spectrum-based localization) made the ranking worse on our benchmark. With a single failing test, the buggy function usually also runs in the passing tests. We kept only what helped on the dev half: passing tests only, no penalty for stack frames, and a softened score. We report the small held-out gain as it is.
- **Lost line numbers:** git hunks use each commit's own line numbering, which drifts. We map older commits approximately and let recency weighting absorb the error.

## Accomplishments

- **It works on real code:** zod (525 files, 3,030 functions, 3,255 call edges) fully indexes in 2.9 s. Graph queries take 1–30 ms.
- **Tested end to end:** `npm test` runs the real built extension against a mocked VS Code API (terminal auto-trace, panel, CodeLens, incremental re-indexing, git-commit refresh, MCP through the live bridge), plus every MCP tool with VS Code closed. It's also been run by hand in real VS Code on Windows 11.
- **Measured on real bugs:** on BugsInPy (114 reproduced bugs from 12 Python projects), with weights tuned on one half and tested on the other, Blast Radius puts the truly fixed function first in 31% of held-out bugs. Reading the stack or Sentry-style ordering manages 20–22% (MRR 0.35 vs 0.23–0.24). The biggest gain is on failing assertions: 24% vs 6%. On crashes fixed off the stack, it gets 3 of 18 into the top 3 and the baselines get none. Each of those comes from a link read from the error text, e.g. "this class had no attribute `y`" → the methods that should have set it. The other 15 need real data-flow analysis, and we say so. With one Deep trace (re-running the failing test with the recorder), the held-out numbers rise to 42% #1 and 56% top 3 (MRR 0.51). Comparing with related passing tests adds a little more: 46% #1, top 3 unchanged, MRR 0.53.
- **An honest benchmark:** 74 failures where the test broke before reaching the bug (import errors, Windows-only asyncio gaps) are set aside by explicit rules applied to every method alike. Counting them would have made every method look worse, without saying anything about root-cause ranking.
- **Honest about prior art:** Sentry's Suspect Commits and several code-graph MCP servers cover parts of this. Ours is the combination that ranks suspects that aren't on the stack (see the README's comparison table).

## What's next

Go and Java via web-tree-sitter (WASM), source maps, test-explorer integration, PR blast-radius comments in CI, and vector search over function bodies in the same Relate graph.

## Built with

relate · neo4j · cypher · typescript · python · vscode · mcp · git · esbuild

## Statement of tools (required)

Copy the README's "Built with: Relate capabilities, third-party tools and AI use" section here, **after editing the AI paragraph to match what you actually did**.
