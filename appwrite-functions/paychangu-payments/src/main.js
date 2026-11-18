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
        callback_url: "https://starter-function-52z5.sgp.appwrite.run/?action=payment-return",
        return_url: "https://starter-function-52z5.sgp.appwrite.run/?action=payment-return",
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


async function verifyAndApplyPayment({ db, txRef, apiSecret, log, terminalFailure = false }) {
  const paymentRef = db.collection("payments").doc(txRef);
  const paymentSnap = await paymentRef.get();
  if (!paymentSnap.exists) return { found: false, status: "not_found" };

  const payment = paymentSnap.data();
  if (payment.status === "paid") return { found: true, status: "paid", alreadyProcessed: true };

  const verifyResponse = await fetch(PAYCHANGU_VERIFY_URL + encodeURIComponent(txRef), {
    method: "GET",
    headers: { "Accept": "application/json", "Authorization": `Bearer ${apiSecret}` }
  });
  if (!verifyResponse.ok) {
    throw new Error("PayChangu verification endpoint returned HTTP " + verifyResponse.status);
  }

  const verified = await verifyResponse.json().catch(() => ({}));
  const data = verified?.data?.data || verified?.data || {};
  const verifiedStatus = String(data.status || "").toLowerCase();
  const returnedRef = String(data.tx_ref || "");
  const verifiedAmount = Number(data.amount);
  const commonMatch = verified.status === "success" &&
    returnedRef === txRef &&
    String(data.currency || "").toUpperCase() === String(payment.currency || "").toUpperCase();

  const isValidSuccess = commonMatch &&
    verifiedStatus === "success" &&
    Number.isFinite(verifiedAmount) &&
    verifiedAmount >= Number(payment.amount);

  if (!isValidSuccess) {
    const markFailed = terminalFailure && commonMatch && verifiedStatus === "failed";
    await db.runTransaction(async (transaction) => {
      const latestPayment = await transaction.get(paymentRef);
      if (!latestPayment.exists || latestPayment.data().status === "paid") return;
      const changes = {
        verificationStatus: verifiedStatus || verified.status || "unverified",
        lastVerifiedAt: admin.firestore.FieldValue.serverTimestamp()
      };
      if (markFailed) {
        changes.status = "failed";
        changes.failureReason = "checkout_cancelled_or_attempts_exhausted";
        changes.failedAt = admin.firestore.FieldValue.serverTimestamp();
        changes.checkoutReturnStatus = "failed";
      }
      transaction.set(paymentRef, changes, { merge: true });
    });
    const latest = await paymentRef.get();
    return {
      found: true,
      status: latest.data()?.status || "pending",
      verified: false,
      verificationStatus: verifiedStatus || "unverified"
    };
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
      transaction.update(paymentRef, {
        status: "verified_but_not_enrolled",
        verifiedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      return;
    }
    if (!latestCourse.exists || latestCourse.data().status !== "published" || latestCourse.data().accessType !== "paid") {
      transaction.update(paymentRef, {
        status: "verified_but_course_unavailable",
        verifiedAt: admin.firestore.FieldValue.serverTimestamp()
      });
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
      paychanguReference: String(data.reference || ""),
      verificationStatus: "success"
    });
  });

  const latest = await paymentRef.get();
  return { found: true, status: latest.data()?.status || "paid", verified: true };
}

async function handlePaymentReturn({ req, res, body, log }) {
  const token = (typeof body.firebaseIdToken === "string" ? body.firebaseIdToken.trim() : "") || getBearer(req);
  if (!token) return json(res, { success: false, error: "Please sign in to confirm your payment." }, 401);

  const { auth, db } = getFirebase();
  let decoded;
  try {
    decoded = await auth.verifyIdToken(token);
  } catch {
    return json(res, { success: false, error: "Your sign-in has expired. Please sign in again." }, 401);
  }

  const txRef = typeof body.tx_ref === "string" ? body.tx_ref.trim() : "";
  if (!txRef || txRef.length > 200) {
    return json(res, { success: false, error: "A valid payment reference is required." }, 400);
  }

  const paymentRef = db.collection("payments").doc(txRef);
  const paymentSnap = await paymentRef.get();
  if (!paymentSnap.exists) return json(res, { success: false, error: "Payment record not found." }, 404);
  if (paymentSnap.data().uid !== decoded.uid) {
    return json(res, { success: false, error: "This payment does not belong to your account." }, 403);
  }

  const apiSecret = process.env.PAYCHANGU_SECRET_KEY;
  if (!apiSecret) throw new Error("Missing PAYCHANGU_SECRET_KEY environment variable.");

  const terminalFailure = String(body.returnStatus || "").toLowerCase() === "failed";
  const result = await verifyAndApplyPayment({
    db, txRef, apiSecret, log, terminalFailure
  });
  return json(res, {
    success: true,
    status: result.status,
    verified: Boolean(result.verified),
    alreadyProcessed: Boolean(result.alreadyProcessed)
  });
}

async function handleGatewayReturn({ req, res, txRef, returnStatus, log }) {
  const safeTxRef = String(txRef || "").trim();
  if (!safeTxRef || safeTxRef.length > 200) {
    return res.redirect(APP_URL + "?payment=checking", 303);
  }

  try {
    const { db } = getFirebase();
    const apiSecret = process.env.PAYCHANGU_SECRET_KEY;
    if (!apiSecret) throw new Error("Missing PAYCHANGU_SECRET_KEY environment variable.");

    const paymentSnap = await db.collection("payments").doc(safeTxRef).get();
    if (!paymentSnap.exists) {
      log("PayChangu return received for an unknown transaction reference.");
      return res.redirect(APP_URL + "?payment=checking", 303);
    }

    const terminalFailure = String(returnStatus || "").toLowerCase() === "failed";
    const result = await verifyAndApplyPayment({
      db, txRef: safeTxRef, apiSecret, log, terminalFailure
    });
    const destinationStatus = result.status === "paid" ? "paid"
      : result.status === "failed" ? "failed" : "pending";
    return res.redirect(APP_URL + "?payment=" + destinationStatus, 303);
  } catch (e) {
    log("PayChangu return verification error: " + String(e?.stack || e));
    return res.redirect(APP_URL + "?payment=checking", 303);
  }
}

async function handleWebhook({ req, res, log }) {
  const webhookSecret = process.env.PAYCHANGU_WEBHOOK_SECRET;
  const apiSecret = process.env.PAYCHANGU_SECRET_KEY;
  if (!webhookSecret) throw new Error("Missing PAYCHANGU_WEBHOOK_SECRET environment variable.");
  if (!apiSecret) throw new Error("Missing PAYCHANGU_SECRET_KEY environment variable.");

  const rawBody = req.bodyText || "";
  const signature = req.headers?.signature || req.headers?.Signature || "";
  const expected = crypto.createHmac("sha256", webhookSecret).update(rawBody).digest("hex");
  if (!safeEqualHex(expected, signature)) {
    log("Rejected PayChangu webhook: invalid signature.");
    return json(res, { received: false, error: "Invalid signature" }, 401);
  }

  let payload;
  try { payload = JSON.parse(rawBody); } catch {
    return json(res, { received: false, error: "Invalid JSON" }, 400);
  }

  const txRef = String(
    payload.tx_ref ||
    payload.data?.tx_ref ||
    payload.data?.data?.tx_ref ||
    payload.transaction?.tx_ref ||
    ""
  ).trim();
  if (!txRef) return json(res, { received: true, ignored: true });

  const { db } = getFirebase();
  const paymentRef = db.collection("payments").doc(txRef);
  const paymentSnap = await paymentRef.get();
  if (!paymentSnap.exists) {
    log("Signed PayChangu webhook has no matching payment intent: " + txRef);
    return json(res, { received: true, ignored: true });
  }
  if (paymentSnap.data().status === "paid") {
    return json(res, { received: true, alreadyProcessed: true });
  }

  const eventStatus = String(
    payload.status || payload.data?.status || payload.data?.data?.status || ""
  ).toLowerCase();

  // PayChangu can send a failed event for an individual attempt while checkout
  // remains open for another attempt. Record it, but do not close the payment.
  if (eventStatus === "failed") {
    await paymentRef.set({
      lastWebhookStatus: "failed",
      lastFailedAttemptAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  }

  const result = await verifyAndApplyPayment({
    db, txRef, apiSecret, log, terminalFailure: false
  });
  return json(res, {
    received: true,
    verified: Boolean(result.verified),
    status: result.status
  });
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

    const action = req.query?.action || "";
    if (action === "payment-return" && (req.method === "GET" || req.method === "POST")) {
      let returnBody = req.bodyJson || {};
      const contentType = req.headers?.["content-type"] || "";
      if (contentType.includes("application/x-www-form-urlencoded")) {
        returnBody = Object.fromEntries(new URLSearchParams(req.bodyText || ""));
      } else if (!Object.keys(returnBody).length && req.bodyText) {
        try { returnBody = JSON.parse(req.bodyText); } catch { returnBody = {}; }
      }
      const txRef = req.query?.tx_ref || req.query?.txRef || returnBody.tx_ref || returnBody.txRef || "";
      const returnStatus = req.query?.status || returnBody.status || "";
      return await handleGatewayReturn({ req, res, txRef, returnStatus, log });
    }

    if (req.method !== "POST") return json(res, { success: false, error: "Use POST." }, 405);

    if (action === "webhook") return await handleWebhook({ req, res, log });

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
    if (body.action === "verify-payment-return") {
      return await handlePaymentReturn({ req, res, body, log });
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
