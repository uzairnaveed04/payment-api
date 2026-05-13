/**
 * Smoke test: Firebase Admin custom token -> Identity Toolkit idToken -> POST create-order.
 *
 * Prereqs (backend/.env): FIREBASE_SERVICE_ACCOUNT_JSON, RAZORPAY_KEY_ID, RAZORPAY_SECRET
 * Also needs Web API key from the SAME Firebase project, either:
 *   - mobile/.env EXPO_PUBLIC_FIREBASE_API_KEY, or
 *   - backend/.env FIREBASE_WEB_API_KEY
 *
 * Run with server already up: node scripts/local-payment-flow-test.js
 */

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
require("dotenv").config({
  path: require("path").join(__dirname, "..", "..", "mobile", ".env"),
});

const admin = require("firebase-admin");
const http = require("http");

const apiKey =
  process.env.EXPO_PUBLIC_FIREBASE_API_KEY?.trim() ||
  process.env.FIREBASE_WEB_API_KEY?.trim();

function initAdminFromEnv() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
  if (!raw) {
    throw new Error(
      "FIREBASE_SERVICE_ACCOUNT_JSON missing in backend/.env — cannot mint idToken locally."
    );
  }
  const serviceAccount = JSON.parse(raw);
  if (typeof serviceAccount.private_key === "string") {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
  }
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  }
}

async function mintIdToken(uid) {
  initAdminFromEnv();
  const customToken = await admin.auth().createCustomToken(uid);
  const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: customToken,
      returnSecureToken: true,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.idToken) {
    throw new Error(
      `signInWithCustomToken failed (${res.status}): ${JSON.stringify(data)}`
    );
  }
  return { idToken: data.idToken, uid };
}

function postCreateOrder(port, idToken, uid) {
  const payload = JSON.stringify({
    userId: uid,
    planType: "weekly",
    amount: 2.99,
  });

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "localhost",
        port,
        path: "/api/payments/create-order",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          Authorization: `Bearer ${idToken}`,
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => {
          raw += c;
        });
        res.on("end", () => {
          resolve({ status: res.statusCode, raw });
        });
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function main() {
  const port = parseInt(process.env.PORT || "3000", 10);

  if (!apiKey) {
    console.error(
      "Missing Web API key: set EXPO_PUBLIC_FIREBASE_API_KEY in mobile/.env or FIREBASE_WEB_API_KEY in backend/.env"
    );
    process.exit(1);
  }

  const uid = `local-smoke-${Date.now()}`;
  console.log("[local-payment-flow-test] Minting idToken for uid:", uid);
  const { idToken } = await mintIdToken(uid);

  console.log("[local-payment-flow-test] POST /api/payments/create-order …");
  const r = await postCreateOrder(port, idToken, uid);

  console.log("[local-payment-flow-test] HTTP status:", r.status);
  let parsed;
  try {
    parsed = JSON.parse(r.raw);
    console.log(JSON.stringify(parsed, null, 2));
  } catch {
    console.log(r.raw);
  }

  if (r.status === 200 && parsed?.success && parsed?.orderId) {
    console.log("\nOK — create-order succeeded locally.");
    process.exit(0);
  }

  console.error("\nFAILED — see server console for [payment-api] Raw error lines.");
  process.exit(1);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
