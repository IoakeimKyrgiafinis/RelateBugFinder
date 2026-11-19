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
