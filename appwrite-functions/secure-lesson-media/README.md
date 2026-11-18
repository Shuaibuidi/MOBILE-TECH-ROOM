# Secure Lesson Media Access

This is a separate Appwrite Function. It does not replace the upload function or the PayChangu payment function.

## What it does

- Accepts a Firebase ID token in the Authorization header.
- Verifies that the Firebase user profile exists and is approved.
- Confirms that the requested Appwrite file ID is actually referenced by a lesson in the supplied Firestore course.
- Allows approved administrators.
- Allows approved instructors only when they own the course.
- Allows approved students to access free-course files.
- For paid courses, requires `users/{uid}/enrollments/{courseId}` with `status: "active"`.
- Creates a one-hour Appwrite file token and returns a temporary view URL. The token URL supports normal browser media viewing and seeking without exposing the Appwrite API key.

## Environment variables

Configure these on this new function only:

- `APPWRITE_ENDPOINT`
- `APPWRITE_PROJECT_ID`
- `APPWRITE_API_KEY` (must have permission to create file tokens)
- `APPWRITE_BUCKET_ID`
- `FIREBASE_SERVICE_ACCOUNT_JSON` (the same private Firebase service account JSON already configured on the upload function)

Never place service account JSON or the Appwrite API key in the website.

## Request

`GET /?courseId=COURSE_ID&fileId=APPWRITE_FILE_ID`

Header:

`Authorization: Bearer FIREBASE_ID_TOKEN`

Success response contains `mediaUrl` and `expiresAt`. The website must request this URL after verifying the signed-in user and then use the returned temporary URL as the media source.

## Important migration notes

- Deploy this as a NEW Appwrite Function with entrypoint `src/main.js`, root directory `appwrite-functions/secure-lesson-media`, runtime Node.js 24.
- The existing uploader currently creates public-read files. Do not change that uploader until this function is deployed and tested.
- Once the new access flow is integrated and verified, update the uploader to create files without public-read permissions. Existing public files remain public until their permissions are changed separately.
- Do not change the PayChangu function.
