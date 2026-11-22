// sw.js - gjør siden tilgjengelig uten nett (kjølerom og låve har ofte dårlig dekning)
const CACHE = 'dg-v25';
const FILES = ['./', 'index.html', 'style.css', 'app.js', 'protocol.js', 'logic.js', 'i18n.js', 'ameter.js', 'license.js', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

// Nett først, buffer hvis nettet mangler. Da får brukeren alltid nyeste versjon når det er dekning.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  // Firmware og byggeinfo går alltid rett til nettet. Gammel firmware fra
  // bufferen må aldri brukes til oppdatering.
  const path = new URL(e.request.url).pathname;
  if (path.includes('/firmware/') || path.endsWith('/build.json')) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
