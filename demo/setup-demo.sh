#!/usr/bin/env bash
# Builds ./demo-shop: a small TS + Python repo whose git history hides a bug 3 hours ago.
# Usage: bash demo/setup-demo.sh [target-dir]
set -euo pipefail
DIR="${1:-demo-shop}"
rm -rf "$DIR" && mkdir -p "$DIR/src" "$DIR/tests" "$DIR/scripts" && cd "$DIR"
git init -q -b main
git config user.email "dev@example.com"; git config user.name "Dana Dev"
commit() { # commit <hours-ago> <author> <message>
  local d; d=$(date -u -d "@$(( $(date +%s) - $1*3600 ))" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v-"$1"H +%Y-%m-%dT%H:%M:%SZ)
  git add -A && GIT_AUTHOR_NAME="$2" GIT_COMMITTER_NAME="$2" GIT_AUTHOR_DATE="$d" GIT_COMMITTER_DATE="$d" git commit -q -m "$3"
}

cat > package.json <<'EOF'
{ "name": "demo-shop", "type": "module", "scripts": { "start": "node --experimental-strip-types src/index.ts" } }
EOF
cat > src/money.ts <<'EOF'
export function formatPrice(cents: number, currency = "EUR"): string {
  return new Intl.NumberFormat("en-IE", { style: "currency", currency }).format(cents / 100);
}

export function applyDiscount(cents: number, pct: number): number {
  if (pct < 0 || pct > 100) throw new RangeError(`bad discount ${pct}`);
  return Math.round(cents * (1 - pct / 100));
}
EOF
cat > src/config.ts <<'EOF'
import { Cart } from "./cart.ts";

export const TAX_RATE = 0.24;
export const FREE_SHIPPING_OVER = 5000;

export function emptyCart(): Cart {
  return new Cart();
}
EOF
cat > src/coupons.ts <<'EOF'
export interface Coupon { code: string; pct: number }

const COUPONS: Coupon[] = [
  { code: "WELCOME10", pct: 10 },
  { code: "BLACKFRIDAY", pct: 30 },
];

export function lookupCoupon(code: string): Coupon {
  return COUPONS.find((c) => c.code === code) ?? { code, pct: 0 };
}
EOF
cat > src/cart.ts <<'EOF'
import { applyDiscount, formatPrice } from "./money.ts";
import { lookupCoupon } from "./coupons.ts";
import { TAX_RATE } from "./config.ts";

export interface Item { sku: string; cents: number; qty: number }

export class Cart {
  items: Item[] = [];

  addItem(item: Item) {
    this.items.push(item);
    return this;
  }

  subtotal(): number {
    return this.items.reduce((sum, i) => sum + i.cents * i.qty, 0);
  }

  total(couponCode?: string): number {
    let cents = this.subtotal();
    if (couponCode) {
      const coupon = lookupCoupon(couponCode);
      cents = applyDiscount(cents, coupon.pct);
    }
    return Math.round(cents * (1 + TAX_RATE));
  }

  summary(couponCode?: string): string {
    return `${this.items.length} items, total ${formatPrice(this.total(couponCode))}`;
  }
}
EOF
cat > src/receipt.ts <<'EOF'
import { Cart } from "./cart.ts";

export function renderReceipt(cart: Cart, couponCode?: string): string {
  const lines = cart.items.map((i) => `${i.sku} x${i.qty}`);
  return [...lines, "----", cart.summary(couponCode)].join("\n");
}
EOF
cat > src/inventory.ts <<'EOF'
const STOCK: Record<string, number> = { "MUG-01": 12, "TEE-02": 3, "CAP-03": 0 };

export function inStock(sku: string, qty: number): boolean {
  return (STOCK[sku] ?? 0) >= qty;
}

export function reserve(sku: string, qty: number): void {
  if (!inStock(sku, qty)) throw new Error(`Out of stock: ${sku}`);
  STOCK[sku] -= qty;
}
EOF
cat > src/checkout.ts <<'EOF'
import { emptyCart } from "./config.ts";
import { reserve } from "./inventory.ts";
import { renderReceipt } from "./receipt.ts";
import type { Item } from "./cart.ts";

export function checkout(items: Item[], couponCode?: string): string {
  const cart = emptyCart();
  for (const item of items) {
    reserve(item.sku, item.qty);
    cart.addItem(item);
  }
  return renderReceipt(cart, couponCode);
}
EOF
cat > src/index.ts <<'EOF'
import { checkout } from "./checkout.ts";

const code = process.argv[2];
console.log(checkout([{ sku: "MUG-01", cents: 1500, qty: 2 }, { sku: "TEE-02", cents: 2500, qty: 1 }], code));
EOF
cat > tests/cart.test.ts <<'EOF'
import { Cart } from "../src/cart.ts";
import { checkout } from "../src/checkout.ts";

export function testTotalWithCoupon() {
  const c = new Cart().addItem({ sku: "MUG-01", cents: 1000, qty: 1 });
  if (c.total("WELCOME10") !== 1116) throw new Error("wrong total");
}

export function testCheckoutReceipt() {
  if (!checkout([{ sku: "MUG-01", cents: 1000, qty: 1 }]).includes("total")) throw new Error("no total");
}
EOF
cat > scripts/analytics.py <<'EOF'
def conversion_rate(orders, visits):
    return orders / visits


def weekly_report(rows):
    return [summarize(r) for r in rows]


def summarize(row):
    return {"day": row["day"], "rate": conversion_rate(row["orders"], row["visits"])}
EOF
cat > scripts/report.py <<'EOF'
from analytics import weekly_report


class ReportJob:
    def __init__(self, rows):
        self.rows = rows

    def run(self):
        return self.render(weekly_report(self.rows))

    def render(self, data):
        return "\n".join(f"{d['day']}: {d['rate']:.1%}" for d in data)


if __name__ == "__main__":
    print(ReportJob([{"day": "Mon", "orders": 3, "visits": 120}, {"day": "Tue", "orders": 0, "visits": 0}]).run())
EOF
commit 480 "Dana Dev" "Initial shop: cart, money, coupons, checkout"

sed -i.bak 's/"TEE-02": 3/"TEE-02": 5/' src/inventory.ts && rm -f src/inventory.ts.bak
commit 120 "Sam Ops" "Restock tees"

cat > src/coupons.ts <<'EOF'
export interface Coupon { code: string; pct: number }

const COUPONS: Coupon[] = [
  { code: "WELCOME10", pct: 10 },
  { code: "BLACKFRIDAY", pct: 30 },
];

const REGIONAL: Record<string, Coupon[]> = { gr: [{ code: "KALIMERA", pct: 15 }] };

export function lookupCoupon(code: string, region = "eu"): Coupon {
  const pool = REGIONAL[region] ?? COUPONS;
  return pool.find((c) => c.code === code)!;
}
EOF
commit 3 "Alex Rivera" "Support regional coupon pools"

# An uncommitted, unrelated tweak — shows that "recent" alone isn't enough; graph distance matters.
sed -i.bak 's/return (STOCK\[sku\] ?? 0) >= qty;/return qty > 0 \&\& (STOCK[sku] ?? 0) >= qty;/' src/inventory.ts && rm -f src/inventory.ts.bak
echo "trace.txt" >> .git/info/exclude
node --experimental-strip-types src/index.ts NOPE 2> trace.txt >/dev/null || true
echo "Demo repo ready in $(pwd). Reproduce the crash with: node --experimental-strip-types src/index.ts NOPE"
