import * as functions from "firebase-functions/v2";
import * as admin from "firebase-admin";
import * as crypto from "crypto";

admin.initializeApp();

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
    "http://127.0.0.1:8081"
  ]
};

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
      platform: "razorpay"
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