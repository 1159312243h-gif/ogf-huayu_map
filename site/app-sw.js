/* Installation support only. Live maps, account APIs and snapshots keep their own caches. */
"use strict";
const CACHE = "huayu-install-v1";
const OFFLINE = "/app-offline.html";
const FILES = [OFFLINE, "/app-icons/icon-192.png", "/app-icons/icon-512.png"];
self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys
    .filter(key => key.startsWith("huayu-install-") && key !== CACHE)
    .map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", event => {
  const request = event.request, url = new URL(request.url);
  if(request.method==="GET" && url.origin===self.location.origin && FILES.includes(url.pathname)) {
    event.respondWith(caches.open(CACHE).then(async cache => (await cache.match(url.pathname)) || fetch(request)));
    return;
  }
  // Never store or intercept authentication, uploads, downloads, models or live data.
  if (request.method !== "GET" || url.origin !== self.location.origin
    || request.mode !== "navigate" || url.pathname.startsWith("/api/")) return;
  event.respondWith(fetch(request).catch(async () =>
    (await caches.open(CACHE)).match(OFFLINE).then(response => response
      || new Response("网络连接不可用，请联网后重新打开华域地图。", {
        status: 503, headers: {"Content-Type": "text/plain; charset=utf-8"}
      }))));
});
