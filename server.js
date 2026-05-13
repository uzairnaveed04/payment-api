require("dotenv").config();

const fs = require("fs");
const path = require("path");
const util = require("util");
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const Razorpay = require("razorpay");
const admin = require("firebase-admin");

/** Set when Firebase Admin initializes successfully — compared to JWT `iss` for diagnostics */
let firebaseAdminProjectId = null;

// -------------------- CONFIG --------------------

/** Default INR — typical Razorpay dashboard accounts; UK/EU uses GBP via RAZORPAY_ORDER_CURRENCY=GBP */
const ORDER_CURRENCY = (
  process.env.RAZORPAY_ORDER_CURRENCY || "INR"
).trim().toUpperCase();

const VALID_PLANS = {
  weekly: {
    durationDays: 7,
    /** Razorpay smallest currency unit (paise / pence): 2.99 → 299 */
    amountMinor: 299,
    currency: ORDER_CURRENCY,
  },
  monthly: {
    durationDays: 30,
    amountMinor: 899,
    currency: ORDER_CURRENCY,
  },
};

// -------------------- FIREBASE ADMIN --------------------

/** Decode JWT payload without verifying (debug only). */
function decodeJwtPayloadUnverified(token) {
  try {
    const parts = String(token).split(".");
    if (parts.length < 2) return null;
    let b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const pad = "=".repeat((4 - (b64.length % 4)) % 4);
    const json = Buffer.from(b64 + pad, "base64").toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function firebaseProjectIdFromIss(iss) {
  if (!iss || typeof iss !== "string") return null;
  const m = iss.match(/https:\/\/securetoken\.google\.com\/([^/]+)/);
  return m ? m[1] : null;
}

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
  serviceAccount.private_key = serviceAccount.private_key
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n");
}

/**
 * Parse service account JSON from env: strip BOM, optional base64 wrapper,
 * optional outer JSON-string wrapping (Railway / escape mistakes).
 */
function parseServiceAccountFromEnv(raw) {
  let trimmed = String(raw).replace(/^\uFEFF/, "").trim();
  // Whole value is a JSON *string* containing stringified JSON
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const inner = JSON.parse(trimmed);
      if (typeof inner === "string") trimmed = inner.trim();
    } catch (_) {
      /* keep trimmed */
    }
  }
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
 *    If this variable is non-empty but invalid JSON → FAIL (do not fall through to split-env).
 * 2) GOOGLE_APPLICATION_CREDENTIALS — path to the downloaded JSON file (local dev).
 * 3) FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY — only when JSON var is unset/empty.
 */
function initFirebaseAdmin() {
  if (admin.apps.length > 0) return true;

  const rawEnv = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const trimmedEnv =
    typeof rawEnv === "string" ? rawEnv.replace(/^\uFEFF/, "").trim() : "";

  if (trimmedEnv.length > 0) {
    try {
      const serviceAccount = parseServiceAccountFromEnv(trimmedEnv);
      normalizePrivateKeyInServiceAccount(serviceAccount);
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
      firebaseAdminProjectId = serviceAccount.project_id || null;
      console.log(
        "[payment-api] Firebase Admin OK via FIREBASE_SERVICE_ACCOUNT_JSON project_id=",
        firebaseAdminProjectId,
        "client_email=",
        serviceAccount.client_email
      );
      const expect = process.env.FIREBASE_EXPECT_PROJECT_ID?.trim();
      if (expect && firebaseAdminProjectId && expect !== firebaseAdminProjectId) {
        console.error(
          "[payment-api] FIREBASE_EXPECT_PROJECT_ID mismatch: env expects",
          expect,
          "but JSON has",
          firebaseAdminProjectId
        );
      }
      return true;
    } catch (e) {
      console.error(
        "[payment-api] FIREBASE_SERVICE_ACCOUNT_JSON invalid (fix Railway JSON; split-env will NOT be tried):",
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
      firebaseAdminProjectId = serviceAccount.project_id || null;
      console.log(
        "[payment-api] Firebase Admin OK via GOOGLE_APPLICATION_CREDENTIALS project_id=",
        firebaseAdminProjectId
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
      firebaseAdminProjectId = split.project_id || null;
      console.log(
        "[payment-api] Firebase Admin OK via split env project_id=",
        firebaseAdminProjectId
      );
      return true;
    } catch (e) {
      console.error(
        "[payment-api] Split Firebase env vars failed to initialize:",
        e.message
      );
      console.error(
        "[payment-api] Hint: Prefer FIREBASE_SERVICE_ACCOUNT_JSON on Railway; remove broken FIREBASE_PRIVATE_KEY split vars."
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

/** Razorpay receipt max length is 40 — Firebase uid + plan + timestamp exceeds that. */
function razorpayReceipt(userId, planType) {
  const raw = `${userId}|${planType}|${Date.now()}|${crypto.randomBytes(8).toString("hex")}`;
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 40);
}

// -------------------- HELPERS --------------------

/**
 * Validates Firebase user + plan. Pricing comes only from VALID_PLANS (never trust client `amount`).
 * Optional client `amount` is logged if it looks wrong — major (2.99) or minor (299) both tolerated for logging only.
 */
function validatePaymentRequest(authUid, userId, planType, amountFromClient) {
  if (!authUid || authUid !== userId) {
    throw { code: "unauthenticated", message: "Login required" };
  }

  const planKey =
    typeof planType === "string" ? planType.trim() : planType;

  if (planKey == null || planKey === "") {
    throw { code: "invalid-argument", message: "Missing plan type" };
  }

  if (!VALID_PLANS[planKey]) {
    throw { code: "invalid-argument", message: "Invalid plan type" };
  }

  const plan = VALID_PLANS[planKey];
  const amountMinor = plan.amountMinor;
  const amountMajor = amountMinor / 100;

  if (
    amountFromClient !== undefined &&
    amountFromClient !== null &&
    amountFromClient !== ""
  ) {
    const clientNum = Number(amountFromClient);
    if (!Number.isFinite(clientNum)) {
      console.warn(
        "[payment-api] Client amount is not numeric (ignored for pricing):",
        amountFromClient
      );
    } else {
      const matchesMajor = clientNum === amountMajor;
      const matchesMinor = clientNum === amountMinor;
      if (!matchesMajor && !matchesMinor) {
        console.warn(
          "[payment-api] Client amount ignored — server uses plan price only. Got:",
          amountFromClient,
          "(major:",
          amountMajor,
          "minor:",
          amountMinor,
          ")"
        );
      }
    }
  }

  return { plan, amountMinor, amountMajor };
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

function tokenVerifyClientMessage(err) {
  const c = err?.errorInfo?.code || err?.code;
  if (c === "auth/id-token-expired") return "Token expired — please sign in again.";
  if (c === "auth/id-token-revoked") return "Session revoked — please sign in again.";
  if (c === "auth/user-disabled") return "Account disabled.";
  if (c === "auth/argument-error") return "Malformed token.";
  return "Invalid token";
}

async function authenticateFirebase(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ")
      ? header.slice("Bearer ".length).trim()
      : null;

    if (!token) {
      return sendError(
        res,
        {
          code: "unauthenticated",
          message: "Missing token",
        },
        { route: "authenticateFirebase" }
      );
    }

    const preview =
      token.length >= 20 ? `${token.slice(0, 20)}…` : `${token.slice(0, 8)}…`;
    const payload = decodeJwtPayloadUnverified(token);

    if (payload) {
      const projFromToken = firebaseProjectIdFromIss(payload.iss);
      console.log("[payment-api] Bearer preview:", preview);
      console.log("[payment-api] JWT claims (unverified)", {
        iss: payload.iss,
        aud: payload.aud,
        projectFromIss: projFromToken,
        subPreview:
          typeof payload.sub === "string"
            ? `${payload.sub.slice(0, 14)}…`
            : payload.sub,
      });

      if (
        firebaseAdminProjectId &&
        projFromToken &&
        projFromToken !== firebaseAdminProjectId
      ) {
        console.error(
          "[payment-api] TOKEN vs ADMIN PROJECT MISMATCH — token project:",
          projFromToken,
          "Firebase Admin project_id:",
          firebaseAdminProjectId,
          "| Fix: use service account JSON from the SAME Firebase project that issued this idToken (routingapp-4bcb4)."
        );
      }
    } else {
      console.warn(
        "[payment-api] Bearer present but JWT payload could not be decoded (truncated or not a JWT)."
      );
    }

    const decoded = await admin.auth().verifyIdToken(token);
    req.authUid = decoded.uid;

    next();
  } catch (err) {
    const fbCode = err?.errorInfo?.code || err?.code;
    console.error(
      "[payment-api] verifyIdToken FAILED:",
      fbCode || err?.name,
      err?.message
    );

    return sendError(
      res,
      {
        code: "unauthenticated",
        message: tokenVerifyClientMessage(err),
      },
      { route: "authenticateFirebase" }
    );
  }
}

// -------------------- ROUTES --------------------

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

/**
 * Confirms deployed build (Railway). Old deploys had no route here.
 * New API errors are always `{ success:false, error:{ code, message } }` — never `error: "string"`.
 */
app.get("/version", (_req, res) => {
  res.json({
    name: "payment-api",
    apiPricingVersion: 2,
    serverSidePricingOnly: true,
    orderCurrencyDefault: ORDER_CURRENCY,
    plans: Object.keys(VALID_PLANS).map((id) => ({
      id,
      amountMinor: VALID_PLANS[id].amountMinor,
      currency: VALID_PLANS[id].currency,
    })),
  });
});

// CREATE ORDER
app.post(
  "/api/payments/create-order",
  ensureFirebaseAdmin,
  authenticateFirebase,
  async (req, res) => {
    try {
      const { userId, amount } = req.body;
      const rawPlan = req.body?.planType;
      const planType =
        typeof rawPlan === "string" ? rawPlan.trim() : rawPlan;

      console.log("[payment-api] create-order body:", {
        planType,
        amount,
        typeofAmount: typeof amount,
      });

      const { plan, amountMinor } = validatePaymentRequest(
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

      console.log("[payment-api] Razorpay orders.create", {
        planType,
        currency: plan.currency,
        amountMinorUnits: amountMinor,
      });

      const order = await razorpay.orders.create({
        amount: amountMinor,
        currency: plan.currency,
        receipt: razorpayReceipt(userId, planType),
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
        amount,
      } = req.body;
      const rawPlan = req.body?.planType;
      const planType =
        typeof rawPlan === "string" ? rawPlan.trim() : rawPlan;

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

      const { plan, amountMajor } = validatePaymentRequest(
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
        amount: amountMajor,
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