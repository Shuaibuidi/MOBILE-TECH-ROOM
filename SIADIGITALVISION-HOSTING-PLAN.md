# Hosting and shared-login architecture for siadigitalvision.com

## Decision: keep Mobile Tech Room's current live URL intact

The existing Mobile Tech Room app is served from the repository root at:

`https://shuaibuidi.github.io/MOBILE-TECH-ROOM/`

The Android Capacitor configuration also points to that exact URL. The current `index.html` is the full learning application (approximately 335 KB) and contains the Firebase Auth and Firestore client setup. It uses no separate local image, script, or stylesheet files in its HTML entry point; most dependencies are loaded from hosted CDNs or remote services.

Replacing the root `index.html` with a marketing homepage would therefore break the current Mobile Tech Room web URL. It could also break the installed Android app until its remote URL was updated and a replacement APK was built and tested.

## Safer hosting arrangement

Host the new public website as a separate GitHub Pages site/repository attached to `www.siadigitalvision.com`. Keep the existing `Shuaibuidi/MOBILE-TECH-ROOM` repository and GitHub Pages URL dedicated to the learning app during the integration and testing period.

The new site can link to Mobile Tech Room and S I A Tech Print Media. A later unified sign-in can use the existing `mobile-tech-room` Firebase Authentication project, subject to authorized-domain configuration and browser/Android session testing.

## Shared login technical notes

- Both web applications must initialize the same Firebase project and use compatible Firebase Auth settings.
- Add the new website's real production hostname to Firebase Authentication's authorized domains when the domain is ready.
- Authentication state may be shared by the same browser profile when the same Firebase project and persistence are used, but do not promise a universal cross-browser or cross-device session.
- Android currently loads the Mobile Tech Room GitHub Pages URL remotely. Keep this unchanged until a new Android build is explicitly tested.
- Do not copy service-account credentials or private API secrets into browser code.

## Work completed

- Created a landing page draft in `siadigitalvision.html` on the integration branch.
- Documented the existing Mobile Tech Room Firebase collections and security constraints.
- Reviewed the Firestore rules supplied by the owner.
- No changes have been made to the live `main` branch, Firebase rules, production domain DNS, or Android remote URL.

## Next prerequisites

1. Confirm the domain `siadigitalvision.com` is registered and the owner can edit its DNS records.
2. Create a separate GitHub repository for the public website (for example, `SIADIGITALVISION-WEBSITE`) and enable GitHub Pages.
3. Attach the custom domain to that new Pages site and verify HTTPS.
4. Add the verified website hostname to Firebase Authentication authorized domains.
5. Implement and test sign-in on the website without changing existing Mobile Tech Room authentication flows.
6. Only after successful testing, plan the Android app's entry point and navigation changes.
