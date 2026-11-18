import Busboy from "busboy";
import { Readable } from "node:stream";
import crypto from "node:crypto";
import admin from "firebase-admin";
import { Client, ID, Permission, Role, Storage } from "node-appwrite";
import { InputFile } from "node-appwrite/file";

const APP_ORIGIN = "https://shuaibuidi.github.io";
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const ALLOWED_MIME = new Set([
  "image/jpeg", "image/png", "image/webp", "image/gif",
  "video/mp4", "video/webm", "application/pdf",
  "audio/mpeg", "audio/wav", "audio/x-wav", "audio/mp4",
  "audio/x-m4a", "audio/ogg", "audio/webm", "audio/aac"
]);

let firebaseReady = false;
function getFirebase() {
  if (!firebaseReady) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!raw) throw new Error("Missing FIREBASE_SERVICE_ACCOUNT_JSON.");
    const account = JSON.parse(raw);
    if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(account) });
    firebaseReady = true;
  }
  return { auth: admin.auth(), db: admin.firestore() };
}

function headers() {
  return {
    "Access-Control-Allow-Origin": APP_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
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

export default async ({ req, res, log, error }) => {
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
      return json(res, { success: false, error: "Unsupported file type. Choose JPG, PNG, WEBP, GIF, MP4, WEBM, PDF, MP3, WAV, M4A, OGG or AAC." }, 415);
    }

    const endpoint = process.env.APPWRITE_ENDPOINT;
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
      permissions: [Permission.read(Role.any())]
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
};
