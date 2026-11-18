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
     
## Request / response

Accepts POST multipart/form-data with a Firebase ID token in the Authorization Bearer header and fields `file` and `courseId`. Verifies the Firebase token, then checks the Firestore user is an approved admin or instructor. Instructors can upload only to courses whose `createdBy` equals their UID. Maximum file size is 50 MB.

The response preserves the existing browser contract: `success`, `mediaUrl`, `fileId`, `bucketId`, `fileName`, and `contentType`.

Files are created with public read permission, matching the existing public-URL media behavior used by the current Supabase uploader. This means the media URL itself is not an additional paid-course access gate; course access must continue to be enforced by Mobile Tech Room's existing course/enrollment UI and rules. Do not treat an unguessable URL as authorization.

## Important

Do not change the website upload URL until this function is deployed, its environment variables are set, a real test upload succeeds, and the resulting file can be viewed by an approved student account. Do not change the PayChangu function.
