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
