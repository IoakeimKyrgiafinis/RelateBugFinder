import { Cart } from "../src/cart.ts";
import { checkout } from "../src/checkout.ts";

export function testTotalWithCoupon() {
  const c = new Cart().addItem({ sku: "MUG-01", cents: 1000, qty: 1 });
  if (c.total("WELCOME10") !== 1116) throw new Error("wrong total");
}

export function testCheckoutReceipt() {
  if (!checkout([{ sku: "MUG-01", cents: 1000, qty: 1 }]).includes("total")) throw new Error("no total");
}
