# Mobile Tech Room — PayChangu Function

This is the separate Appwrite Function for PayChangu Standard Checkout. It does not modify the lesson-upload function.

## Appwrite configuration

- Runtime: Node.js 24
- Root directory: `appwrite-functions/paychangu-payments`
- Entrypoint: `src/main.js`
- Build command: `npm install && npm run build`
- Execute access: Public HTTP endpoint (the handler authenticates checkout requests with Firebase ID tokens and validates PayChangu webhook signatures).

## Required Appwrite environment variables

- `PAYCHANGU_SECRET_KEY` — secret PayChangu API key.
- `FIREBASE_SERVICE_ACCOUNT_JSON` — the complete Firebase service-account JSON, stored only as a secret variable. Never commit this value to GitHub or put it in the website.

## Routes

- POST `/` with Authorization: Bearer <Firebase ID token> and JSON `{"action":"create-checkout","courseId":"..." }`
- POST `/?action=webhook` — configure this URL in PayChangu Settings → API & Webhooks.

The checkout price is read from Firestore `courses/{courseId}.price`; the client cannot set the amount. The student must have an approved profile. A successful webhook is HMAC-verified and the transaction is re-queried with PayChangu before creating `users/{uid}/enrollments/{courseId}`.

## Important

Do not activate real payments until the Firebase service account variable is configured, the Appwrite deployment is tested, and the PayChangu webhook URL is saved. Test with PayChangu test credentials first if available.
