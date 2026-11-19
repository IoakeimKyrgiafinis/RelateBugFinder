export interface Coupon { code: string; pct: number }

const COUPONS: Coupon[] = [
  { code: "WELCOME10", pct: 10 },
  { code: "BLACKFRIDAY", pct: 30 },
];

export function lookupCoupon(code: string): Coupon {
  return COUPONS.find((c) => c.code === code) ?? { code, pct: 0 };
}
