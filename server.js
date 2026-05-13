require("dotenv").config();

const fs = require("fs");
const path = require("path");
const util = require("util");
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const Razorpay = require("razorpay");
const admin = require("firebase-admin");

// -------------------- CONFIG --------------------

/** Default INR — typical Razorpay dashboard accounts; UK/EU uses GBP via RAZORPAY_ORDER_CURRENCY=GBP */
const ORDER_CURRENCY = (
  process.env.RAZORPAY_ORDER_CURRENCY || "INR"
).trim().toUpperCase();

const VALID_PLANS = {
  weekly: {
    durationDays: 7,
    amount: 2.99,
    currency: ORDER_CURRENCY,
  },
  monthly: {
    durationDays: 30,
    amount: 8.99,
    currency: ORDER_CURRENCY,
  },
};

// -------------------- FIREBASE ADMIN --------------------

/**
 * PEM in JSON copied into Railway often keeps literal "\\n" sequences — Firebase requires real newlines.
 */
function normalizePrivateKeyInServiceAccount(serviceAccount) {
  if (
    !serviceAccount ||
    typeof serviceAccount.private_key !== "string"
  ) {
    return;
  }
  serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
}

/**
 * Parse service account JSON from env: strip BOM, optional base64 wrapper (some dashboards encode JSON).
 */
function parseServiceAccountFromEnv(raw) {
  const trimmed = String(raw).replace(/^\uFEFF/, "").trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch (firstErr) {
    if (trimmed.startsWith("{")) throw firstErr;
    try {
      const decoded = Buffer.from(trimmed, "base64").toString("utf8");
      return JSON.parse(decoded);
    } catch {
      throw firstErr;
    }
  }
}

function credentialFromSplitEnv() {
  const projectId = process.env.FIREBASE_PROJECT_ID?.trim();
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL?.trim();
  let privateKey = process.env.FIREBASE_PRIVATE_KEY?.trim();
  if (!projectId || !clientEmail || !privateKey) return null;
  privateKey = privateKey.replace(/\\n/g, "\n");
  return {
    project_id: projectId,
    client_email: clientEmail,
    private_key: privateKey,
  };
}

/**
 * Initialize Firebase Admin once. Does not throw — returns false if credentials missing/invalid.
 *
 * Priority:
 * 1) FIREBASE_SERVICE_ACCOUNT_JSON — full service account JSON (recommended on Railway).
 * 2) GOOGLE_APPLICATION_CREDENTIALS — path to the downloaded JSON file (local dev).
 * 3) FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY — optional fallback only if JSON unset.
 */
function initFirebaseAdmin() {
  if (admin.apps.length > 0) return true;

  const rawEnv = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
  if (rawEnv) {
    try {
      const serviceAccount = parseServiceAccountFromEnv(rawEnv);
      normalizePrivateKeyInServiceAccount(serviceAccount);
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
      console.log(
        "[payment-api] Firebase Admin initialized from FIREBASE_SERVICE_ACCOUNT_JSON"
      );
      return true;
    } catch (e) {
      console.error(
        "[payment-api] FIREBASE_SERVICE_ACCOUNT_JSON could not be parsed:",
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
      normalizePrivateKeyInServiceAccount(serviceAccount);
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
      console.log(
        "[payment-api] Firebase Admin initialized from GOOGLE_APPLICATION_CREDENTIALS"
      );
      return true;
    } catch (e) {
      console.error(
        "[payment-api] Failed to load GOOGLE_APPLICATION_CREDENTIALS:",
        e.message
      );
      return false;
    }
  }

  const split = credentialFromSplitEnv();
  if (split) {
    try {
      admin.initializeApp({
        credential: admin.credential.cert(split),
      });
      console.log(
        "[payment-api] Firebase Admin initialized from FIREBASE_PROJECT_ID / CLIENT_EMAIL / PRIVATE_KEY"
      );
      return true;
    } catch (e) {
      console.error(
        "[payment-api] Split Firebase env vars failed to initialize:",
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
      error: {
        code: "failed-precondition",
        message:
          "Firebase Admin not configured. Set FIREBASE_SERVICE_ACCOUNT_JSON (Railway, single-line JSON) or GOOGLE_APPLICATION_CREDENTIALS (local file path). See backend/.env.example.",
      },
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

function isPlainDomainError(err) {
  return (
    err &&
    typeof err === "object" &&
    typeof err.code === "string" &&
    DOMAIN_ERROR_CODES.has(err.code) &&
    typeof err.message === "string" &&
    err.statusCode === undefined &&
    err.response === undefined &&
    err.error === undefined
  );
}

/** Razorpay SDK uses `{ statusCode, error }`; axios leaks `{ response: { status, data } }` in some failures */
function extractProviderMessage(err) {
  const rpDesc =
    err?.error?.description ||
    err?.error?.reason ||
    (typeof err?.error === "string" ? err.error : "");

  const ax = err?.response?.data;
  let axiosPart = "";
  if (ax && typeof ax === "object") {
    axiosPart =
      ax.error?.description ||
      ax.error?.reason ||
      (typeof ax.error === "string" ? ax.error : "") ||
      ax.message ||
      "";
  } else if (typeof ax === "string") {
    axiosPart = ax;
  }

  return rpDesc || axiosPart || "";
}

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

  const providerMsg = extractProviderMessage(err);
  const http =
    typeof err.statusCode === "number"
      ? err.statusCode
      : typeof err.response?.status === "number"
      ? err.response.status
      : undefined;

  const message =
    providerMsg ||
    (typeof err.message === "string" ? err.message : "") ||
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
      code: err.error?.code || err.response?.data?.error?.code || "invalid-argument",
      message,
      status: http,
    };
  }

  return { code: "internal", message, status: http && http >= 500 ? http : 500 };
}

function sendError(res, err, opts = {}) {
  const route = opts.route || "";
  if (!isPlainDomainError(err)) {
    console.error(
      `[payment-api] Raw error${route ? ` @ ${route}` : ""}:`,
      util.inspect(err, { depth: 12, maxArrayLength: 40, breakLength: 100 })
    );
  }

  const n = normalizeApiError(err);
  console.error(
    `[payment-api] Response${route ? ` @ ${route}` : ""}`,
    n.status,
    n.code,
    n.message
  );
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
          code: "failed-precondition",
          message:
            "Razorpay is not configured on the server: set RAZORPAY_KEY_ID and RAZORPAY_SECRET (or RAZORPAY_KEY_SECRET).",
        };
      }

      const razorpay = new Razorpay({
        key_id: creds.keyId,
        key_secret: creds.secret,
      });

      const amountMinor = Math.round(numAmount * 100);
      console.log("[payment-api] Razorpay orders.create", {
        planType,
        currency: plan.currency,
        amountMinorUnits: amountMinor,
      });

      const order = await razorpay.orders.create({
        amount: amountMinor,
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
      return sendError(res, err, { route: "POST /api/payments/create-order" });
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
          code: "failed-precondition",
          message:
            "Razorpay is not configured on the server: set RAZORPAY_KEY_ID and RAZORPAY_SECRET (or RAZORPAY_KEY_SECRET).",
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
      return sendError(res, err, { route: "POST /api/payments/verify" });
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
  const rz = getRazorpayCredentials();
  console.log("[payment-api] Order currency:", ORDER_CURRENCY);
  if (rz) {
    const masked =
      rz.keyId.length > 8
        ? `${rz.keyId.slice(0, 6)}…${rz.keyId.slice(-4)}`
        : "(short key)";
    console.log("[payment-api] Razorpay env: key_id present", masked);
  } else {
    console.warn(
      "[payment-api] Razorpay env MISSING — set RAZORPAY_KEY_ID and RAZORPAY_SECRET (create-order / verify will return 503)."
    );
  }
  if (!initFirebaseAdmin()) {
    console.warn(
      "[payment-api] Firebase Admin not configured — /health still works; payment routes return 503 until you set FIREBASE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS."
    );
  }
});