"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyRazorpayPayment = exports.createRazorpayOrder = void 0;
var functions = require("firebase-functions/v2");
var admin = require("firebase-admin");
var crypto = require("crypto");
admin.initializeApp();
// Valid plan configurations
var VALID_PLANS = {
    weekly: { durationDays: 7, amount: 2.99, currency: "GBP" },
    monthly: { durationDays: 30, amount: 8.99, currency: "GBP" }
};
var validatePaymentRequest = function (request, userId, planType, amount) {
    if (!request.auth || request.auth.uid !== userId) {
        throw new functions.https.HttpsError("unauthenticated", "Authentication required. Please login before purchasing.");
    }
    if (typeof planType !== "string" || !VALID_PLANS[planType]) {
        throw new functions.https.HttpsError("invalid-argument", "Invalid plan type. Only 'weekly' and 'monthly' are allowed.");
    }
    var planConfig = VALID_PLANS[planType];
    var numAmount = Number(amount);
    if (!Number.isFinite(numAmount) || numAmount !== planConfig.amount) {
        throw new functions.https.HttpsError("invalid-argument", "Invalid amount for ".concat(planType, " plan."));
    }
    return { planType: planType, planConfig: planConfig, numAmount: numAmount };
};
/**
 * Create a Razorpay order before opening checkout.
 * The returned order_id is required for Razorpay signature verification.
 */
exports.createRazorpayOrder = functions.https.onCall(function (request) { return __awaiter(void 0, void 0, void 0, function () {
    var _a, userId, planType, amount, _b, planConfig, numAmount, razorpayKeyId, razorpaySecret, response, order, error_1;
    var _c;
    return __generator(this, function (_d) {
        switch (_d.label) {
            case 0:
                _d.trys.push([0, 3, , 4]);
                _a = request.data, userId = _a.userId, planType = _a.planType, amount = _a.amount;
                _b = validatePaymentRequest(request, userId, planType, amount), planConfig = _b.planConfig, numAmount = _b.numAmount;
                razorpayKeyId = process.env.RAZORPAY_KEY_ID;
                razorpaySecret = process.env.RAZORPAY_SECRET;
                if (!razorpayKeyId || !razorpaySecret) {
                    console.error("Razorpay credentials are not configured");
                    throw new functions.https.HttpsError("internal", "Server configuration error. Please contact support.");
                }
                return [4 /*yield*/, fetch("https://api.razorpay.com/v1/orders", {
                        method: "POST",
                        headers: {
                            Authorization: "Basic ".concat(Buffer.from("".concat(razorpayKeyId, ":").concat(razorpaySecret)).toString("base64")),
                            "Content-Type": "application/json"
                        },
                        body: JSON.stringify({
                            amount: Math.round(numAmount * 100),
                            currency: planConfig.currency,
                            receipt: "".concat(userId, "_").concat(planType, "_").concat(Date.now()),
                            notes: {
                                userId: userId,
                                planType: planType
                            }
                        })
                    })];
            case 1:
                response = _d.sent();
                return [4 /*yield*/, response.json()];
            case 2:
                order = _d.sent();
                if (!response.ok || !order.id || !order.amount || !order.currency) {
                    console.error("Razorpay order creation failed", {
                        status: response.status,
                        error: (_c = order.error) === null || _c === void 0 ? void 0 : _c.description
                    });
                    throw new functions.https.HttpsError("internal", "Could not create payment order. Please try again.");
                }
                return [2 /*return*/, {
                        success: true,
                        orderId: order.id,
                        amount: order.amount,
                        currency: order.currency
                    }];
            case 3:
                error_1 = _d.sent();
                console.error("Create Razorpay order error:", error_1.message || error_1);
                if (error_1 instanceof functions.https.HttpsError) {
                    throw error_1;
                }
                throw new functions.https.HttpsError("internal", "Could not create payment order. Please try again.");
            case 4: return [2 /*return*/];
        }
    });
}); });
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
exports.verifyRazorpayPayment = functions.https.onCall(function (request) { return __awaiter(void 0, void 0, void 0, function () {
    var data, razorpay_order_id, razorpay_payment_id, razorpay_signature, userId, planType, amount, _a, planConfig, numAmount, db, existingPayment, razorpaySecret, text, expectedSignature, expectedBuffer, providedBuffer, signatureMatches, now, expiryDate, subscriptionData, docRef, error_2;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0:
                _b.trys.push([0, 3, , 4]);
                data = request.data;
                razorpay_order_id = data.razorpay_order_id, razorpay_payment_id = data.razorpay_payment_id, razorpay_signature = data.razorpay_signature, userId = data.userId, planType = data.planType, amount = data.amount;
                // 1. AUTHENTICATION CHECK
                // 2. PARAMETER VALIDATION
                if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !userId || !planType || amount === undefined) {
                    throw new functions.https.HttpsError("invalid-argument", "Missing required payment parameters.");
                }
                // Validate types
                if (typeof razorpay_order_id !== "string" || typeof razorpay_payment_id !== "string" || typeof razorpay_signature !== "string") {
                    throw new functions.https.HttpsError("invalid-argument", "Invalid parameter types.");
                }
                if (!razorpay_order_id.trim() || !razorpay_payment_id.trim() || !razorpay_signature.trim()) {
                    throw new functions.https.HttpsError("invalid-argument", "Payment parameters cannot be empty.");
                }
                _a = validatePaymentRequest(request, userId, planType, amount), planConfig = _a.planConfig, numAmount = _a.numAmount;
                db = admin.firestore();
                return [4 /*yield*/, db
                        .collection("subscriptions")
                        .where("paymentId", "==", razorpay_payment_id)
                        .limit(1)
                        .get()];
            case 1:
                existingPayment = _b.sent();
                if (!existingPayment.empty) {
                    console.warn("Duplicate payment attempt detected", { paymentId: razorpay_payment_id, userId: userId });
                    throw new functions.https.HttpsError("already-exists", "This payment has already been processed.");
                }
                razorpaySecret = process.env.RAZORPAY_SECRET;
                if (!razorpaySecret) {
                    console.error("RAZORPAY_SECRET not configured in environment");
                    throw new functions.https.HttpsError("internal", "Server configuration error. Please contact support.");
                }
                text = razorpay_order_id + "|" + razorpay_payment_id;
                expectedSignature = crypto
                    .createHmac("sha256", razorpaySecret)
                    .update(text)
                    .digest("hex");
                expectedBuffer = Buffer.from(expectedSignature, "hex");
                providedBuffer = Buffer.from(razorpay_signature, "hex");
                signatureMatches = expectedBuffer.length === providedBuffer.length &&
                    crypto.timingSafeEqual(expectedBuffer, providedBuffer);
                if (!signatureMatches) {
                    console.warn("Invalid Razorpay signature", {
                        paymentId: razorpay_payment_id,
                        userId: userId
                    });
                    throw new functions.https.HttpsError("permission-denied", "Payment signature verification failed. This payment cannot be processed.");
                }
                now = Date.now();
                expiryDate = now + planConfig.durationDays * 24 * 60 * 60 * 1000;
                subscriptionData = {
                    userId: userId,
                    paymentId: razorpay_payment_id,
                    orderId: razorpay_order_id,
                    verified: true,
                    status: "active",
                    planType: planType,
                    amount: numAmount,
                    createdAt: now,
                    expiryDate: expiryDate,
                    platform: "razorpay"
                };
                return [4 /*yield*/, db.collection("subscriptions").add(subscriptionData)];
            case 2:
                docRef = _b.sent();
                console.info("Subscription created successfully", {
                    subscriptionId: docRef.id,
                    userId: userId,
                    planType: planType,
                    expiryDate: expiryDate
                });
                return [2 /*return*/, {
                        success: true,
                        subscriptionId: docRef.id,
                        message: "Subscription activated successfully. Premium access is now active."
                    }];
            case 3:
                error_2 = _b.sent();
                console.error("Payment verification error:", error_2.message || error_2);
                // Pass through HttpsError
                if (error_2 instanceof functions.https.HttpsError) {
                    throw error_2;
                }
                // Generic error (should not happen if properly caught above)
                throw new functions.https.HttpsError("internal", "Payment verification failed. Please try again or contact support.");
            case 4: return [2 /*return*/];
        }
    });
}); });
