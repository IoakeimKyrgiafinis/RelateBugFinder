const STOCK: Record<string, number> = { "MUG-01": 12, "TEE-02": 3, "CAP-03": 0 };

export function inStock(sku: string, qty: number): boolean {
  return (STOCK[sku] ?? 0) >= qty;
}

export function reserve(sku: string, qty: number): void {
  if (!inStock(sku, qty)) throw new Error(`Out of stock: ${sku}`);
  STOCK[sku] -= qty;
}
