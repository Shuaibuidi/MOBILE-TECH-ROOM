import Busboy from "busboy";
import { Readable } from "node:stream";
import crypto from "node:crypto";
import admin from "firebase-admin";
import { Client, ID, Storage, Query } from "node-appwrite";
import { InputFile } from "node-appwrite/file";

// This API authenticates requests with explicit Firebase Bearer tokens (not cookies).
// A wildcard origin allows both GitHub Pages and the Capacitor Android WebView to call it;
// every protected operation still verifies the Firebase token and Firestore permissions.
const APP_ORIGIN = "*";
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const ALLOWED_MIME = new Set(["application/pdf"]);

let firebaseReady = false;
let storageUsageCache = null;
let storageUsageCacheAt = 0;
function getFirebase() {
  if (!firebaseReady) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!raw) throw new Error("Missing FIREBASE_SERVICE_ACCOUNT_JSON.");
    const account = JSON.parse(raw);
    if (!admin.apps.some(app => app.name === "[DEFAULT]")) admin.initializeApp({ credential: admin.credential.cert(account) });
    firebaseReady = true;
  }
  return { auth: admin.auth(), db: admin.firestore() };
}

function headers() {
  return {
    "Access-Control-Allow-Origin": APP_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Vary": "Origin"
  };
}
function json(res, body, status = 200) {
  return res.json(body, status, { ...headers(), "Content-Type": "application/json; charset=utf-8" });
}
function bearer(req) {
  const value = req.headers?.authorization || req.headers?.Authorization || "";
  return value.startsWith("Bearer ") ? value.slice(7).trim() : "";
}
function requestBuffer(req) {
  const value = req.bodyBinary ?? req.body;
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string") return Buffer.from(value, "binary");
  return null;
}
function parseMultipart(req, raw) {
  return new Promise((resolve, reject) => {
    const contentType = req.headers?.["content-type"] || req.headers?.["Content-Type"] || "";
    let parser;
    try { parser = Busboy({ headers: { "content-type": contentType }, limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 5 } }); }
    catch { reject(new Error("The upload form is invalid. Please try again.")); return; }

    const fields = {};
    let uploaded = null;
    let fileError = null;
    parser.on("field", (name, value) => { fields[name] = value; });
    parser.on("file", (name, stream, info) => {
      if (name !== "file") { stream.resume(); return; }
      const chunks = [];
      let size = 0;
      stream.on("data", chunk => { size += chunk.length; if (size <= MAX_FILE_BYTES) chunks.push(chunk); });
      stream.on("limit", () => { fileError = new Error("The file must be 50 MB or smaller."); });
      stream.on("end", () => {
        if (!fileError) uploaded = { buffer: Buffer.concat(chunks), filename: info.filename, mimeType: String(info.mimeType || "").toLowerCase() };
      });
    });
    parser.on("error", reject);
    parser.on("finish", () => {
      if (fileError) return reject(fileError);
      if (!uploaded?.buffer?.length) return reject(new Error("Choose a file before uploading."));
      resolve({ fields, uploaded });
    });
    Readable.from([raw]).pipe(parser);
  });
}
function safeFilename(name) {
  const base = String(name || "lesson-file").split(/[\\/]/).pop().replace(/[^a-zA-Z0-9._-]/g, "_").slice(-120);
  return base || "lesson-file";
}
function mimeFromName(name, supplied) {
  const ext = String(name).split(".").pop().toLowerCase();
  const byExt = {
    jpg:"image/jpeg", jpeg:"image/jpeg", png:"image/png", webp:"image/webp", gif:"image/gif",
    mp4:"video/mp4", webm:"video/webm", pdf:"application/pdf",
    mp3:"audio/mpeg", wav:"audio/wav", m4a:"audio/mp4", ogg:"audio/ogg", aac:"audio/aac"
  };
  if (!supplied || supplied === "application/octet-stream") return byExt[ext] || supplied;
  return supplied;
}

async function handleUpload({ req, res, log, error }) {
  try {
    if (req.method === "OPTIONS") return res.text("", 204, headers());
    if (req.method !== "POST") return json(res, { success: false, error: "Use POST." }, 405);

    const token = bearer(req);
    if (!token) return json(res, { success: false, error: "Please sign in before uploading." }, 401);

    const raw = requestBuffer(req);
    if (!raw) return json(res, { success: false, error: "The upload could not be read. Please try again." }, 400);
    if (raw.length > MAX_FILE_BYTES + 1024 * 1024) return json(res, { success: false, error: "The file must be 50 MB or smaller." }, 413);

    const { fields, uploaded } = await parseMultipart(req, raw);
    const courseId = String(fields.courseId || "").trim();
    if (!courseId || courseId.length > 150) return json(res, { success: false, error: "A valid course ID is required." }, 400);

    const { auth, db } = getFirebase();
    let decoded;
    try { decoded = await auth.verifyIdToken(token); }
    catch { return json(res, { success: false, error: "Your sign-in has expired. Please sign in again." }, 401); }

    const [userSnap, courseSnap] = await Promise.all([
      db.collection("users").doc(decoded.uid).get(),
      db.collection("courses").doc(courseId).get()
    ]);
    if (!userSnap.exists) return json(res, { success: false, error: "Your staff profile was not found." }, 403);
    const user = userSnap.data();
    if (user.status !== "approved" || !["admin", "instructor"].includes(user.role)) {
      return json(res, { success: false, error: "Only approved administrators and instructors can upload lesson files." }, 403);
    }
    if (!courseSnap.exists) return json(res, { success: false, error: "Course not found." }, 404);
    if (user.role === "instructor" && courseSnap.data().createdBy !== decoded.uid) {
      return json(res, { success: false, error: "Instructors can upload files only to their own courses." }, 403);
    }

    const filename = safeFilename(uploaded.filename);
    const mime = mimeFromName(filename, uploaded.mimeType);
    if (!ALLOWED_MIME.has(mime)) {
      return json(res, { success: false, error: "Unsupported file type. Only PDF documents are accepted." }, 415);
    }

    const endpoint = (process.env.APPWRITE_ENDPOINT || "").trim().replace(/\/+$/, "");
    const projectId = process.env.APPWRITE_PROJECT_ID;
    const apiKey = process.env.APPWRITE_API_KEY;
    const bucketId = process.env.APPWRITE_BUCKET_ID;
    if (!endpoint || !projectId || !apiKey || !bucketId) throw new Error("Appwrite storage environment variables are incomplete.");

    const client = new Client().setEndpoint(endpoint).setProject(projectId).setKey(apiKey);
    const storage = new Storage(client);
    const storedName = courseId + "/" + decoded.uid + "/" + crypto.randomUUID() + "-" + filename;
    const file = await storage.createFile({
      bucketId,
      fileId: ID.unique(),
      file: InputFile.fromBuffer(uploaded.buffer, filename),
      permissions: []
    });
    const mediaUrl = endpoint.replace(/\/$/, "") + "/storage/buckets/" +
      encodeURIComponent(bucketId) + "/files/" + encodeURIComponent(file.$id) +
      "/view?project=" + encodeURIComponent(projectId);

    log("Lesson media uploaded to Appwrite: " + file.$id + " (" + storedName + ")");
    return json(res, {
      success: true,
      mediaUrl,
      fileId: file.$id,
      bucketId,
      fileName: filename,
      contentType: mime
    });
  } catch (e) {
    error(e?.stack || String(e));
    const message = e instanceof Error ? e.message : "Upload failed.";
    return json(res, { success: false, error: message.includes("50 MB") ? message : "The upload service encountered an error. Please try again." }, 500);
  }
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



async function handleStorageUsage({ req, res, error }) {
  try {
    if (req.method === "OPTIONS") return res.text("", 204, headers());
    if (req.method !== "GET") return json(res, { success: false, error: "Use GET." }, 405);
    const token = bearer(req);
    if (!token) return json(res, { success: false, error: "Please sign in to view storage usage." }, 401);
    const { auth, db } = getFirebase();
    let decoded;
    try { decoded = await auth.verifyIdToken(token); }
    catch { return json(res, { success: false, error: "Your sign-in has expired. Please sign in again." }, 401); }
    const userSnap = await db.collection("users").doc(decoded.uid).get();
    if (!userSnap.exists) return json(res, { success: false, error: "Administrator profile not found." }, 403);
    const user = userSnap.data() || {};
    if (user.status !== "approved" || user.role !== "admin") {
      return json(res, { success: false, error: "Only an approved administrator can view storage usage." }, 403);
    }
    const endpoint = (process.env.APPWRITE_ENDPOINT || "").trim().replace(/\/+$/, "");
    const projectId = process.env.APPWRITE_PROJECT_ID;
    const apiKey = process.env.APPWRITE_API_KEY;
    const bucketId = process.env.APPWRITE_BUCKET_ID;
    if (!endpoint || !projectId || !apiKey || !bucketId) throw new Error("Appwrite storage environment variables are incomplete.");
    if (storageUsageCache && storageUsageCache.bucketId === bucketId && Date.now() - storageUsageCacheAt < 5 * 60 * 1000) {
      return json(res, { ...storageUsageCache.data, cached: true });
    }
    const client = new Client().setEndpoint(endpoint).setProject(projectId).setKey(apiKey);
    const storage = new Storage(client);
    let bytes = 0, fileCount = 0, cursor = null, pages = 0;
    while (pages < 1000) {
      const queries = [Query.limit(100)];
      if (cursor) queries.push(Query.cursorAfter(cursor));
      const result = await storage.listFiles({ bucketId, queries });
      const files = result.files || [];
      for (const file of files) {
        bytes += Number(file.sizeActual ?? file.sizeOriginal ?? 0) || 0;
        fileCount += 1;
      }
      pages += 1;
      if (files.length < 100) break;
      cursor = files[files.length - 1].$id;
    }
    const data = { success: true, bytes, fileCount, complete: pages < 1000, measuredAt: new Date().toISOString() };
    storageUsageCache = { bucketId, data };
    storageUsageCacheAt = Date.now();
    return json(res, data);
  } catch (e) {
    error(e?.stack || String(e));
    return json(res, { success: false, error: "Storage usage could not be loaded. Please try again." }, 500);
  }
}

async function handleMedia({ req, res, log, error }) {
  try {
    if (req.method === "OPTIONS") return res.text("", 204, headers());
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
    try { decoded = await auth.verifyIdToken(token); }
    catch { return json(res, { success: false, error: "Your sign-in has expired. Please sign in again." }, 401); }

    const mediaUrl = String(req.query?.mediaUrl || "").trim();
    const mediaUrlMatchesFile = mediaUrl.length > 0 && mediaUrl.length <= 2048 &&
      fileIdFromMediaUrl(mediaUrl) === fileId;

    const [userSnap, courseSnap, lessonSnap] = await Promise.all([
      db.collection("users").doc(decoded.uid).get(),
      db.collection("courses").doc(courseId).get(),
      mediaUrlMatchesFile
        ? db.collection("courses").doc(courseId).collection("lessons")
            .where("mediaUrl", "==", mediaUrl).limit(1).get()
        : db.collection("courses").doc(courseId).collection("lessons").get()
    ]);
    if (!userSnap.exists || !courseSnap.exists) {
      return json(res, { success: false, error: "The account or course could not be found." }, 404);
    }

    const user = userSnap.data() || {};
    const course = courseSnap.data() || {};
    if (user.status !== "approved" || !["admin", "instructor", "student"].includes(user.role)) {
      return json(res, { success: false, error: "Your account is not approved to view lesson files." }, 403);
    }
    const attached = lessonSnap.docs.some(doc => fileIdFromMediaUrl(doc.data()?.mediaUrl) === fileId);
    if (!attached) {
      return json(res, { success: false, error: "This file is not attached to a lesson in the selected course." }, 403);
    }
    if (user.role === "instructor" && course.createdBy !== decoded.uid) {
      return json(res, { success: false, error: "Instructors can access files only in their own courses." }, 403);
    }
    if (user.role === "student" && course.accessType === "paid") {
      const enrollment = await db.collection("users").doc(decoded.uid).collection("enrollments").doc(courseId).get();
      if (!enrollment.exists || enrollment.data()?.status !== "active") {
        return json(res, { success: false, error: "This is a paid course. You do not currently have access." }, 403);
      }
    }

    const endpoint = (process.env.APPWRITE_ENDPOINT || "").trim().replace(/\/+$/, "");
    const projectId = process.env.APPWRITE_PROJECT_ID;
    const apiKey = process.env.APPWRITE_API_KEY;
    const bucketId = process.env.APPWRITE_BUCKET_ID;
    if (!endpoint || !projectId || !apiKey || !bucketId) throw new Error("Appwrite media function configuration is incomplete.");

    // Retrieve private file bytes server-side after all Firebase access checks.
    // Never create or return a reusable Appwrite file token.
    const fileUrl = endpoint + "/storage/buckets/" + encodeURIComponent(bucketId) +
      "/files/" + encodeURIComponent(fileId) + "/view?project=" + encodeURIComponent(projectId);
    const upstream = await fetch(fileUrl, {
      method: "GET",
      headers: { "X-Appwrite-Project": projectId, "X-Appwrite-Key": apiKey }
    });
    if (!upstream.ok) {
      log("Private Appwrite file retrieval failed: HTTP " + upstream.status + " for " + fileId);
      const status = upstream.status === 404 ? 404 : 502;
      return json(res, { success: false, error: status === 404 ? "The lesson file no longer exists." : "The lesson file could not be retrieved." }, status);
    }

    const contentType = (upstream.headers.get("content-type") || "application/octet-stream").split(";")[0].trim().toLowerCase();
    const safeType = ALLOWED_MIME.has(contentType) ? contentType : "application/octet-stream";
    if (!upstream.body) throw new Error("Appwrite returned no media stream.");
    const responseHeaders = {
      ...headers(),
      "Content-Type": safeType,
      "Content-Disposition": "inline; filename=\"lesson-media\"",
      "Cache-Control": "private, no-store, max-age=0",
      "Pragma": "no-cache",
      "X-Content-Type-Options": "nosniff"
    };
    const contentLength = upstream.headers.get("content-length");
    if (contentLength && /^\\d+$/.test(contentLength)) responseHeaders["Content-Length"] = contentLength;
    log("Progressively streaming lesson media for user " + decoded.uid + " and course " + courseId);
    return res.sendStream(upstream.body, 200, responseHeaders);
  } catch (e) {
    error(e?.stack || String(e));
    return json(res, { success: false, error: "The secure lesson media service encountered an error. Please try again." }, 500);
  }
}


async function handleAdminNotifications({ req, res, error }) {
  try {
    if (req.method === "OPTIONS") return res.text("", 204, headers());
    const token = bearer(req);
    if (!token) return json(res, { success: false, error: "Please sign in to manage notifications." }, 401);
    const { auth, db } = getFirebase();
    let decoded;
    try { decoded = await auth.verifyIdToken(token); }
    catch { return json(res, { success: false, error: "Your sign-in has expired. Please sign in again." }, 401); }

    const userRef = db.collection("users").doc(decoded.uid);
    const userSnap = await userRef.get();
    if (!userSnap.exists) return json(res, { success: false, error: "Account profile not found." }, 403);
    const user = userSnap.data() || {};
    const action = req.query?.action || "";

    if (action === "registration-notification" && req.method === "POST") {
      if (user.role !== "student" || user.status !== "pending") {
        return json(res, { success: false, error: "Only a newly registered pending student can create this alert." }, 403);
      }
      const notificationRef = db.collection("adminNotifications").doc("registration-" + decoded.uid);
      await notificationRef.set({
        type: "new_student",
        uid: decoded.uid,
        studentName: String(user.fullName || decoded.name || "New student").slice(0, 120),
        email: String(user.email || decoded.email || "").slice(0, 180),
        message: "A new student is waiting for account approval.",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        readAt: null
      }, { merge: true });
      return json(res, { success: true });
    }

    if (user.role !== "admin" || user.status !== "approved") {
      return json(res, { success: false, error: "Only an approved administrator can view or update notifications." }, 403);
    }

    if (action === "mark-notification-read" && req.method === "POST") {
      const body = req.bodyJson || {};
      const notificationId = String(body.notificationId || "").trim();
      if (!/^(payment|registration)-[A-Za-z0-9._-]{1,200}$/.test(notificationId)) {
        return json(res, { success: false, error: "Invalid notification." }, 400);
      }
      const notificationRef = db.collection("adminNotifications").doc(notificationId);
      const notificationSnap = await notificationRef.get();
      if (!notificationSnap.exists) return json(res, { success: false, error: "Notification not found." }, 404);
      await notificationRef.set({ readAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      return json(res, { success: true });
    }

    if (action !== "admin-notifications" || req.method !== "GET") {
      return json(res, { success: false, error: "Unknown notification action." }, 400);
    }
    const snapshot = await db.collection("adminNotifications").orderBy("createdAt", "desc").limit(20).get();
    // Fetch all referenced student profiles in one Firestore round-trip instead of
    // issuing one sequential request per notification.
    const studentIds = [...new Set(snapshot.docs
      .map(item => item.data()?.uid)
      .filter(Boolean)
      .map(String))];
    const studentSnaps = studentIds.length
      ? await db.getAll(...studentIds.map(uid => db.collection("users").doc(uid)))
      : [];
    const studentStatusById = new Map(studentSnaps.map(snap => [
      snap.id, snap.exists ? String(snap.data()?.status || "pending") : "unknown"
    ]));
    const notifications = snapshot.docs.map(item => {
      const value = item.data() || {};
      return {
        id: item.id,
        type: String(value.type || "alert"),
        studentName: String(value.studentName || ""),
        email: String(value.email || ""),
        studentStatus: value.uid && value.type === "new_student" ? (studentStatusById.get(String(value.uid)) || "unknown") : "",
        courseTitle: String(value.courseTitle || ""),
        amount: Number(value.amount || 0),
        currency: String(value.currency || "MWK"),
        message: String(value.message || ""),
        read: Boolean(value.readAt),
        createdAt: value.createdAt?.toDate ? value.createdAt.toDate().toISOString() : null
      };
    });
    return json(res, { success: true, notifications });
  } catch (e) {
    error(e?.stack || String(e));
    return json(res, { success: false, error: "Notifications could not be loaded. Please try again." }, 500);
  }
}

async function handleCourseProgress({ req, res, error }) {
 try {
  if(req.method==="OPTIONS")return res.text("",204,headers());
  const action=String(req.query?.action||"");
  if(!["course-progress","complete-lesson"].includes(action))return json(res,{success:false,error:"Unknown course progress action."},400);
  if((action==="course-progress"&&req.method!=="GET")||(action==="complete-lesson"&&req.method!=="POST"))return json(res,{success:false,error:action==="course-progress"?"Use GET.":"Use POST."},405);
  const token=bearer(req);if(!token)return json(res,{success:false,error:"Please sign in to save course progress."},401);
  const {auth,db}=getFirebase();let decoded;try{decoded=await auth.verifyIdToken(token);}catch{return json(res,{success:false,error:"Your sign-in has expired. Please sign in again."},401);}
  // GET progress requests have no JSON body; reading req.bodyJson on an empty body throws.
  // Only parse the body for POST lesson-completion requests.
  const body=action==="complete-lesson"?(req.bodyJson||{}):{},courseId=String(req.query?.courseId||body.courseId||"").trim();if(!courseId||courseId.length>150)return json(res,{success:false,error:"A valid course ID is required."},400);
  const userRef=db.collection("users").doc(decoded.uid),courseRef=db.collection("courses").doc(courseId);
  const [userSnap,courseSnap]=await Promise.all([userRef.get(),courseRef.get()]);if(!userSnap.exists||!courseSnap.exists)return json(res,{success:false,error:"Your account or course could not be found."},404);
  const user=userSnap.data()||{},course=courseSnap.data()||{};if(user.role!=="student"||user.status!=="approved")return json(res,{success:false,error:"Only approved students can record course completion."},403);
  if(course.accessType==="paid"){const enrollment=await userRef.collection("enrollments").doc(courseId).get();if(!enrollment.exists||enrollment.data()?.status!=="active")return json(res,{success:false,error:"You do not have access to this paid course."},403);}
  const lessonsSnap=await courseRef.collection("lessons").get(),lessonIds=lessonsSnap.docs.map(x=>x.id),progressRef=userRef.collection("courseProgress").doc(courseId);
  if(action==="complete-lesson"){
   const lessonId=String(body.lessonId||"").trim();if(!lessonId||!lessonIds.includes(lessonId))return json(res,{success:false,error:"This lesson does not belong to the selected course."},400);
   await db.runTransaction(async tx=>{
    const ps=await tx.get(progressRef),saved=ps.exists?ps.data()||{}:{},set=new Set(Array.isArray(saved.completedLessonIds)?saved.completedLessonIds:[]);set.add(lessonId);
    const completedLessonIds=lessonIds.filter(id=>set.has(id)),complete=lessonIds.length>0&&completedLessonIds.length===lessonIds.length;
    const certificateId=saved.certificateId||(complete?"MTR-"+new Date().getFullYear()+"-"+crypto.randomBytes(8).toString("hex").toUpperCase():null);
    const update={courseId,courseTitle:String(course.title||"Course").slice(0,180),studentName:String(user.fullName||decoded.name||decoded.email||"Student").slice(0,120),completedLessonIds,totalLessons:lessonIds.length,updatedAt:admin.firestore.FieldValue.serverTimestamp()};
    if(complete&&!saved.certificateId){update.certificateId=certificateId;update.completedAt=admin.firestore.FieldValue.serverTimestamp();}
    tx.set(progressRef,update,{merge:true});
   });
  }
  const ps=await progressRef.get(),saved=ps.exists?ps.data()||{}:{},completedLessonIds=lessonIds.filter(id=>Array.isArray(saved.completedLessonIds)&&saved.completedLessonIds.includes(id)),completedAt=saved.completedAt?.toDate?saved.completedAt.toDate().toISOString():null;
  return json(res,{success:true,courseId,courseTitle:String(saved.courseTitle||course.title||"Course"),studentName:String(saved.studentName||user.fullName||decoded.name||decoded.email||"Student"),completedLessonIds,completedCount:completedLessonIds.length,totalLessons:lessonIds.length,certificateId:saved.certificateId||null,completedAt});
 }catch(e){error(e?.stack||String(e));return json(res,{success:false,error:"Course progress could not be saved. Please try again."},500);}
}


function quizSafeQuestion(question, includeAnswer) {
  const value = {
    text: String(question.text || ""),
    options: Array.isArray(question.options) ? question.options.map(option => String(option)) : []
  };
  if (includeAnswer) value.correctIndex = Number(question.correctIndex);
  return value;
}

function validateQuizInput(body) {
  const title = String(body.title || "").trim().slice(0, 160);
  const description = String(body.description || "").trim().slice(0, 1200);
  const courseId = String(body.courseId || "").trim();
  const status = body.status === "published" ? "published" : "draft";
  if (!courseId || courseId.length > 150) throw new Error("Choose a valid course.");
  if (!title) throw new Error("Enter a quiz title.");
  if (!Array.isArray(body.questions) || body.questions.length < 1 || body.questions.length > 40) {
    throw new Error("A quiz must contain between 1 and 40 questions.");
  }
  const questions = body.questions.map((item, index) => {
    const text = String(item?.text || "").trim().slice(0, 1000);
    const options = Array.isArray(item?.options) ? item.options.map(option => String(option || "").trim().slice(0, 300)) : [];
    const correctIndex = Number(item?.correctIndex);
    if (!text) throw new Error("Enter the text for question " + (index + 1) + ".");
    if (options.length < 2 || options.length > 6 || options.some(option => !option)) {
      throw new Error("Question " + (index + 1) + " must have 2 to 6 non-empty answer options.");
    }
    if (!Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex >= options.length) {
      throw new Error("Select the correct answer for question " + (index + 1) + ".");
    }
    return { text, options, correctIndex };
  });
  return { courseId, title, description, status, questions };
}

async function handleQuizzes({ req, res, error }) {
  try {
    if (req.method === "OPTIONS") return res.text("", 204, headers());
    const action = String(req.query?.action || "");
    const allowed = ["quiz-list", "quiz-get", "quiz-create", "quiz-update", "quiz-delete", "quiz-submit", "quiz-results"];
    if (!allowed.includes(action)) return json(res, { success: false, error: "Unknown quiz action." }, 400);
    const readActions = ["quiz-list", "quiz-get", "quiz-results"];
    if (readActions.includes(action) && req.method !== "GET") return json(res, { success: false, error: "Use GET." }, 405);
    if (!readActions.includes(action) && req.method !== "POST") return json(res, { success: false, error: "Use POST." }, 405);

    const token = bearer(req);
    if (!token) return json(res, { success: false, error: "Please sign in to use quizzes." }, 401);
    const { auth, db } = getFirebase();
    let decoded;
    try { decoded = await auth.verifyIdToken(token); }
    catch { return json(res, { success: false, error: "Your sign-in has expired. Please sign in again." }, 401); }

    const userSnap = await db.collection("users").doc(decoded.uid).get();
    if (!userSnap.exists) return json(res, { success: false, error: "Account profile not found." }, 403);
    const user = userSnap.data() || {};
    if (user.status !== "approved" || !["admin", "instructor", "student"].includes(user.role)) {
      return json(res, { success: false, error: "Your account is not approved to use quizzes." }, 403);
    }
    const staff = user.role === "admin" || user.role === "instructor";
    const body = req.method === "POST" ? (req.bodyJson || {}) : {};
    const quizId = String(req.query?.quizId || body.quizId || "").trim();

    const canManageCourse = async courseId => {
      const courseSnap = await db.collection("courses").doc(courseId).get();
      if (!courseSnap.exists) return { ok: false, error: "Course not found." };
      const course = courseSnap.data() || {};
      if (user.role === "instructor" && course.createdBy !== decoded.uid) {
        return { ok: false, error: "Instructors can manage quizzes only for their own courses." };
      }
      if (!staff) return { ok: false, error: "Only administrators and instructors can manage quizzes." };
      return { ok: true, course };
    };

    const canStudentAccessCourse = async course => {
      if (user.role !== "student" || user.status !== "approved") return false;
      if (course.status !== "published") return false;
      if (course.accessType === "paid") {
        const enrollment = await db.collection("users").doc(decoded.uid).collection("enrollments").doc(course.id).get();
        return enrollment.exists && enrollment.data()?.status === "active";
      }
      return true;
    };

    if (action === "quiz-list") {
      const reads = [
        db.collection("courses").get(),
        db.collection("quizzes").limit(300).get()
      ];
      // Read a student's enrolments once, rather than making a separate Firestore
      // request for every paid course during quiz-list rendering.
      if (user.role === "student") reads.push(
        db.collection("users").doc(decoded.uid).collection("enrollments").get()
      );
      const [courseSnap, quizSnap, enrollmentSnap] = await Promise.all(reads);
      const courseMap = new Map(courseSnap.docs.map(item => [item.id, { id: item.id, ...item.data() }]));
      const enrollmentIds = new Set((enrollmentSnap?.docs || [])
        .filter(item => item.data()?.status === "active").map(item => item.id));
      const accessible = new Set(Array.from(courseMap.values())
        .filter(course => {
          if (user.role === "admin") return true;
          if (user.role === "instructor") return course.createdBy === decoded.uid;
          if (user.role !== "student" || user.status !== "approved" || course.status !== "published") return false;
          return course.accessType !== "paid" || enrollmentIds.has(course.id);
        }).map(course => course.id));
      const quizzes = quizSnap.docs
        .map(item => ({ id: item.id, ...item.data() }))
        .filter(quiz => accessible.has(String(quiz.courseId || "")) && (staff || quiz.status === "published"))
        .map(quiz => ({
          id: quiz.id,
          courseId: String(quiz.courseId || ""),
          courseTitle: String(courseMap.get(quiz.courseId)?.title || "Course"),
          title: String(quiz.title || "Quiz"),
          description: String(quiz.description || ""),
          status: String(quiz.status || "draft"),
          questionCount: Array.isArray(quiz.questions) ? quiz.questions.length : 0,
          createdAt: quiz.createdAt?.toDate ? quiz.createdAt.toDate().toISOString() : null
        }));
      return json(res, { success: true, quizzes });
    }

    if (action === "quiz-get") {
      if (!quizId) return json(res, { success: false, error: "Choose a quiz." }, 400);
      const snap = await db.collection("quizzes").doc(quizId).get();
      if (!snap.exists) return json(res, { success: false, error: "Quiz not found." }, 404);
      const quiz = { id: snap.id, ...snap.data() };
      const courseSnap = await db.collection("courses").doc(String(quiz.courseId || "")).get();
      if (!courseSnap.exists) return json(res, { success: false, error: "Course not found." }, 404);
      const course = { id: courseSnap.id, ...courseSnap.data() };
      if (staff) {
        if (user.role === "instructor" && course.createdBy !== decoded.uid) return json(res, { success: false, error: "You cannot access quizzes for another instructor's course." }, 403);
      } else {
        if (quiz.status !== "published" || !(await canStudentAccessCourse(course))) return json(res, { success: false, error: "You do not have access to this quiz." }, 403);
      }
      return json(res, {
        success: true,
        quiz: {
          id: quiz.id, courseId: String(quiz.courseId || ""), courseTitle: String(course.title || "Course"),
          title: String(quiz.title || "Quiz"), description: String(quiz.description || ""),
          status: String(quiz.status || "draft"),
          questions: (Array.isArray(quiz.questions) ? quiz.questions : []).map(question => quizSafeQuestion(question, staff))
        }
      });
    }

    if (action === "quiz-create" || action === "quiz-update") {
      const input = validateQuizInput(body);
      const permission = await canManageCourse(input.courseId);
      if (!permission.ok) return json(res, { success: false, error: permission.error }, 403);
      if (action === "quiz-create") {
        const ref = db.collection("quizzes").doc();
        await ref.set({
          ...input,
          createdBy: decoded.uid,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        return json(res, { success: true, quizId: ref.id, message: "Quiz created successfully." });
      }
      if (!quizId) return json(res, { success: false, error: "Quiz ID is required." }, 400);
      const ref = db.collection("quizzes").doc(quizId);
      const existing = await ref.get();
      if (!existing.exists) return json(res, { success: false, error: "Quiz not found." }, 404);
      const old = existing.data() || {};
      if (old.courseId !== input.courseId) {
        const oldPermission = await canManageCourse(String(old.courseId || ""));
        if (!oldPermission.ok) return json(res, { success: false, error: oldPermission.error }, 403);
      }
      await ref.set({ ...input, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      return json(res, { success: true, quizId, message: "Quiz updated successfully." });
    }

    if (action === "quiz-delete") {
      if (!quizId) return json(res, { success: false, error: "Quiz ID is required." }, 400);
      const ref = db.collection("quizzes").doc(quizId);
      const snap = await ref.get();
      if (!snap.exists) return json(res, { success: false, error: "Quiz not found." }, 404);
      const permission = await canManageCourse(String(snap.data()?.courseId || ""));
      if (!permission.ok) return json(res, { success: false, error: permission.error }, 403);
      await ref.delete();
      return json(res, { success: true, message: "Quiz deleted." });
    }

    if (action === "quiz-submit") {
      if (user.role !== "student") return json(res, { success: false, error: "Only students can submit quiz answers." }, 403);
      if (!quizId || !Array.isArray(body.answers)) return json(res, { success: false, error: "Quiz and answers are required." }, 400);
      const ref = db.collection("quizzes").doc(quizId);
      const snap = await ref.get();
      if (!snap.exists) return json(res, { success: false, error: "Quiz not found." }, 404);
      const quiz = snap.data() || {};
      if (quiz.status !== "published") return json(res, { success: false, error: "This quiz is not published." }, 403);
      const courseSnap = await db.collection("courses").doc(String(quiz.courseId || "")).get();
      if (!courseSnap.exists || !(await canStudentAccessCourse({ id: courseSnap.id, ...courseSnap.data() }))) {
        return json(res, { success: false, error: "You do not have access to this course quiz." }, 403);
      }
      const questions = Array.isArray(quiz.questions) ? quiz.questions : [];
      if (!questions.length || body.answers.length !== questions.length || body.answers.some((answer, index) => !Number.isInteger(Number(answer)) || Number(answer) < 0 || Number(answer) >= (Array.isArray(questions[index]?.options) ? questions[index].options.length : 0))) return json(res, { success: false, error: "Please select a valid answer for every question before submitting." }, 400);
      let score = 0;
      const review = questions.map((question, index) => {
        const selected = Number(body.answers[index]);
        const correct = Number(question.correctIndex);
        const isCorrect = Number.isInteger(selected) && selected === correct;
        if (isCorrect) score++;
        return {
          question: String(question.text || ""),
          options: Array.isArray(question.options) ? question.options : [],
          selectedIndex: Number.isInteger(selected) ? selected : -1,
          correctIndex: correct,
          correct: isCorrect
        };
      });
      const total = questions.length;
      const percentage = Math.round(score / total * 100);
      const attemptRef = db.collection("quizAttempts").doc();
      await attemptRef.set({
        quizId, courseId: String(quiz.courseId || ""), studentUid: decoded.uid,
        studentName: String(user.fullName || decoded.name || decoded.email || "Student").slice(0, 120),
        quizTitle: String(quiz.title || "Quiz").slice(0, 160),
        answers: review.map(item => item.selectedIndex),
        score, total, percentage,
        submittedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      return json(res, {
        success: true,
        attemptId: attemptRef.id, score, total, percentage,
        review
      });
    }

    if (action === "quiz-results") {
      if (!staff) return json(res, { success: false, error: "Only administrators and instructors can review quiz results." }, 403);
      if (!quizId) return json(res, { success: false, error: "Choose a quiz." }, 400);
      const quizSnap = await db.collection("quizzes").doc(quizId).get();
      if (!quizSnap.exists) return json(res, { success: false, error: "Quiz not found." }, 404);
      const quiz = quizSnap.data() || {};
      const permission = await canManageCourse(String(quiz.courseId || ""));
      if (!permission.ok) return json(res, { success: false, error: permission.error }, 403);
      const attemptsSnap = await db.collection("quizAttempts").where("quizId", "==", quizId).limit(300).get();
      const attempts = attemptsSnap.docs.map(item => {
        const value = item.data() || {};
        return {
          id: item.id, studentName: String(value.studentName || "Student"),
          score: Number(value.score || 0), total: Number(value.total || 0),
          percentage: Number(value.percentage || 0),
          submittedAt: value.submittedAt?.toDate ? value.submittedAt.toDate().toISOString() : null
        };
      }).sort((a, b) => String(b.submittedAt || "").localeCompare(String(a.submittedAt || "")));
      return json(res, { success: true, quizTitle: String(quiz.title || "Quiz"), attempts });
    }
    return json(res, { success: false, error: "Unknown quiz action." }, 400);
  } catch (e) {
    error(e?.stack || String(e));
    const message = e instanceof Error ? e.message : "Quiz request failed.";
    return json(res, { success: false, error: message || "Quiz request failed." }, 400);
  }
}


// S I A BUSINESS bridge routes. These are deliberately separate from the
// lesson-upload, lesson-media, quiz, notification and course-progress handlers.
const SIA_BUSINESS_ID = "7RqIYO3IDSVCYex1LsDo6rDw5V33";
const SIA_CATALOGUE_PREFIX = "sia-stock-";

function getSiaFirebase() {
  const raw = process.env.SIA_BUSINESS_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("Missing SIA_BUSINESS_SERVICE_ACCOUNT_JSON.");
  let app;
  try { app = admin.app("sia-business-bridge"); }
  catch {
    app = admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) }, "sia-business-bridge");
  }
  return { auth: admin.auth(app), db: admin.firestore(app) };
}

async function verifySiaBusinessAdmin(token) {
  const { auth, db } = getSiaFirebase();
  let decoded;
  try { decoded = await auth.verifyIdToken(token); }
  catch { return { error: "Your Smart Business Manager sign-in has expired. Please sign in again." }; }
  const member = await db.doc("businesses/" + SIA_BUSINESS_ID + "/members/" + decoded.uid).get();
  if (!member.exists || member.data()?.active !== true || member.data()?.role !== "admin") {
    return { error: "Only the approved S I A Business administrator can publish stock to the website." };
  }
  return { auth, db, decoded };
}

async function verifyWebsiteAdmin(token) {
  const { auth, db } = getFirebase();
  let decoded;
  try { decoded = await auth.verifyIdToken(token); }
  catch { return { error: "Your website sign-in has expired. Please sign in again." }; }
  const profile = await db.collection("users").doc(decoded.uid).get();
  const user = profile.exists ? profile.data() || {} : {};
  if (user.role !== "admin" || user.status !== "approved") {
    return { error: "Only an approved website administrator can confirm customer orders." };
  }
  return { auth, db, decoded };
}


async function handleSiaAdminSso({ req, res, error }) {
  try {
    if (req.method === "OPTIONS") return res.text("", 204, headers());
    if (req.method !== "POST") return json(res, { success: false, error: "Use POST." }, 405);
    const token = bearer(req);
    if (!token) return json(res, { success: false, error: "Please sign in to the website first." }, 401);

    // Verify the website identity and approved admin role before looking up the matching
    // active Business Owner account in the separate Smart Business Manager Firebase project.
    const website = await verifyWebsiteAdmin(token);
    if (website.error) return json(res, { success: false, error: website.error }, 403);
    const email = String(website.decoded.email || "").trim().toLowerCase();
    if (!email) {
      return json(res, { success: false, error: "Your website administrator account must have an email address." }, 403);
    }

    const sia = getSiaFirebase();
    const memberCollection = sia.db.collection("businesses").doc(SIA_BUSINESS_ID).collection("members");
    // Match email case-insensitively without requiring a composite Firestore index.
    const [exactMatches, lowerMatches] = await Promise.all([
      memberCollection.where("email", "==", website.decoded.email).limit(5).get(),
      memberCollection.where("email", "==", email).limit(5).get()
    ]);
    const candidates = new Map();
    [...exactMatches.docs, ...lowerMatches.docs].forEach(doc => candidates.set(doc.id, doc));
    const admins = [...candidates.values()].filter(doc => {
      const member = doc.data() || {};
      return String(member.email || "").trim().toLowerCase() === email &&
        member.active === true && member.role === "admin";
    });
    if (admins.length !== 1) {
      return json(res, { success: false, error: "Your website admin email must match exactly one active Business Owner account in Smart Business Manager. No account details have been changed." }, 403);
    }
    const memberDoc = admins[0];
    const customToken = await sia.auth.createCustomToken(memberDoc.id, {
      businessId: SIA_BUSINESS_ID,
      role: "admin",
      ssoSource: "sia-digital-vision"
    });
    return json(res, { success: true, customToken });
  } catch (e) {
    error(e?.stack || String(e));
    return json(res, { success: false, error: "One-login could not be started securely. Please use your normal Business Manager login for now." }, 500);
  }
}

async function handleSiaSyncStock({ req, res, error }) {
  try {
    if (req.method === "OPTIONS") return res.text("", 204, headers());
    if (req.method !== "POST") return json(res, { success: false, error: "Use POST." }, 405);
    const token = bearer(req);
    if (!token) return json(res, { success: false, error: "Please sign in to Smart Business Manager." }, 401);
    const verified = await verifySiaBusinessAdmin(token);
    if (verified.error) return json(res, { success: false, error: verified.error }, 403);
    const body = req.bodyJson || {};
    const itemId = String(body.itemId || "").trim();
    const name = String(body.name || "").trim().slice(0, 120);
    const quantity = Number(body.quantity);
    const sellingPrice = Number(body.sellingPrice);
    const lowStockAt = Math.max(0, Math.floor(Number(body.lowStockAt ?? 5) || 0));
    const active = body.active !== false;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,140}$/.test(itemId) ||
        (active && !name) || !Number.isInteger(quantity) || quantity < 0 ||
        !Number.isFinite(sellingPrice) || sellingPrice < 0) {
      return json(res, { success: false, error: "The stock details are invalid." }, 400);
    }
    const { db } = getFirebase();
    const catalogueId = SIA_CATALOGUE_PREFIX + itemId;
    const availability = quantity <= 0 ? "Out of stock" : quantity <= lowStockAt ? "Low stock" : "In stock";
    const projection = {
      name: name || "Unavailable product",
      type: "product",
      category: "Accessories Sales",
      description: "Available from S I A TECH PRINT MEDIA.",
      price: sellingPrice,
      pricePerPage: null,
      resellerPrice: null,
      pricingMethod: "fixed",
      imageData: null,
      imageGallery: [],
      availability,
      stockTracked: true,
      stockQuantity: quantity,
      lowStockThreshold: lowStockAt,
      active,
      sourceSystem: "sia-business",
      sourceCollection: "stock",
      sourceItemId: itemId,
      sourceBusinessId: SIA_BUSINESS_ID,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };
    const ref = db.collection("catalogueItems").doc(catalogueId);
    const existing = await ref.get();
    const previous = existing.exists ? existing.data() || {} : {};
    // Preserve customer-facing photos and catalogue descriptions if the owner
    // has already added them; inventory values always come from Smart Business Manager.
    projection.category = String(previous.category || projection.category);
    projection.description = String(previous.description || projection.description);
    projection.imageData = previous.imageData || null;
    projection.imageGallery = Array.isArray(previous.imageGallery) ? previous.imageGallery : [];
    if (!existing.exists) projection.createdAt = admin.firestore.FieldValue.serverTimestamp();
    await ref.set(projection, { merge: true });
    return json(res, { success: true, catalogueItemId: catalogueId, active, availability });
  } catch (e) {
    error(e?.stack || String(e));
    return json(res, { success: false, error: "Stock could not be synchronised with the website. Please try again." }, 500);
  }
}

async function handleSiaConfirmOrder({ req, res, error }) {
  try {
    if (req.method === "OPTIONS") return res.text("", 204, headers());
    if (req.method !== "POST") return json(res, { success: false, error: "Use POST." }, 405);
    const token = bearer(req);
    if (!token) return json(res, { success: false, error: "Please sign in as the website administrator." }, 401);
    const website = await verifyWebsiteAdmin(token);
    if (website.error) return json(res, { success: false, error: website.error }, 403);
    const orderId = String((req.bodyJson || {}).orderId || "").trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,140}$/.test(orderId)) {
      return json(res, { success: false, error: "A valid order ID is required." }, 400);
    }
    const websiteOrderRef = website.db.collection("serviceOrders").doc(orderId);
    const orderSnap = await websiteOrderRef.get();
    if (!orderSnap.exists) return json(res, { success: false, error: "Customer order not found." }, 404);
    const order = orderSnap.data() || {};
    if (order.orderType !== "Product" || !order.catalogueItemId) {
      return json(res, { success: false, error: "This order is not a stock product order." }, 400);
    }
    const catalogueRef = website.db.collection("catalogueItems").doc(String(order.catalogueItemId));
    const catalogueSnap = await catalogueRef.get();
    if (!catalogueSnap.exists) return json(res, { success: false, error: "The ordered catalogue item no longer exists." }, 404);
    const catalogue = catalogueSnap.data() || {};
    if (catalogue.sourceSystem !== "sia-business" ||
        catalogue.sourceBusinessId !== SIA_BUSINESS_ID ||
        catalogue.sourceCollection !== "stock" ||
        !catalogue.sourceItemId) {
      return json(res, { success: false, error: "This product is not linked to Smart Business Manager stock." }, 400);
    }
    if (order.stockDeducted === true) {
      return json(res, { success: true, alreadyProcessed: true, message: "This order has already been recorded in business stock." });
    }

    const sia = getSiaFirebase();
    const stockRef = sia.db.doc("businesses/" + SIA_BUSINESS_ID + "/stock/" + catalogue.sourceItemId);
    const saleRef = sia.db.doc("businesses/" + SIA_BUSINESS_ID + "/transactions/website-order-" + orderId);
    const quantity = Math.max(1, Math.floor(Number(order.quantity || 1)));
    const unitPrice = Number(order.unitPrice ?? catalogue.price ?? 0);
    if (!Number.isFinite(unitPrice) || unitPrice < 0) {
      return json(res, { success: false, error: "The order price is invalid." }, 400);
    }

    const saleResult = await sia.db.runTransaction(async tx => {
      const [saleSnap, stockSnap] = await Promise.all([tx.get(saleRef), tx.get(stockRef)]);
      if (!stockSnap.exists) throw new Error("The linked stock item no longer exists in Smart Business Manager.");
      const stock = stockSnap.data() || {};
      if (saleSnap.exists) {
        return { remaining: Number(stock.quantity || 0), alreadyRecorded: true };
      }
      const available = Math.max(0, Math.floor(Number(stock.quantity || 0)));
      if (available < quantity) throw new Error("INSUFFICIENT_STOCK: only " + available + " unit(s) remain.");
      const unitCost = Math.max(0, Number(stock.buyingPrice || 0));
      const total = quantity * unitPrice;
      const cost = quantity * unitCost;
      const remaining = available - quantity;
      tx.update(stockRef, {
        quantity: remaining,
        lastSaleTxId: saleRef.id,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedBy: website.decoded.uid
      });
      tx.create(saleRef, {
        itemId: catalogue.sourceItemId,
        itemName: String(stock.name || catalogue.name || "Product").slice(0, 120),
        quantity,
        unitPrice,
        unitCost,
        total,
        cost,
        profit: total - cost,
        customerName: String(order.customerName || "Website customer").slice(0, 100),
        customerPhone: String(order.customerPhone || "").slice(0, 30),
        workerUid: website.decoded.uid,
        workerName: "Website Order",
        type: "sale",
        sourceType: "website_order",
        sourceId: orderId,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        date: new Date().toISOString().slice(0, 10)
      });
      return { remaining, alreadyRecorded: false };
    });

    const remaining = saleResult.remaining;
    const threshold = Math.max(0, Number(catalogue.lowStockThreshold ?? 3));
    const availability = remaining <= 0 ? "Out of stock" : remaining <= threshold ? "Low stock" : "In stock";
    await website.db.runTransaction(async tx => {
      const [latestOrder, latestCatalogue] = await Promise.all([tx.get(websiteOrderRef), tx.get(catalogueRef)]);
      if (!latestOrder.exists) throw new Error("Customer order no longer exists.");
      if (latestOrder.data()?.stockDeducted === true) return;
      tx.update(catalogueRef, { stockQuantity: remaining, availability, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      tx.update(websiteOrderRef, {
        status: "approved",
        statusUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
        statusHistory: admin.firestore.FieldValue.arrayUnion({ status: "approved", updatedAt: new Date().toISOString() }),
        stockDeducted: true,
        stockDeductedQuantity: quantity,
        stockDeductedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    });
    return json(res, {
      success: true,
      alreadyProcessed: saleResult.alreadyRecorded,
      quantityDeducted: quantity,
      remaining,
      message: "Order approved and recorded in Smart Business Manager."
    });
  } catch (e) {
    error(e?.stack || String(e));
    const message = e instanceof Error ? e.message : "Order confirmation failed.";
    return json(res, { success: false, error: message.startsWith("INSUFFICIENT_STOCK:") ? message : "The order could not be recorded in Smart Business Manager. Please try again." }, message.startsWith("INSUFFICIENT_STOCK:") ? 409 : 500);
  }
}

export default async (context) => {
  if (context.req.query?.action === "sia-admin-sso") return handleSiaAdminSso(context);
  if (context.req.query?.action === "sia-sync-stock") return handleSiaSyncStock(context);
  if (context.req.query?.action === "sia-confirm-order") return handleSiaConfirmOrder(context);
  if (context.req.query?.action === "quiz-list" || context.req.query?.action === "quiz-get" || context.req.query?.action === "quiz-create" || context.req.query?.action === "quiz-update" || context.req.query?.action === "quiz-delete" || context.req.query?.action === "quiz-submit" || context.req.query?.action === "quiz-results") return handleQuizzes(context);
  if (context.req.query?.action === "course-progress" || context.req.query?.action === "complete-lesson") return handleCourseProgress(context);
  if (context.req.query?.action === "admin-notifications" || context.req.query?.action === "registration-notification" || context.req.query?.action === "mark-notification-read") return handleAdminNotifications(context);
  if (context.req.method === "GET" && context.req.query?.action === "storage-usage") return handleStorageUsage(context);
  if (context.req.method === "GET") return handleMedia(context);
  return handleUpload(context);
};
