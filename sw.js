// Offline cache for the app's own files. Your entries are NOT here: they live in IndexedDB on the phone.
const VERSION = 'expenses-v1.2.2';
const FILES = [
  './', 'index.html', 'app.css', 'app.js', 'vendor/jszip.min.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png'
];

self.addEventListener('install', e => {
  // cache: 'reload' fetches every file fresh from the server. Without it the browser's own HTTP cache
  // (GitHub Pages: 10 minutes) could put an old app.js into the new version's cache.
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES.map(f => new Request(f, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then(hit => {
      if (hit) return hit;
      return fetch(req).catch(() => req.mode === 'navigate' ? caches.match('index.html') : Response.error());
    })
  );
});
