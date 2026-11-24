const CACHE_NAME = "mtr-app-shell-v1";
const SHELL = ["./", "./index.html"];
self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith("mtr-") && key !== CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  const isAppNavigation = request.mode === "navigate" && url.origin === self.location.origin;
  const isStaticAsset = ["script", "style", "font", "worker"].includes(request.destination);
  if (!isAppNavigation && !isStaticAsset) return;
  if (url.pathname.includes("/firestore/") || url.hostname.includes("appwrite") || url.hostname.includes("paychangu")) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    if (isAppNavigation) {
      try {
        const fresh = await fetch(request);
        if (fresh && fresh.ok) cache.put(request, fresh.clone());
        return fresh;
      } catch (_) {
        return (await cache.match(request)) || (await cache.match("./index.html")) || new Response("Offline. Open the app after reconnecting once to cache its latest version.", {status: 503, headers: {"Content-Type": "text/plain"}});
      }
    }
    const cached = await cache.match(request);
    const network = fetch(request).then(response => {
      if (response && (response.ok || response.type === "opaque")) cache.put(request, response.clone());
      return response;
    }).catch(() => cached);
    return cached || await network || new Response("", {status: 504});
  })());
});
