import crypto from "node:crypto";
import admin from "firebase-admin";

const APP_URL = "https://shuaibuidi.github.io/MOBILE-TECH-ROOM/";
const APP_ORIGIN = new URL(APP_URL).origin;
const CURRENCY = "MWK";
const PAYCHANGU_PAYMENT_URL = "https://api.paychangu.com/payment";
const PAYCHANGU_VERIFY_URL = "https://api.paychangu.com/verify-payment/";

let firebaseReady = false;

function getFirebase() {
  if (!firebaseReady) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!raw) throw new Error("Missing FIREBASE_SERVICE_ACCOUNT_JSON environment variable.");
    const serviceAccount = JSON.parse(raw);
    if (!admin.apps.length) {
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    }
    firebaseReady = true;
  }
  return { auth: admin.auth(), db: admin.firestore() };
}

function corsHeaders(extra = {}) {
  return {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": APP_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Vary": "Origin",
    ...extra
  };
}

function json(res, body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: corsHeaders()
  });
}

function getBearer(req) {
  const value = req.headers?.authorization || req.headers?.Authorization || "";
  return value.startsWith("Bearer ") ? value.slice(7).trim() : "";
}

function safeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !/^[a-f0-9]{64}$/i.test(a) || !/^[a-f0-9]{64}$/i.test(b)) return false;
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function checkoutReply(req, res, body, status = 200) {
  const contentType = req.headers?.["content-type"] || "";
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[char]);
    const message = body.alreadyEnrolled
      ? "You already have access to this course."
      : (body.error || "Payment could not be started.");
    return res.text(
      `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mobile Tech Room payment</title></head><body style="font-family:Arial,sans-serif;padding:28px;line-height:1.5"><h2>Mobile Tech Room</h2><p>${escapeHtml(message)}</p><p><a href="${APP_URL}">Return to Mobile Tech Room</a></p></body></html>`,
      status,
      { "Content-Type": "text/html; charset=utf-8" }
    );
  }
  return json(res, body, status);
}

async function createCheckout({ req, res, log }) {
  let body = {};
  const contentType = req.headers?.["content-type"] || "";
  if (contentType.includes("application/x-www-form-urlencoded")) {
    body = Object.fromEntries(new URLSearchParams(req.bodyText || ""));
  } else {
    body = req.bodyJson || {};
    if (!Object.keys(body).length && req.bodyText) {
      try { body = JSON.parse(req.bodyText); } catch { body = {}; }
    }
  }
  const token = typeof body.firebaseIdToken === "string" ? body.firebaseIdToken : getBearer(req);
  if (!token) {
    log("PayChangu checkout auth diagnostic: Firebase token missing. bodyJson keys=" + Object.keys(req.bodyJson || {}).join(",") + "; bodyTextLength=" + String(req.bodyText || "").length);
    return checkoutReply(req, res, { success: false, code: "FIREBASE_TOKEN_MISSING", error: "Please sign in before paying." }, 401);
  }
  log("PayChangu checkout auth diagnostic: Firebase token received; verifying.");

  const { auth, db } = getFirebase();
  let decoded;
  try {
    decoded = await auth.verifyIdToken(token);
  } catch (authError) {
    log("PayChangu checkout Firebase token verification failed: " + String(authError?.code || authError?.message || "unknown verification error"));
    return checkoutReply(req, res, { success: false, code: String(authError?.code || "FIREBASE_TOKEN_INVALID"), error: "Your sign-in has expired. Please sign in again.", diagnostic: String(authError?.code || "unknown") }, 401);
  }

  const courseId = typeof body.courseId === "string" ? body.courseId.trim() : "";
  if (!courseId || courseId.length > 150) {
    return checkoutReply(req, res, { success: false, error: "A valid course ID is required." }, 400);
  }

  const userRef = db.collection("users").doc(decoded.uid);
  const courseRef = db.collection("courses").doc(courseId);
  const [userSnap, courseSnap] = await Promise.all([userRef.get(), courseRef.get()]);
  if (!userSnap.exists) return checkoutReply(req, res, { success: false, error: "Student profile not found." }, 403);

  const user = userSnap.data();
  if (user.role !== "student" || user.status !== "approved") {
    return checkoutReply(req, res, { success: false, error: "Only approved student accounts can purchase courses." }, 403);
  }
  if (!courseSnap.exists) return checkoutReply(req, res, { success: false, error: "Course not found." }, 404);

  const course = courseSnap.data();
  if (course.status !== "published" || course.accessType !== "paid") {
    return checkoutReply(req, res, { success: false, error: "This course is not available for paid enrolment." }, 400);
  }

  const amount = Number(course.price);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    return checkoutReply(req, res, { success: false, error: "The course price is invalid. Please contact the administrator." }, 400);
  }

  const enrollmentRef = userRef.collection("enrollments").doc(courseId);
  const enrollmentSnap = await enrollmentRef.get();
  if (enrollmentSnap.exists && enrollmentSnap.data()?.status === "active") {
    return checkoutReply(req, res, { success: true, alreadyEnrolled: true, message: "You already have access to this course." });
  }

  const secret = process.env.PAYCHANGU_SECRET_KEY;
  if (!secret) throw new Error("Missing PAYCHANGU_SECRET_KEY environment variable.");

  const txRef = "MTR-" + crypto.randomUUID();
  const paymentRef = db.collection("payments").doc(txRef);
  await paymentRef.set({
    tx_ref: txRef,
    uid: decoded.uid,
    courseId,
    courseTitle: String(course.title || "Mobile Tech Room course"),
    amount,
    currency: CURRENCY,
    status: "pending",
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });

  const fullName = String(user.fullName || decoded.name || "").trim().split(/\s+/);
  const firstName = fullName.shift() || "Student";
  const lastName = fullName.join(" ") || "Mobile Tech Room";

  let response;
  try {
    response = await fetch(PAYCHANGU_PAYMENT_URL, {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "Authorization": `Bearer ${secret}`
      },
      body: JSON.stringify({
        amount: String(amount),
        currency: CURRENCY,
        email: String(user.email || decoded.email || ""),
        first_name: firstName,
        last_name: lastName,
        callback_url: APP_URL + "?payment=return",
        return_url: APP_URL + "?payment=cancelled",
        tx_ref: txRef,
        customization: {
          title: "Mobile Tech Room",
          description: `Course access: ${String(course.title || "Paid course").slice(0, 100)}`
        },
        meta: { uid: decoded.uid, courseId }
      })
    });
  } catch (e) {
    await paymentRef.update({ status: "initiation_error", error: String(e.message || e) });
    throw e;
  }

  const result = await response.json().catch(() => ({}));
  const checkoutUrl = result?.data?.checkout_url;
  if (!response.ok || result.status !== "success" || typeof checkoutUrl !== "string" || !checkoutUrl.startsWith("https://")) {
    await paymentRef.update({ status: "initiation_failed" });
    log("PayChangu checkout initiation failed: " + JSON.stringify({ httpStatus: response.status, response: result }));
    return checkoutReply(req, res, { success: false, error: "PayChangu could not start checkout. Please try again or contact the administrator." }, 502);
  }

  await paymentRef.update({ checkoutUrl, status: "pending" });
  const contentType = req.headers?.["content-type"] || "";
  if (contentType.includes("application/x-www-form-urlencoded")) {
    return res.redirect(checkoutUrl, 303);
  }
  return checkoutReply(req, res, { success: true, checkoutUrl, tx_ref: txRef });
}

async function handleWebhook({ req, res, log }) {
  const secret = process.env.PAYCHANGU_SECRET_KEY;
  if (!secret) throw new Error("Missing PAYCHANGU_SECRET_KEY environment variable.");

  const rawBody = req.bodyText || "";
  const signature = req.headers?.signature || req.headers?.Signature || "";
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  if (!safeEqualHex(expected, signature)) {
    log("Rejected PayChangu webhook: invalid signature.");
    return res.json({ received: false, error: "Invalid signature" }, 401);
  }

  let payload;
  try { payload = JSON.parse(rawBody); } catch {
    return res.json({ received: false, error: "Invalid JSON" }, 400);
  }

  const txRef = String(payload.tx_ref || payload.data?.tx_ref || payload.data?.data?.tx_ref || payload.transaction?.tx_ref || "").trim();
  if (!txRef) return res.json({ received: true, ignored: true });

  const { db } = getFirebase();
  const paymentRef = db.collection("payments").doc(txRef);
  const paymentSnap = await paymentRef.get();
  if (!paymentSnap.exists) {
    log("Signed PayChangu webhook has no matching payment intent: " + txRef);
    return res.json({ received: true, ignored: true });
  }

  const payment = paymentSnap.data();
  if (payment.status === "paid") return res.json({ received: true, alreadyProcessed: true });

  const verifyResponse = await fetch(PAYCHANGU_VERIFY_URL + encodeURIComponent(txRef), {
    method: "GET",
    headers: {
      "Accept": "application/json",
      "Authorization": `Bearer ${secret}`
    }
  });
  const verified = await verifyResponse.json().catch(() => ({}));
  const data = verified?.data?.data || verified?.data || {};

  const verifiedAmount = Number(data.amount);
  const isValid = verifyResponse.ok &&
    verified.status === "success" &&
    data.status === "success" &&
    String(data.tx_ref || "") === txRef &&
    String(data.currency || "").toUpperCase() === payment.currency &&
    Number.isFinite(verifiedAmount) &&
    verifiedAmount >= Number(payment.amount);

  if (!isValid) {
    log("PayChangu transaction verification did not match expected payment: " + txRef);
    await paymentRef.set({ verificationStatus: data.status || verified.status || "unverified", lastVerifiedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    return res.json({ received: true, verified: false });
  }

  const userRef = db.collection("users").doc(payment.uid);
  const courseRef = db.collection("courses").doc(payment.courseId);
  const enrollmentRef = userRef.collection("enrollments").doc(payment.courseId);

  await db.runTransaction(async (transaction) => {
    const latestPayment = await transaction.get(paymentRef);
    if (!latestPayment.exists || latestPayment.data().status === "paid") return;

    const [latestUser, latestCourse] = await Promise.all([
      transaction.get(userRef),
      transaction.get(courseRef)
    ]);
    if (!latestUser.exists || latestUser.data().role !== "student" || latestUser.data().status !== "approved") {
      transaction.update(paymentRef, { status: "verified_but_not_enrolled", verifiedAt: admin.firestore.FieldValue.serverTimestamp() });
      return;
    }
    if (!latestCourse.exists || latestCourse.data().status !== "published" || latestCourse.data().accessType !== "paid") {
      transaction.update(paymentRef, { status: "verified_but_course_unavailable", verifiedAt: admin.firestore.FieldValue.serverTimestamp() });
      return;
    }

    transaction.set(enrollmentRef, {
      status: "active",
      courseId: payment.courseId,
      courseTitle: String(latestCourse.data().title || payment.courseTitle || ""),
      grantedBy: "paychangu",
      grantedAt: admin.firestore.FieldValue.serverTimestamp(),
      paymentProvider: "PayChangu",
      paymentReference: txRef,
      paidAmount: verifiedAmount,
      currency: payment.currency
    }, { merge: true });

    transaction.update(paymentRef, {
      status: "paid",
      verifiedAt: admin.firestore.FieldValue.serverTimestamp(),
      paychanguReference: String(data.reference || "")
    });
  });

  return res.json({ received: true, verified: true });
}

export default async ({ req, res, log, error }) => {
  try {
    if (req.method === "OPTIONS") {
      return new Response("OK", {
        status: 200,
        headers: corsHeaders({
          "Content-Type": "text/plain; charset=utf-8",
          "Access-Control-Max-Age": "86400"
        })
      });
    }

    if (req.method !== "POST") return json(res, { success: false, error: "Use POST." }, 405);

    if (req.query?.action === "webhook") return await handleWebhook({ req, res, log });

    let body = {};
    const contentType = req.headers?.["content-type"] || "";
    if (contentType.includes("application/x-www-form-urlencoded")) {
      body = Object.fromEntries(new URLSearchParams(req.bodyText || ""));
    } else {
      body = req.bodyJson || {};
      if (!Object.keys(body).length && req.bodyText) {
        try { body = JSON.parse(req.bodyText); } catch { body = {}; }
      }
    }
    if (body.action !== "create-checkout") {
      return json(res, { success: false, error: "Unknown action." }, 400);
    }
    return await createCheckout({ req, res, log });
  } catch (e) {
    error(e?.stack || String(e));
    return json(res, { success: false, error: "The payment service encountered an error. Please try again later." }, 500);
  }
};
