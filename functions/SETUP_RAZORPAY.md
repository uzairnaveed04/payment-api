# Razorpay + Firebase Functions (test / live)

The app already calls two HTTPS callable functions:

- `createRazorpayOrder` — creates a Razorpay order (server-side, uses **Key ID + Secret**).
- `verifyRazorpayPayment` — verifies the payment signature and writes an **`verified: true`** subscription in Firestore.

## 1. Mobile app (publishable key only)

In `mobile/`, create `.env` (never commit; `.gitignore` excludes it):

```bash
EXPO_PUBLIC_RAZORPAY_KEY_ID=rzp_test_xxxxxxxx
```

Use the **Key ID** from Razorpay Dashboard → API Keys.  
Do **not** put the Key Secret in the app.

Rebuild / reload Metro after changing env. For EAS builds, set `EXPO_PUBLIC_RAZORPAY_KEY_ID` in EAS secrets or env.

## 2. Cloud Functions (Key ID + Secret)

In `backend/functions/`, copy the example file:

```bash
cp .env.example .env
```

Edit `.env`:

```bash
RAZORPAY_KEY_ID=rzp_test_xxxxxxxx
RAZORPAY_SECRET=your_key_secret_from_dashboard
```

Alternatively you may use `RAZORPAY_KEY_SECRET` instead of `RAZORPAY_SECRET` (same value).

Firebase Functions **v2** loads `.env` from this folder when you **deploy** and when you run the **emulator**.

## 3. Local emulator

From `backend/functions`:

```bash
npm run serve
```

Ensure `mobile` has `EXPO_PUBLIC_USE_FUNCTIONS_EMULATOR=true` and emulator host/port matching `firebase.json`.

## 4. Production deploy

From `backend/functions`:

```bash
npm run build
firebase deploy --only functions
```

Deploy Firestore indexes (required for subscription queries):

```bash
cd backend
firebase deploy --only firestore:indexes
```

## 5. Security

- If a **Key Secret** was ever pasted into chat, email, or a ticket, **rotate** it in Razorpay Dashboard and update `.env` / deployment env only.

## 6. Currency note

Orders use **GBP** and amounts **£2.99 / £8.99** (see `VALID_PLANS` in `src/index.ts`).  
If Razorpay rejects the currency for your account, enable **GBP** on the Razorpay side or adjust plans/currency in code consistently with the mobile `PREMIUM_PLANS` prices.
