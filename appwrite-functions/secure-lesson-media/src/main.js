import admin from "firebase-admin";
import { Client, Tokens } from "node-appwrite";

const APP_ORIGIN = "https://shuaibuidi.github.io";
const TOKEN_LIFETIME_MS = 60 * 60 * 1000;

let firebaseReady = false;
function getFirebase() {
  if (!firebaseReady) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!raw) throw new Error("Missing FIREBASE_SERVICE_ACCOUNT_JSON.");
    const account = JSON.parse(raw);
    if (!admin.apps.length) {
      admin.initializeApp({ credential: admin.credential.cert(account) });
    }
    firebaseReady = true;
  }
  return { auth: admin.auth(), db: admin.firestore() };
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": APP_ORIGIN,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Vary": "Origin"
  };
}

function json(res, body, status = 200) {
  return res.json(body, status, {
    ...corsHeaders(),
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
}

function getBearer(req) {
  const value = req.headers?.authorization || "";
  return value.startsWith("Bearer ") ? value.slice(7).trim() : "";
}

function validId(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$/.test(value);
}

function fileIdFromMediaUrl(value) {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value);
    const match = url.pathname.match(/\/storage\/buckets\/[^/]+\/files\/([^/]+)\/(?:view|download)$/);
    return match ? decodeURIComponent(match[1]) : "";
  } catch {
    return "";
  }
}

export default async ({ req, res, log, error }) => {
  try {
    if (req.method === "OPTIONS") return res.text("", 204, corsHeaders());
    if (req.method !== "GET") return json(res, { success: false, error: "Use GET." }, 405);

    const token = getBearer(req);
    if (!token) return json(res, { success: false, error: "Please sign in to open this lesson file." }, 401);

    const fileId = String(req.query?.fileId || "").trim();
    const courseId = String(req.query?.courseId || "").trim();
    if (!validId(fileId) || !courseId || courseId.length > 150) {
      return json(res, { success: false, error: "The lesson file details are invalid." }, 400);
    }

    const { auth, db } = getFirebase();
    let decoded;
    try {
      decoded = await auth.verifyIdToken(token);
    } catch {
      return json(res, { success: false, error: "Your sign-in has expired. Please sign in again." }, 401);
    }

    const [userSnap, courseSnap, lessonSnap] = await Promise.all([
      db.collection("users").doc(decoded.uid).get(),
      db.collection("courses").doc(courseId).get(),
      db.collection("courses").doc(courseId).collection("lessons").get()
    ]);

    if (!userSnap.exists || !courseSnap.exists) {
      return json(res, { success: false, error: "The account or course could not be found." }, 404);
    }

    const user = userSnap.data() || {};
    const course = courseSnap.data() || {};
    if (user.status !== "approved" || !["admin", "instructor", "student"].includes(user.role)) {
      return json(res, { success: false, error: "Your account is not approved to view lesson files." }, 403);
    }

    const belongsToCourse = lessonSnap.docs.some(doc => fileIdFromMediaUrl(doc.data()?.mediaUrl) === fileId);
    if (!belongsToCourse) {
      return json(res, { success: false, error: "This file is not attached to a lesson in the selected course." }, 403);
    }

    if (user.role === "instructor" && course.createdBy !== decoded.uid) {
      return json(res, { success: false, error: "Instructors can access files only in their own courses." }, 403);
    }

    if (user.role === "student" && course.accessType === "paid") {
      const enrollment = await db.collection("users").doc(decoded.uid)
        .collection("enrollments").doc(courseId).get();
      if (!enrollment.exists || enrollment.data()?.status !== "active") {
        return json(res, { success: false, error: "This is a paid course. You do not currently have access." }, 403);
      }
    }

    const endpoint = process.env.APPWRITE_ENDPOINT;
    const projectId = process.env.APPWRITE_PROJECT_ID;
    const functionKey = req.headers?.["x-appwrite-key"];
    const bucketId = process.env.APPWRITE_BUCKET_ID;
    if (!endpoint || !projectId || !functionKey || !bucketId) {
      throw new Error("Appwrite media function configuration is incomplete.");
    }

    const client = new Client().setEndpoint(endpoint).setProject(projectId).setKey(functionKey);
    const tokens = new Tokens(client);
    const expire = new Date(Date.now() + TOKEN_LIFETIME_MS).toISOString();
    const fileToken = await tokens.createFileToken({ bucketId, fileId, expire });

    const mediaUrl = endpoint.replace(/\/$/, "") +
      "/storage/buckets/" + encodeURIComponent(bucketId) +
      "/files/" + encodeURIComponent(fileId) +
      "/view?project=" + encodeURIComponent(projectId) +
      "&token=" + encodeURIComponent(fileToken.secret);

    log("Authorized lesson media access for user " + decoded.uid + " and course " + courseId);
    return json(res, {
      success: true,
      mediaUrl,
      expiresAt: expire
    });
  } catch (e) {
    error(e?.stack || String(e));
    return json(res, {
      success: false,
      error: "The secure lesson media service encountered an error. Please try again."
    }, 500);
  }
};