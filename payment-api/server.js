/**
 * Standalone payment API for Railway / Render.
 * Replaces Firebase callable functions: createRazorpayOrder, verifyRazorpayPayment.
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const Razorpay = require('razorpay');
const admin = require('firebase-admin');

const VALID_PLANS = {
  weekly: { durationDays: 7, amount: 2.99, currency: 'GBP' },
  monthly: { durationDays: 30, amount: 8.99, currency: 'GBP' },
};

const getRazorpayCredentials = () => {
  const keyId = process.env.RAZORPAY_KEY_ID?.trim();
  const secret =
    process.env.RAZORPAY_SECRET?.trim() || process.env.RAZORPAY_KEY_SECRET?.trim();
  if (!keyId || !secret) return null;
  return { keyId, secret };
};

function validatePaymentRequest(authUid, userId, planType, amount) {
  if (!authUid || authUid !== userId) {
    const e = new Error('Authentication required. Please login before purchasing.');
    e.code = 'unauthenticated';
    throw e;
  }

  if (typeof planType !== 'string' || !VALID_PLANS[planType]) {
    const e = new Error("Invalid plan type. Only 'weekly' and 'monthly' are allowed.");
    e.code = 'invalid-argument';
    throw e;
  }

  const planConfig = VALID_PLANS[planType];
  const numAmount = Number(amount);
  if (!Number.isFinite(numAmount) || numAmount !== planConfig.amount) {
    const e = new Error(`Invalid amount for ${planType} plan.`);
    e.code = 'invalid-argument';
    throw e;
  }

  return { planType, planConfig, numAmount };
}

function httpStatusForCode(code) {
  switch (code) {
    case 'unauthenticated':
      return 401;
    case 'invalid-argument':
      return 400;
    case 'permission-denied':
      return 403;
    case 'already-exists':
      return 409;
    default:
      return 500;
  }
}

function sendError(res, code, message) {
  const status = httpStatusForCode(code);
  res.status(status).json({ error: { code, message } });
}

const DOMAIN_ERROR_CODES = new Set([
  'unauthenticated',
  'invalid-argument',
  'permission-denied',
  'already-exists',
]);

function isDomainError(err) {
  return err && DOMAIN_ERROR_CODES.has(err.code);
}

function initFirebaseAdmin() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
  if (!raw) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is required');
  }
  const credentials = JSON.parse(raw);
  admin.initializeApp({
    credential: admin.credential.cert(credentials),
  });
}

function parseCorsOrigins() {
  const raw = process.env.CORS_ORIGINS?.trim();
  if (!raw) return true;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

async function authenticateFirebase(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  if (!token) {
    return sendError(res, 'unauthenticated', 'Missing Authorization Bearer token');
  }
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.authUid = decoded.uid;
    next();
  } catch (err) {
    console.warn('verifyIdToken failed', err.message);
    return sendError(res, 'unauthenticated', 'Invalid or expired token');
  }
}

initFirebaseAdmin();

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(
  cors({
    origin: parseCorsOrigins(),
    credentials: true,
  })
);
app.use(express.json({ limit: '256kb' }));

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

/**
 * POST /api/payments/create-order
 * Body: { userId, planType: 'weekly' | 'monthly', amount }
 */
app.post('/api/payments/create-order', authenticateFirebase, async (req, res) => {
  try {
    const { userId, planType, amount } = req.body || {};
    const { planConfig, numAmount } = validatePaymentRequest(
      req.authUid,
      userId,
      planType,
      amount
    );

    const creds = getRazorpayCredentials();
    if (!creds) {
      console.error('Razorpay credentials missing (RAZORPAY_KEY_ID + RAZORPAY_SECRET)');
      return sendError(res, 'internal', 'Server configuration error. Please contact support.');
    }

    const razorpay = new Razorpay({
      key_id: creds.keyId,
      key_secret: creds.secret,
    });

    const order = await razorpay.orders.create({
      amount: Math.round(numAmount * 100),
      currency: planConfig.currency,
      receipt: `${userId}_${planType}_${Date.now()}`,
      notes: { userId, planType },
    });

    if (!order?.id || order.amount == null || !order.currency) {
      console.error('Razorpay order creation returned unexpected payload', order);
      return sendError(res, 'internal', 'Could not create payment order. Please try again.');
    }

    return res.json({
      success: true,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
    });
  } catch (err) {
    if (isDomainError(err)) {
      return sendError(res, err.code, err.message);
    }
    console.error('Create Razorpay order error:', err.message || err);
    return sendError(res, 'internal', 'Could not create payment order. Please try again.');
  }
});

/**
 * POST /api/payments/verify
 * Body: { razorpay_order_id, razorpay_payment_id, razorpay_signature, userId, planType, amount }
 */
app.post('/api/payments/verify', authenticateFirebase, async (req, res) => {
  try {
    const data = req.body || {};
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      userId,
      planType,
      amount,
    } = data;

    if (
      !razorpay_order_id ||
      !razorpay_payment_id ||
      !razorpay_signature ||
      !userId ||
      !planType ||
      amount === undefined
    ) {
      return sendError(res, 'invalid-argument', 'Missing required payment parameters.');
    }

    if (
      typeof razorpay_order_id !== 'string' ||
      typeof razorpay_payment_id !== 'string' ||
      typeof razorpay_signature !== 'string'
    ) {
      return sendError(res, 'invalid-argument', 'Invalid parameter types.');
    }

    if (
      !razorpay_order_id.trim() ||
      !razorpay_payment_id.trim() ||
      !razorpay_signature.trim()
    ) {
      return sendError(res, 'invalid-argument', 'Payment parameters cannot be empty.');
    }

    const { planConfig, numAmount } = validatePaymentRequest(
      req.authUid,
      userId,
      planType,
      amount
    );

    const db = admin.firestore();
    const existingPayment = await db
      .collection('subscriptions')
      .where('paymentId', '==', razorpay_payment_id)
      .limit(1)
      .get();

    if (!existingPayment.empty) {
      console.warn('Duplicate payment attempt', { paymentId: razorpay_payment_id, userId });
      return sendError(res, 'already-exists', 'This payment has already been processed.');
    }

    const creds = getRazorpayCredentials();
    if (!creds) {
      console.error('Razorpay credentials missing for verification');
      return sendError(res, 'internal', 'Server configuration error. Please contact support.');
    }

    const text = razorpay_order_id + '|' + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac('sha256', creds.secret)
      .update(text)
      .digest('hex');

    const expectedBuffer = Buffer.from(expectedSignature, 'hex');
    const providedBuffer = Buffer.from(razorpay_signature, 'hex');
    const signatureMatches =
      expectedBuffer.length === providedBuffer.length &&
      crypto.timingSafeEqual(expectedBuffer, providedBuffer);

    if (!signatureMatches) {
      console.warn('Invalid Razorpay signature', { paymentId: razorpay_payment_id, userId });
      return sendError(
        res,
        'permission-denied',
        'Payment signature verification failed. This payment cannot be processed.'
      );
    }

    const now = Date.now();
    const expiryDate = now + planConfig.durationDays * 24 * 60 * 60 * 1000;

    const subscriptionData = {
      userId,
      paymentId: razorpay_payment_id,
      orderId: razorpay_order_id,
      verified: true,
      status: 'active',
      planType,
      amount: numAmount,
      createdAt: now,
      expiryDate,
      platform: 'razorpay',
    };

    const docRef = await db.collection('subscriptions').add(subscriptionData);

    console.info('Subscription created', {
      subscriptionId: docRef.id,
      userId,
      planType,
      expiryDate,
    });

    return res.json({
      success: true,
      subscriptionId: docRef.id,
      message: 'Subscription activated successfully. Premium access is now active.',
    });
  } catch (err) {
    if (isDomainError(err)) {
      return sendError(res, err.code, err.message);
    }
    console.error('Payment verification error:', err.message || err);
    return sendError(
      res,
      'internal',
      'Payment verification failed. Please try again or contact support.'
    );
  }
});

app.use((_req, res) => {
  res.status(404).json({ error: { code: 'not-found', message: 'Route not found' } });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Payment API listening on port ${PORT}`);
});
