require("dotenv").config();

const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const Razorpay = require("razorpay");
const admin = require("firebase-admin");

// -------------------- CONFIG --------------------

const VALID_PLANS = {
  weekly: {
    durationDays: 7,
    amount: 2.99,
    currency: (process.env.RAZORPAY_ORDER_CURRENCY || "GBP").trim().toUpperCase(),
  },
  monthly: {
    durationDays: 30,
    amount: 8.99,
    currency: (process.env.RAZORPAY_ORDER_CURRENCY || "GBP").trim().toUpperCase(),
  },
};

// -------------------- FIREBASE ADMIN --------------------

/**
 * Initialize Firebase Admin once. Does not throw — returns false if credentials missing/invalid.
 * Railway: set FIREBASE_SERVICE_ACCOUNT_JSON (single-line JSON).
 * Local dev: same, OR download service account JSON and set GOOGLE_APPLICATION_CREDENTIALS to the file path.
 */
function initFirebaseAdmin() {
  if (admin.apps.length > 0) return true;

  const rawEnv = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
  if (rawEnv) {
    try {
      const serviceAccount = JSON.parse(rawEnv);
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
      return true;
    } catch (e) {
      console.error(
        "[payment-api] FIREBASE_SERVICE_ACCOUNT_JSON is invalid JSON:",
        e.message
      );
      return false;
    }
  }

  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  if (credPath) {
    try {
      const resolved = path.isAbsolute(credPath)
        ? credPath
        : path.resolve(process.cwd(), credPath);
      if (!fs.existsSync(resolved)) {
        console.error(
          "[payment-api] GOOGLE_APPLICATION_CREDENTIALS file not found:",
          resolved
        );
        return false;
      }
      const serviceAccount = JSON.parse(fs.readFileSync(resolved, "utf8"));
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
      return true;
    } catch (e) {
      console.error(
        "[payment-api] Failed to load GOOGLE_APPLICATION_CREDENTIALS:",
        e.message
      );
      return false;
    }
  }

  return false;
}

function ensureFirebaseAdmin(req, res, next) {
  if (!initFirebaseAdmin()) {
    return res.status(503).json({
      success: false,
      error:
        "Firebase Admin not configured. Set FIREBASE_SERVICE_ACCOUNT_JSON (Railway) or GOOGLE_APPLICATION_CREDENTIALS path to your service account JSON file (.env). See .env.example.",
    });
  }
  next();
}

// -------------------- EXPRESS --------------------

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "256kb" }));

// -------------------- RAZORPAY --------------------

const getRazorpayCredentials = () => {
  const keyId = process.env.RAZORPAY_KEY_ID?.trim();
  const secret =
    process.env.RAZORPAY_SECRET?.trim() ||
    process.env.RAZORPAY_KEY_SECRET?.trim();

  if (!keyId || !secret) return null;
  return { keyId, secret };
};

// -------------------- HELPERS --------------------

function validatePaymentRequest(authUid, userId, planType, amount) {
  if (!authUid || authUid !== userId) {
    throw { code: "unauthenticated", message: "Login required" };
  }

  if (!VALID_PLANS[planType]) {
    throw { code: "invalid-argument", message: "Invalid plan type" };
  }

  const plan = VALID_PLANS[planType];
  const numAmount = Number(amount);

  if (numAmount !== plan.amount) {
    throw { code: "invalid-argument", message: "Invalid amount" };
  }

  return { plan, numAmount };
}

const DOMAIN_ERROR_CODES = new Set([
  "unauthenticated",
  "invalid-argument",
  "already-exists",
  "failed-precondition",
  "internal",
]);

/**
 * Normalize app errors and Razorpay SDK errors (`{ statusCode, error: { description, code } }`).
 */
function normalizeApiError(err) {
  if (!err) {
    return {
      code: "internal",
      message: "Unknown error",
      status: 500,
    };
  }

  if (
    typeof err.code === "string" &&
    DOMAIN_ERROR_CODES.has(err.code) &&
    typeof err.message === "string"
  ) {
    const status =
      err.code === "unauthenticated"
        ? 401
        : err.code === "invalid-argument"
        ? 400
        : err.code === "already-exists"
        ? 409
        : err.code === "failed-precondition"
        ? 503
        : 500;
    return { code: err.code, message: err.message, status };
  }

  const rpDesc =
    err.error?.description ||
    err.error?.reason ||
    (typeof err.error === "string" ? err.error : "");
  const http =
    typeof err.statusCode === "number" ? err.statusCode : undefined;
  const message =
    rpDesc ||
    err.message ||
    (typeof err === "string" ? err : "") ||
    "Payment provider error";

  if (http === 401) {
    return {
      code: "unauthenticated",
      message:
        message ||
        "Razorpay rejected credentials — check RAZORPAY_KEY_ID and RAZORPAY_SECRET on Railway.",
      status: 401,
    };
  }

  if (http !== undefined && http >= 400 && http < 500) {
    return {
      code: err.error?.code || "invalid-argument",
      message,
      status: http,
    };
  }

  return { code: "internal", message, status: http && http >= 500 ? http : 500 };
}

function sendError(res, err) {
  const n = normalizeApiError(err);
  console.error("[payment-api]", n.status, n.code, n.message, err);
  return res.status(n.status).json({
    success: false,
    error: {
      code: n.code,
      message: n.message,
    },
  });
}

// -------------------- AUTH --------------------

async function authenticateFirebase(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ")
      ? header.split("Bearer ")[1]
      : null;

    if (!token) {
      return sendError(res, {
        code: "unauthenticated",
        message: "Missing token",
      });
    }

    const decoded = await admin.auth().verifyIdToken(token);
    req.authUid = decoded.uid;

    next();
  } catch (err) {
    return sendError(res, {
      code: "unauthenticated",
      message: "Invalid token",
    });
  }
}

// -------------------- ROUTES --------------------

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// CREATE ORDER
app.post(
  "/api/payments/create-order",
  ensureFirebaseAdmin,
  authenticateFirebase,
  async (req, res) => {
    try {
      const { userId, planType, amount } = req.body;

      const { plan, numAmount } = validatePaymentRequest(
        req.authUid,
        userId,
        planType,
        amount
      );

      const creds = getRazorpayCredentials();

      if (!creds) {
        throw {
          code: "internal",
          message: "Missing Razorpay credentials",
        };
      }

      const razorpay = new Razorpay({
        key_id: creds.keyId,
        key_secret: creds.secret,
      });

      const order = await razorpay.orders.create({
        amount: Math.round(numAmount * 100),
        currency: plan.currency,
        receipt: `${userId}_${planType}_${Date.now()}`,
        notes: { userId, planType },
      });

      res.json({
        success: true,
        orderId: order.id,
        amount: order.amount,
        currency: order.currency,
      });
    } catch (err) {
      return sendError(res, err);
    }
  }
);

// VERIFY PAYMENT
app.post(
  "/api/payments/verify",
  ensureFirebaseAdmin,
  authenticateFirebase,
  async (req, res) => {
    try {
      const {
        razorpay_order_id,
        razorpay_payment_id,
        razorpay_signature,
        userId,
        planType,
        amount,
      } = req.body;

      if (
        !razorpay_order_id ||
        !razorpay_payment_id ||
        !razorpay_signature
      ) {
        throw {
          code: "invalid-argument",
          message: "Missing payment data",
        };
      }

      const { plan, numAmount } = validatePaymentRequest(
        req.authUid,
        userId,
        planType,
        amount
      );

      const db = admin.firestore();

      const existing = await db
        .collection("subscriptions")
        .where("paymentId", "==", razorpay_payment_id)
        .limit(1)
        .get();

      if (!existing.empty) {
        throw {
          code: "already-exists",
          message: "Payment already processed",
        };
      }

      const creds = getRazorpayCredentials();
      if (!creds) {
        throw {
          code: "internal",
          message: "Missing Razorpay credentials",
        };
      }

      const signature = crypto
        .createHmac("sha256", creds.secret)
        .update(razorpay_order_id + "|" + razorpay_payment_id)
        .digest("hex");

      if (signature !== razorpay_signature) {
        throw {
          code: "invalid-argument",
          message: "Invalid signature",
        };
      }

      const now = Date.now();
      const expiry = now + plan.durationDays * 86400000;

      const doc = await db.collection("subscriptions").add({
        userId,
        paymentId: razorpay_payment_id,
        orderId: razorpay_order_id,
        planType,
        amount: numAmount,
        status: "active",
        verified: true,
        platform: "razorpay",
        createdAt: now,
        expiryDate: expiry,
      });

      res.json({
        success: true,
        subscriptionId: doc.id,
      });
    } catch (err) {
      return sendError(res, err);
    }
  }
);

// -------------------- 404 --------------------

app.use((req, res) => {
  res.status(404).json({ error: "Route not found" });
});

// -------------------- START --------------------

app.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on port", PORT);
  if (!initFirebaseAdmin()) {
    console.warn(
      "[payment-api] Firebase Admin not configured — /health still works; payment routes return 503 until you set FIREBASE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS."
    );
  }
});