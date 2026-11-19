import { checkout } from "./checkout.ts";

const code = process.argv[2];
console.log(checkout([{ sku: "MUG-01", cents: 1500, qty: 2 }, { sku: "TEE-02", cents: 2500, qty: 1 }], code));
