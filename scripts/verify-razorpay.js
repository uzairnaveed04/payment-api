/**
 * Verifies Razorpay Key ID + Secret by creating a tiny test order (no Firebase).
 * Run from backend folder: npm run test:razorpay
 */

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const util = require("util");
const Razorpay = require("razorpay");

const keyId = process.env.RAZORPAY_KEY_ID?.trim();
const secret =
  process.env.RAZORPAY_SECRET?.trim() ||
  process.env.RAZORPAY_KEY_SECRET?.trim();

async function main() {
  if (!keyId || !secret) {
    console.error(
      "Missing RAZORPAY_KEY_ID or RAZORPAY_SECRET in backend/.env (copy from .env.example)."
    );
    process.exit(1);
  }

  if (!keyId.startsWith("rzp_test_")) {
    console.warn(
      "Key ID does not start with rzp_test_ — using LIVE keys only if you intend to."
    );
  }

  const razorpay = new Razorpay({ key_id: keyId, key_secret: secret });

  // Matches server.js weekly plan (default currency INR). Fallback GBP for international accounts.
  const attempts = [
    { amount: Math.round(2.99 * 100), currency: "INR", label: "INR weekly (matches server default)" },
    { amount: Math.round(2.99 * 100), currency: "GBP", label: "GBP weekly (if RAZORPAY_ORDER_CURRENCY=GBP)" },
    { amount: 100, currency: "INR", label: "INR ₹1 minimal fallback" },
  ];

  let lastErr;

  for (const { amount, currency, label } of attempts) {
    try {
      console.log("Trying:", label, `(${amount} ${currency})`);
      const order = await razorpay.orders.create({
        amount,
        currency,
        receipt: `cred_check_${Date.now()}`,
        notes: { purpose: "credential verification script" },
      });

      if (!order?.id) {
        lastErr = new Error("Unexpected Razorpay response (no order id)");
        continue;
      }

      console.log("");
      console.log("OK — Razorpay Key ID + Secret are valid.");
      console.log("   Order id:", order.id);
      console.log("   Amount (minor units):", order.amount, order.currency);
      console.log("   Key ID prefix:", keyId.slice(0, 12) + "...");
      if (currency !== "INR") {
        console.log("");
        console.log(
          "Note: INR default failed but another currency worked — check RAZORPAY_ORDER_CURRENCY matches your Razorpay account."
        );
      }
      process.exit(0);
    } catch (err) {
      lastErr = err;
      const desc =
        err?.error?.description ||
        err?.error?.reason ||
        err?.message ||
        util.inspect(err?.error ?? err, { depth: 6, breakLength: 120 })
          .split("\n")[0];
      console.log("   ->", desc.split("\n")[0]);
      if (!err?.error?.description && err?.statusCode) {
        console.log(
          "      full:",
          util.inspect(err, { depth: 8, breakLength: 120 })
        );
      }
    }
  }

  console.error("");
  console.error("FAILED — Razorpay rejected all attempts:");
  const desc =
    lastErr?.error?.description ||
    lastErr?.message ||
    JSON.stringify(lastErr?.error || lastErr);
  console.error(" ", desc);
  if (lastErr?.statusCode) console.error("   HTTP status:", lastErr.statusCode);
  console.error("");
  console.error("Check: Key ID matches Dashboard test keys, secret is current, no extra spaces in .env.");
  process.exit(1);
}

main();
