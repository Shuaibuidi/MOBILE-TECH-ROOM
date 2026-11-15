import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function reply(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return reply({ error: "POST requests only." }, 405);
  }

  try {
    const apiKey = Deno.env.get("FIREBASE_WEB_API_KEY");
    const projectId = Deno.env.get("FIREBASE_PROJECT_ID");
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!apiKey || !projectId || !supabaseUrl || !serviceKey) {
      return reply({ error: "Server configuration is incomplete." }, 500);
    }

    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "");

    if (!token || token === authHeader) {
      return reply({ error: "Sign in is required." }, 401);
    }

    const identityResponse = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken: token }),
      },
    );

    if (!identityResponse.ok) {
      return reply({ error: "Your login could not be verified." }, 401);
    }

    const identity = await identityResponse.json();
    const uid = identity.users?.[0]?.localId;

    if (!uid) {
      return reply({ error: "Invalid account." }, 401);
    }

    const firestoreBase =
      `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;

    const userResponse = await fetch(`${firestoreBase}/users/${uid}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!userResponse.ok) {
      return reply({ error: "Could not verify your account profile." }, 403);
    }

    const userDocument = await userResponse.json();
    const fields = userDocument.fields || {};
    const role = fields.role?.stringValue;
    const status = fields.status?.stringValue;

    if (status !== "approved" || !["admin", "instructor"].includes(role)) {
      return reply({ error: "Only approved staff can upload." }, 403);
    }

    const form = await req.formData();
    const file = form.get("file");
    const courseId = String(form.get("courseId") || "").trim();

    if (!(file instanceof File) || !courseId) {
      return reply({ error: "A file and course ID are required." }, 400);
    }

    if (file.size <= 0 || file.size > 25 * 1024 * 1024) {
      return reply({ error: "File must be smaller than 25 MB." }, 400);
    }

    const allowedTypes = [
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/gif",
      "video/mp4",
      "video/webm",
      "application/pdf",
      "audio/mpeg",
      "audio/wav",
      "audio/x-wav",
      "audio/mp4",
      "audio/x-m4a",
      "audio/ogg",
      "audio/webm",
      "audio/aac",
    ];

    if (!allowedTypes.includes(file.type)) {
      return reply({ error: "Choose an image, video, audio or PDF file in a supported format." }, 400);
    }

    const courseResponse = await fetch(
      `${firestoreBase}/courses/${encodeURIComponent(courseId)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    if (!courseResponse.ok) {
      return reply({ error: "Course not found or access denied." }, 403);
    }

    const courseDocument = await courseResponse.json();
    const courseOwner = courseDocument.fields?.createdBy?.stringValue;

    if (role === "instructor" && courseOwner !== uid) {
      return reply({ error: "Instructors can upload only to their own courses." }, 403);
    }

    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-100);
    const objectPath = `${courseId}/${uid}/${crypto.randomUUID()}-${safeName}`;

    const supabase = createClient(supabaseUrl, serviceKey);

    const { error: uploadError } = await supabase.storage
      .from("lesson-media")
      .upload(objectPath, file, {
        contentType: file.type,
        upsert: false,
      });

    if (uploadError) {
      return reply({ error: "Upload failed: " + uploadError.message }, 500);
    }

    const { data } = supabase.storage
      .from("lesson-media")
      .getPublicUrl(objectPath);

    return reply({
      success: true,
      mediaUrl: data.publicUrl,
      fileName: safeName,
      contentType: file.type,
    });
  } catch (error) {
    console.error(error);
    return reply({ error: "Upload could not be completed." }, 500);
  }
});
