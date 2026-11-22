/* ทำงานเฉพาะบน HTTPS หรือ localhost: เก็บหน้า Seat ไว้ให้เปิดได้ตอนเน็ตหลุด (network-first) */
const CACHE = 'seat-v1';
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(['/s', '/shared.js']))); self.skipWaiting(); });
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || !['/s', '/shared.js'].includes(u.pathname)) return;
  e.respondWith(fetch(e.request).then(r => { const cp = r.clone(); caches.open(CACHE).then(c => c.put(u.pathname, cp)); return r; })
    .catch(() => caches.match(u.pathname)));
});
