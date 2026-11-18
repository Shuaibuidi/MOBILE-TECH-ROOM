# Mobile Tech Room — PayChangu Function

This is the separate Appwrite Function for PayChangu Standard Checkout. It does not modify the lesson-upload function.

## Appwrite configuration

- Runtime: Node.js 24
- Root directory: `appwrite-functions/paychangu-payments`
- Entrypoint: `src/main.js`
- Build command: `npm install && npm run build`
- Execute access: Public HTTP endpoint (the handler authenticates checkout requests with Firebase ID tokens and validates PayChangu webhook signatures).

## Required Appwrite environment variables

- `PAYCHANGU_SECRET_KEY` — secret PayChangu API key, used for checkout and transaction verification.
- `PAYCHANGU_WEBHOOK_SECRET` — the separate webhook secret generated in PayChangu Dashboard → Settings → API & Webhooks. Do not use the API secret for webhook signatures.
- `FIREBASE_SERVICE_ACCOUNT_JSON` — the complete Firebase service-account JSON, stored only as a secret variable. Never commit this value to GitHub or put it in the website.

## Routes

- POST `/` with Authorization: Bearer <Firebase ID token> and JSON `{"action":"create-checkout","courseId":"..." }`
- POST `/?action=webhook` — configure this URL in PayChangu Settings → API & Webhooks.
- POST `/` with JSON `{"action":"verify-payment-return","firebaseIdToken":"...","tx_ref":"...","returnStatus":"failed"}` — authenticated browser callback/return verification; the server verifies the transaction before updating Firestore.

The checkout price is read from Firestore `courses/{courseId}.price`; the client cannot set the amount. The student must have an approved profile. A webhook is HMAC-verified with the separate webhook secret and the transaction is re-queried with PayChangu before creating `users/{uid}/enrollments/{courseId}`.

Failed-attempt webhooks are recorded without closing checkout, because PayChangu allows customers to retry. A terminal failed/cancelled return is only recorded after the authenticated return handler re-queries PayChangu. Successful browser returns and webhooks share the same idempotent Firestore transaction, so either route can safely activate access.

## Important

Do not activate real payments until the Firebase service account variable is configured, the Appwrite deployment is tested, and the PayChangu webhook URL is saved. Test with PayChangu test credentials first if available.
