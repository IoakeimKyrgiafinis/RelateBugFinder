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
