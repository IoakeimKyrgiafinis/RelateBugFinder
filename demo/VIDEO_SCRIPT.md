# 2-minute demo video: shot list

Before recording: close any VS Code window on demo-shop, run `npm run demo` (so "3h ago" is fresh), then F5. Have two terminals ready; make the font large.

**0:00–0:12 · The pain.** Terminal in VS Code (demo-shop open). Run `npm start -- NOPE`.
`TypeError: Cannot read properties of undefined (reading 'pct')` at `Cart.total`. Say: "The stack says Cart.total. Cart.total hasn't changed in 3 weeks."

**0:12–0:35 · One click.** The notification: *"coupon" was undefined: it came from lookupCoupon() — top suspect: lookupCoupon … changed 3h ago by Alex Rivera*. Click **Show suspects**.
Point at the **"Where the undefined came from"** box: it read `coupon.pct` and traced `coupon` back to `const coupon = lookupCoupon(couponCode)`. #1 is **not on the stack**: it produced the bad value, and it changed 3 hours ago. The uncommitted `inventory.ts` edit is more recent but *not* ranked: it isn't connected. "Recency × graph distance."

**0:35–1:05 · Deep trace: who produced the bad value.** Second terminal: `python -m unittest tests.test_orders.OrdersTest.test_bulk_order` → `ValueError: negative total: -10.000000000000014`, raised in `validate`. Show suspects: the changed helper `bulk_discount` is only #3; it already returned.
Click **Deep trace** → the confirm dialog shows the exact command → under a second later `bulk_discount` is **#1**: "Returned `-10.000000000000014`, the value in the error, before any other function did." Click **Compare with related passing tests**: `test_small_order` passes without calling it. Click the line chip on `order_total` → line 22 `total = bulk_discount(total)` highlighted. Say: "The run is stored in the graph next to the code and its history."

**1:05–1:15 · Fix with context.** Click **Ask AI to fix with this context**: the chat gets the suspects, reasons, the returned value, the lines and the code.

**1:15–1:30 · Before you refactor.** In `src/money.ts`, the CodeLens above `applyDiscount` → click → blast-radius graph + "Tests to run: tests/cart.test.ts".

**1:30–1:50 · Agents get the graph.** Copilot agent mode (or Claude Code): *"What breaks if I change lookupCoupon's return type?"* → it calls `get_blast_radius` instantly. Then *"Which functions ran in the failing test but not the passing one?"* → `query_codegraph` writes Cypher over `(:Run)-[:EXECUTED]->(:Function)`.

**1:50–2:00 · Close.** On screen: the held-out benchmark line, "Right function at #1: stack 20% → Relate Bug Finder 31% → with Deep trace 44% (114 real Python bugs)". Say: "One `.rl` file. Relate embedded in the editor. No server." Show `.vscode/codegraph.rl` in the explorer.
