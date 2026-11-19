# 2-minute demo video: shot list

**0:00–0:15 · The pain.** Terminal in VS Code (demo-shop open). Run `npm start -- NOPE`.
`TypeError: Cannot read properties of undefined (reading 'pct')` at `Cart.total`. Say: "The stack says Cart.total. Cart.total hasn't changed in 3 weeks."

**0:15–0:40 · One click.** The notification appears: *top suspect: lookupCoupon … changed 3h ago by Alex Rivera*. Click **Show suspects**.
Point at #1: **not on the stack**. It's a callee of the crash site that changed 3 hours ago. Point at the uncommitted `inventory.ts` edit: more recent, but *not* ranked, because it isn't connected. "Recency × graph distance."

**0:40–1:00 · Fix with context.** Click **Open** → `coupons.ts` (the `!` non-null assertion). Click **Ask AI to fix with this context**; the chat gets the ranked suspects plus reasons.

**1:00–1:25 · Before you refactor.** In `money.ts`, the CodeLens above `applyDiscount` reads `1 caller · 5 transitive`. Click it → blast-radius graph + "Tests to run: tests/cart.test.ts".
Save an edit in a new file that calls `lookupCoupon` → the CodeLens updates to `2 callers` in ~300 ms.

**1:25–1:50 · Agents get the graph.** Copilot agent mode (or Claude Code): *"What breaks if I change lookupCoupon's return type?"* → it calls `get_blast_radius` instantly. Then *"Which functions did Alex change this week?"* → `query_codegraph` writes Cypher over `(:Commit)-[:TOUCHED]->(:Function)`.

**1:50–2:00 · Close.** "One `.rl` file. Relate embedded in the editor. No server." Show `.vscode/codegraph.rl` in the explorer.
