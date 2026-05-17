/**
 * One-off Razorpay credential check — writes result to razorpay_selftest_result.txt (no secrets).
 * Usage (PowerShell):
 *   $env:RAZORPAY_KEY_ID='...'; $env:RAZORPAY_KEY_SECRET='...'; node scripts/razorpay-live-check.js
 */
const fs = require("fs");
const path = require("path");
const Razorpay = require("razorpay");

const outPath = path.join(__dirname, "..", "razorpay_selftest_result.txt");

const keyId = process.env.RAZORPAY_KEY_ID?.trim();
const secret =
  process.env.RAZORPAY_SECRET?.trim() ||
  process.env.RAZORPAY_KEY_SECRET?.trim();

async function run() {
  const lines = [`time=${new Date().toISOString()}`];
  if (!keyId || !secret) {
    lines.push("status=FAIL");
    lines.push("reason=missing RAZORPAY_KEY_ID or RAZORPAY_SECRET / RAZORPAY_KEY_SECRET in environment");
    fs.writeFileSync(outPath, lines.join("\n"), "utf8");
    process.exit(1);
  }

  const razorpay = new Razorpay({ key_id: keyId, key_secret: secret });
  const attempts = [
    { amount: Math.round(2.99 * 100), currency: "GBP", label: "gbp_weekly" },
    { amount: Math.round(8.99 * 100), currency: "GBP", label: "gbp_monthly" },
  ];

  for (const { amount, currency, label } of attempts) {
    try {
      const order = await razorpay.orders.create({
        amount,
        currency,
        receipt: `livechk_${Date.now()}`,
        notes: { check: label },
      });
      lines.push("status=OK");
      lines.push(`mode=${label}`);
      lines.push(`order_id=${order.id}`);
      lines.push(`amount_minor=${order.amount}`);
      lines.push(`currency=${order.currency}`);
      fs.writeFileSync(outPath, lines.join("\n"), "utf8");
      process.exit(0);
    } catch (err) {
      const msg =
        err?.error?.description || err?.message || JSON.stringify(err?.error || {});
      lines.push(`attempt_${label}_error=${msg.replace(/\n/g, " ")}`);
    }
  }

  lines.push("status=FAIL");
  lines.push("reason=all_order_attempts_failed");
  fs.writeFileSync(outPath, lines.join("\n"), "utf8");
  process.exit(1);
}

run().catch((e) => {
  fs.writeFileSync(
    outPath,
    `status=FAIL\nreason=${String(e.message)}`,
    "utf8"
  );
  process.exit(1);
});
