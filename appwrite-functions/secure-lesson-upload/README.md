# Mobile Tech Room — Appwrite lesson upload

This is a separate Appwrite Function source folder for lesson media uploads. It must be deployed as its own function and must not replace or modify `appwrite-functions/paychangu-payments`.

## Function configuration

- Runtime: Node.js 24
- Root directory: `appwrite-functions/secure-lesson-upload`
- Build command: `npm install && npm run build`
- Entrypoint: `src/main.js`

## Required function variables

Set these in the Appwrite Function's Variables tab. Never put the API key or Firebase service account JSON in the website or commit them to GitHub.

- `APPWRITE_ENDPOINT`: `https://sgp.cloud.appwrite.io/v1`
- `APPWRITE_PROJECT_ID`: the Mobile Tech Room Appwrite project ID
- `APPWRITE_API_KEY`: a server-side Appwrite API key with Storage files write permission for the target project
- `APPWRITE_BUCKET_ID`: the existing Lesson Media bucket ID
- `FIREBASE_SERVICE_ACCOUNT_JSON`: the Firebase service-account JSON used by the trusted server function

In the Appwrite Function **Scopes** settings, enable `tokens.write` so the function can create temporary file tokens. The function uses Appwrite's per-execution key for this operation; do not add that key to the website.
     
## Request / response

Accepts POST multipart/form-data with a Firebase ID token in the Authorization Bearer header and fields `file` and `courseId`. Verifies the Firebase token, then checks the Firestore user is an approved admin or instructor. Instructors can upload only to courses whose `createdBy` equals their UID. Maximum file size is 50 MB. It also accepts GET requests with `courseId` and `fileId`, verifies approved user/course access (including active enrollment for paid courses), and returns a one-hour Appwrite file-token URL for lesson playback.

The response preserves the existing browser contract: `success`, `mediaUrl`, `fileId`, `bucketId`, `fileName`, and `contentType`.

For the first migration test, files are still created with public read permission to preserve the current behavior. After the website requests the temporary media URL successfully and authorized student playback is verified, the upload function can be changed to create private files. Do not switch to private files before that end-to-end test.

## Important

Deploy this as the existing `secure-lesson-upload` function; do not create a second function. Configure the variables and `tokens.write` scope, then test upload and media authorization. Do not change the PayChangu function or website upload URL until the tests pass.
