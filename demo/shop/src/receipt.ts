import { Cart } from "./cart.ts";

export function renderReceipt(cart: Cart, couponCode?: string): string {
  const lines = cart.items.map((i) => `${i.sku} x${i.qty}`);
  return [...lines, "----", cart.summary(couponCode)].join("\n");
}
