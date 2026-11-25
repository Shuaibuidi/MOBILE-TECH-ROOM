# siadigitalvision.com integration notes

## Safety baseline

- The existing `main` branch and the deployed Mobile Tech Room application remain unchanged.
- Integration work is isolated on `integration/siadigitalvision-shell`.
- The existing Firebase project remains `mobile-tech-room`.
- Existing Mobile Tech Room Firebase Authentication accounts and Firestore records must be preserved.
- Do not replace Firestore rules with public or catch-all access rules.

## Existing identity and data

The current Mobile Tech Room web app initializes Firebase Authentication and Cloud Firestore using the `mobile-tech-room` project. It stores member profiles at `users/{uid}`, courses and nested lessons at `courses/{courseId}`, and community messages at `supportMessages/{messageId}`. Student enrolments and support read-state are nested beneath user profiles.

The app also relies on external Appwrite/Supabase functions for selected workflows, including payment and learning progress. These integrations must be retained unless separately migrated and tested.

## Shared-account direction

Use the existing `mobile-tech-room` Firebase Authentication project as the initial identity provider for the platform. A single sign-in can be shared across the website and Android experience when both use the same Firebase project and compatible authentication persistence/origin configuration.

Do not create a second Firebase Auth project or migrate user accounts as part of the initial landing-page work.

## Data security plan

The supplied Firestore rules currently authorize only the explicitly matched paths. New platform/business collections will be denied by default until their document schema, ownership model, and role permissions are designed and reviewed.

Before adding business records, define:
- owner/admin identity and business membership model;
- which records are private to the owner, staff, or customers;
- read/write rules per collection;
- whether business data belongs in this Firebase project or a separately isolated database.

Never use a broad `allow read, write: if request.auth != null` rule for all documents.

## First UI draft

`siadigitalvision.html` is a standalone landing-page draft linking to the existing Mobile Tech Room URL and the S I A Tech Print Media WhatsApp contact. It is not wired into the live root page and is not deployed. It is a safe visual starting point only.

## Required tests before publishing

1. Existing Mobile Tech Room student, instructor, and admin logins.
2. Existing approval and role restrictions.
3. Course and lesson create/read/update/delete behavior.
4. Existing paid-course enrolment and payment callbacks.
5. Existing media uploads and lesson resources.
6. Shared sign-in and sign-out across the website and Android app.
7. Business-data access isolation for owner, staff, and customer roles.
8. Mobile layout and navigation on Android Chrome.
