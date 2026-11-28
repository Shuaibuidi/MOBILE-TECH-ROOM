# Mobile Tech Room — Appwrite lesson upload

This is the source folder for the existing Appwrite Function `secure-lesson-upload`. It must not replace or modify `appwrite-functions/paychangu-payments`.

## Function configuration

Configure the existing Appwrite function as follows:

- Runtime: Node.js 24
- Root directory: `appwrite-functions/secure-lesson-upload`
- Build command: `npm install && npm run build`
- Entrypoint: `index.js`
- Function timeout: `60` seconds for synchronous HTTP upload tests (Appwrite documents a 60-second limit for synchronous function-domain requests).

The `index.js` file in this folder is the entrypoint wrapper and loads `src/main.js`. The root directory must point to this folder; otherwise Appwrite will search the repository root and fail to find `index.js`.

## Required function variables

Set these in the Appwrite Function's Variables tab. Never put the API key or Firebase service account JSON in the website or commit them to GitHub.

- `APPWRITE_ENDPOINT`: `https://sgp.cloud.appwrite.io/v1`
- `APPWRITE_PROJECT_ID`: the Mobile Tech Room Appwrite project ID
- `APPWRITE_API_KEY`: a server-side Appwrite API key with Storage files read and write permissions for the target project
- `APPWRITE_BUCKET_ID`: the existing Lesson Media bucket ID
- `FIREBASE_SERVICE_ACCOUNT_JSON`: the Firebase service-account JSON used by the trusted server function

The server-side Appwrite API key must have permission to read files in the Lesson Media bucket. Keep this key only in Appwrite Function variables; never add it to the website.

## Request / response

Accepts POST multipart/form-data with a Firebase ID token in the Authorization Bearer header and fields `file` and `courseId`. Verifies the Firebase token, then checks the Firestore user is an approved admin or instructor. Instructors can upload only to courses whose `createdBy` equals their UID. Maximum file size is 50 MB. It also accepts GET requests with `courseId` and `fileId`, verifies approved user/course access (including active enrollment for paid courses), and streams the private file bytes through the authenticated function without issuing a file token or reusable file URL.

The response preserves the existing browser contract: `success`, `mediaUrl`, `fileId`, `bucketId`, `fileName`, and `contentType`.

Uploads are created with private file permissions (`permissions: []`). The website sends the signed-in Firebase ID token to this function. The function checks account approval, lesson/course association, instructor ownership and active paid-course enrollment before streaming the file bytes. The browser receives an in-memory Blob URL, not an Appwrite token URL. Do not enable public read permissions on the bucket or its files.

## S I A Business website bridge

The existing function also exposes two additional POST actions. This reuses the current function slot; do not create another Appwrite Function.

Add this additional server-side Function variable in Appwrite:

- `SIA_BUSINESS_SERVICE_ACCOUNT_JSON`: the service-account JSON for Firebase project `smart-business-manager-f319f`.

Keep the existing `FIREBASE_SERVICE_ACCOUNT_JSON` variable for the `mobile-tech-room` Firebase project. Both values must be added privately in the Appwrite Function Variables tab. Never commit either JSON value to GitHub or place it in browser code.

Routes:

- `POST /?action=sia-sync-stock`: accepts the signed-in Smart Business Manager administrator's Firebase ID token and a stock item ID, name, quantity, selling price, low-stock threshold and active flag. It writes only public catalogue fields to `mobile-tech-room/catalogueItems`; it does not publish buying price, internal quantity reports, expenses, salaries or profits.
- `POST /?action=sia-confirm-order`: accepts an approved website administrator's Firebase ID token and a website order ID. It verifies the order and linked catalogue item, decrements the original S I A Business stock document, and creates an idempotent `website-order-{orderId}` sales transaction including cost and profit. It then updates the website order and public availability.

The bridge uses the existing S I A Business ID `7RqIYO3IDSVCYex1LsDo6rDw5V33`. It publishes items from the `stock` collection only; it does not publish the separate `spareParts` collection.

## Important

Deploy this using the existing `secure-lesson-upload` function; do not create a second function. Ensure the server-side Appwrite API key has the `files.read` and `files.write` permissions required for private file retrieval and uploads. The new media path no longer needs `tokens.write`. Do not change the PayChangu function or website upload URL.
