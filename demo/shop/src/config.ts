import { Cart } from "./cart.ts";

export const TAX_RATE = 0.24;
export const FREE_SHIPPING_OVER = 5000;

export function emptyCart(): Cart {
  return new Cart();
}
