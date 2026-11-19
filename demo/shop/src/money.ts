export function formatPrice(cents: number, currency = "EUR"): string {
  return new Intl.NumberFormat("en-IE", { style: "currency", currency }).format(cents / 100);
}

export function applyDiscount(cents: number, pct: number): number {
  if (pct < 0 || pct > 100) throw new RangeError(`bad discount ${pct}`);
  return Math.round(cents * (1 - pct / 100));
}
