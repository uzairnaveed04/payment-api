import * as functions from "firebase-functions/v2";
import * as admin from "firebase-admin";
import * as crypto from "crypto";
import { FieldValue } from "firebase-admin/firestore";
import { defineSecret } from "firebase-functions/params";

admin.initializeApp();

const expoAccessToken = defineSecret("EXPO_ACCESS_TOKEN");

type NotificationPrefCategory = "new_route" | "practice_reminder" | "app_update";

function normalizePrefs(raw: unknown): Record<NotificationPrefCategory, boolean> {
  const base: Record<NotificationPrefCategory, boolean> = {
    new_route: true,
    practice_reminder: true,
    app_update: true,
  };
  if (!raw || typeof raw !== "object") return base;
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(base) as NotificationPrefCategory[]) {
    if (typeof o[k] === "boolean") base[k] = o[k] as boolean;
  }
  return base;
}

function assertAuthenticated(request: functions.https.CallableRequest): string {
  if (!request.auth?.uid) {
    throw new functions.https.HttpsError(
      "unauthenticated",
      "Authentication required."
    );
  }
  return request.auth.uid;
}

function assertValidExpoPushToken(token: unknown): string {
  if (typeof token !== "string" || !/^ExponentPushToken\[[^\]]+\]$/.test(token.trim())) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "Invalid Expo push token."
    );
  }
  return token.trim();
}

async function postExpoPushMessage(opts: {
  accessToken: string;
  to: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
}): Promise<{ ok: true } | { ok: false; detail: string }> {
  const res = await fetch("https://exp.host/--/api/v2/push/send", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.accessToken}`,
    },
    body: JSON.stringify({
      to: opts.to,
      title: opts.title,
      body: opts.body,
      data: opts.data,
      sound: "default",
      priority: "high",
      channelId: "default",
    }),
  });

  const json = (await res.json()) as {
    errors?: { code?: string; message?: string }[];
    data?: { status?: string; message?: string; id?: string }[];
  };

  if (!res.ok) {
    const msg =
      json.errors?.map((e) => e.message).filter(Boolean).join("; ") ||
      `Expo Push HTTP ${res.status}`;
    return { ok: false, detail: msg };
  }

  const ticket = json.data?.[0];
  if (!ticket || ticket.status === "error") {
    const msg = ticket?.message || json.errors?.[0]?.message || "Expo push ticket error";
    return { ok: false, detail: msg };
  }

  return { ok: true };
}

/**
 * Razorpay credentials from environment (never commit real values).
 * Supports RAZORPAY_SECRET or RAZORPAY_KEY_SECRET — same value from Razorpay Dashboard.
 */
const getRazorpayCredentials = (): { keyId: string; secret: string } | null => {
  const keyId = process.env.RAZORPAY_KEY_ID?.trim();
  const secret =
    process.env.RAZORPAY_SECRET?.trim() ||
    process.env.RAZORPAY_KEY_SECRET?.trim();
  if (!keyId || !secret) {
    return null;
  }
  return { keyId, secret };
};

// Valid plan configurations
const VALID_PLANS: Record<string, { durationDays: number; amount: number; currency: string }> = {
  weekly: { durationDays: 7, amount: 2.99, currency: "GBP" },
  monthly: { durationDays: 30, amount: 8.99, currency: "GBP" }
};

const callableOptions = {
  region: "us-central1",
  cors: [
    "http://localhost:9090",
    "http://127.0.0.1:9090",
    "http://localhost:8081",
    "http://127.0.0.1:8081",
    "https://localhost",
    "https://localhost:8081"
  ]
};

/** Persist Expo token server-side so campaigns / tests can target this install. */
export const registerPushDevice = functions.https.onCall(callableOptions, async (request) => {
  try {
    const uid = assertAuthenticated(request);
    const expoPushToken = assertValidExpoPushToken(request.data?.expoPushToken);
    const prefs = normalizePrefs(request.data?.prefs);
    const platform =
      typeof request.data?.platform === "string" && request.data.platform.length > 0
        ? request.data.platform.slice(0, 32)
        : "unknown";

    await admin.firestore().collection("users").doc(uid).set(
      {
        expoPushToken,
        notificationPrefs: prefs,
        pushPlatform: platform,
        pushRegisteredAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return { success: true };
  } catch (error: unknown) {
    if (error instanceof functions.https.HttpsError) throw error;
    console.error("registerPushDevice error:", error);
    throw new functions.https.HttpsError(
      "internal",
      "Could not register push device."
    );
  }
});

/**
 * Sends one Expo push to the token saved on the user's profile (dev / QA).
 * Requires Secret Manager: EXPO_ACCESS_TOKEN (Expo account token with push permission).
 */
export const sendTestPushNotification = functions.https.onCall(
  {
    ...callableOptions,
    secrets: [expoAccessToken],
  },
  async (request) => {
    try {
      const uid = assertAuthenticated(request);
      const rawType = request.data?.type;
      const type: NotificationPrefCategory =
        rawType === "new_route" || rawType === "practice_reminder" || rawType === "app_update"
          ? rawType
          : "app_update";

      const snap = await admin.firestore().collection("users").doc(uid).get();
      const token = snap.get("expoPushToken");
      if (typeof token !== "string" || !/^ExponentPushToken\[[^\]]+\]$/.test(token.trim())) {
        throw new functions.https.HttpsError(
          "failed-precondition",
          "No Expo push token on file. Open the app once (notifications allowed), then try again."
        );
      }

      const prefs = normalizePrefs(snap.get("notificationPrefs"));
      if (prefs[type] === false) {
        throw new functions.https.HttpsError(
          "failed-precondition",
          `Notifications for '${type}' are disabled in the app — enable them first.`
        );
      }

      const accessToken = expoAccessToken.value()?.trim();
      if (!accessToken) {
        console.error("EXPO_ACCESS_TOKEN secret is empty");
        throw new functions.https.HttpsError(
          "failed-precondition",
          "Server is missing Expo push credentials (EXPO_ACCESS_TOKEN)."
        );
      }

      const notificationId = `test_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
      const createdAt = Date.now();

      const copy: Record<NotificationPrefCategory, { title: string; body: string }> = {
        new_route: {
          title: "New route (test)",
          body: "If you see this, server→Expo→FCM delivery is working.",
        },
        practice_reminder: {
          title: "Practice reminder (test)",
          body: "If you see this, server→Expo→FCM delivery is working.",
        },
        app_update: {
          title: "App update (test)",
          body: "If you see this, server→Expo→FCM delivery is working.",
        },
      };

      const { title, body } = copy[type];
      const result = await postExpoPushMessage({
        accessToken,
        to: token.trim(),
        title,
        body,
        data: {
          type,
          notificationId,
          createdAt,
          read: false,
        },
      });

      if (!result.ok) {
        console.error("Expo push failed", result.detail);
        throw new functions.https.HttpsError(
          "internal",
          `Expo Push API error: ${result.detail}`
        );
      }

      return {
        success: true,
        message: "Test notification queued. Check the tray within a few seconds.",
        notificationId,
      };
    } catch (error: unknown) {
      if (error instanceof functions.https.HttpsError) throw error;
      console.error("sendTestPushNotification error:", error);
      throw new functions.https.HttpsError(
        "internal",
        "Could not send test notification."
      );
    }
  }
);

const validatePaymentRequest = (
  request: functions.https.CallableRequest,
  userId: unknown,
  planType: unknown,
  amount: unknown
) => {
  if (!request.auth || request.auth.uid !== userId) {
    throw new functions.https.HttpsError(
      "unauthenticated",
      "Authentication required. Please login before purchasing."
    );
  }

  if (typeof planType !== "string" || !VALID_PLANS[planType]) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "Invalid plan type. Only 'weekly' and 'monthly' are allowed."
    );
  }

  const planConfig = VALID_PLANS[planType];
  const numAmount = Number(amount);
  if (!Number.isFinite(numAmount) || numAmount !== planConfig.amount) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      `Invalid amount for ${planType} plan.`
    );
  }

  return { planType, planConfig, numAmount };
};

/**
 * Create a Razorpay order before opening checkout.
 * The returned order_id is required for Razorpay signature verification.
 */
export const createRazorpayOrder = functions.https.onCall(callableOptions, async (request) => {
  try {
    const { userId, planType, amount } = request.data;
    const { planConfig, numAmount } = validatePaymentRequest(request, userId, planType, amount);

    const creds = getRazorpayCredentials();
    if (!creds) {
      console.error("Razorpay credentials are not configured (RAZORPAY_KEY_ID + RAZORPAY_SECRET)");
      throw new functions.https.HttpsError(
        "internal",
        "Server configuration error. Please contact support."
      );
    }

    const response = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${creds.keyId}:${creds.secret}`).toString("base64")}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        amount: Math.round(numAmount * 100),
        currency: planConfig.currency,
        receipt: `${userId}_${planType}_${Date.now()}`,
        notes: {
          userId,
          planType
        }
      })
    });

    const order = await response.json() as { id?: string; amount?: number; currency?: string; error?: { description?: string } };
    if (!response.ok || !order.id || !order.amount || !order.currency) {
      console.error("Razorpay order creation failed", {
        status: response.status,
        error: order.error?.description
      });
      throw new functions.https.HttpsError(
        "internal",
        "Could not create payment order. Please try again."
      );
    }

    return {
      success: true,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency
    };
  } catch (error: any) {
    console.error("Create Razorpay order error:", error.message || error);

    if (error instanceof functions.https.HttpsError) {
      throw error;
    }

    throw new functions.https.HttpsError(
      "internal",
      "Could not create payment order. Please try again."
    );
  }
});

/**
 * Verify Razorpay payment and activate subscription.
 * Expects { razorpay_order_id, razorpay_payment_id, razorpay_signature, userId, planType, amount }
 * 
 * SECURITY:
 * - Verifies HMAC SHA256 signature
 * - Checks for duplicate payments
 * - Validates plan type and amount
 * - Only authenticated users
 * - Server-side subscription creation (admin SDK)
 */
export const verifyRazorpayPayment = functions.https.onCall(callableOptions, async (request) => {
  try {
    const data = request.data;
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, userId, planType, amount } = data;

    // 1. AUTHENTICATION CHECK
    // 2. PARAMETER VALIDATION
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !userId || !planType || amount === undefined) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "Missing required payment parameters."
      );
    }

    // Validate types
    if (typeof razorpay_order_id !== "string" || typeof razorpay_payment_id !== "string" || typeof razorpay_signature !== "string") {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "Invalid parameter types."
      );
    }

    if (!razorpay_order_id.trim() || !razorpay_payment_id.trim() || !razorpay_signature.trim()) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "Payment parameters cannot be empty."
      );
    }

    // 3. VALIDATE AUTH, PLAN, AND AMOUNT
    const { planConfig, numAmount } = validatePaymentRequest(request, userId, planType, amount);

    // 4. DUPLICATE PAYMENT PROTECTION
    const db = admin.firestore();
    const existingPayment = await db
      .collection("subscriptions")
      .where("paymentId", "==", razorpay_payment_id)
      .limit(1)
      .get();

    if (!existingPayment.empty) {
      console.warn("Duplicate payment attempt detected", { paymentId: razorpay_payment_id, userId });
      throw new functions.https.HttpsError(
        "already-exists",
        "This payment has already been processed."
      );
    }

    // 5. SIGNATURE VERIFICATION (HMAC SHA256)
    const creds = getRazorpayCredentials();
    if (!creds) {
      console.error("Razorpay credentials are not configured for verification");
      throw new functions.https.HttpsError(
        "internal",
        "Server configuration error. Please contact support."
      );
    }

    const text = razorpay_order_id + "|" + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac("sha256", creds.secret)
      .update(text)
      .digest("hex");

    const expectedBuffer = Buffer.from(expectedSignature, "hex");
    const providedBuffer = Buffer.from(razorpay_signature, "hex");
    const signatureMatches =
      expectedBuffer.length === providedBuffer.length &&
      crypto.timingSafeEqual(expectedBuffer, providedBuffer);

    if (!signatureMatches) {
      console.warn("Invalid Razorpay signature", {
        paymentId: razorpay_payment_id,
        userId
      });
      throw new functions.https.HttpsError(
        "permission-denied",
        "Payment signature verification failed. This payment cannot be processed."
      );
    }

    // 6. CREATE VERIFIED SUBSCRIPTION (Server-only)
    const now = Date.now();
    const expiryDate = now + planConfig.durationDays * 24 * 60 * 60 * 1000;

    const subscriptionData = {
      userId,
      paymentId: razorpay_payment_id,
      orderId: razorpay_order_id,
      verified: true,
      status: "active",
      planType,
      amount: numAmount,
      createdAt: now,
      expiryDate,
      platform: "razorpay",
      autoRenew: false
    };

    const docRef = await db.collection("subscriptions").add(subscriptionData);

    console.info(`Subscription created successfully`, {
      subscriptionId: docRef.id,
      userId,
      planType,
      expiryDate
    });

    return {
      success: true,
      subscriptionId: docRef.id,
      message: "Subscription activated successfully. Premium access is now active."
    };
  } catch (error: any) {
    console.error("Payment verification error:", error.message || error);

    // Pass through HttpsError
    if (error instanceof functions.https.HttpsError) {
      throw error;
    }

    // Generic error (should not happen if properly caught above)
    throw new functions.https.HttpsError(
      "internal",
      "Payment verification failed. Please try again or contact support."
    );
  }
});