// sw.js - gjør siden tilgjengelig uten nett (kjølerom og låve har ofte dårlig dekning)
const CACHE = 'dg-v45';
const FILES = ['./', 'index.html', 'style.css', 'app.js', 'core.js', 'view.js', 'settingsui.js', 'ble.js', 'history.js', 'forecast.js', 'subscription.js', 'ota.js', 'demo.js', 'protocol.js', 'logic.js', 'i18n.js', 'ameter.js', 'license.js', 'order.js', 'sync.js', 'version.js', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

// Nett først, buffer hvis nettet mangler. Da får brukeren alltid nyeste versjon når det er dekning.
// cache: 'no-cache' (fra dg-v30): nettleserens egen HTTP-buffer (GitHub Pages: 10 min)
// spørres alltid mot serveren, så en ny versjon ikke blir liggende igjen.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;      // værvarsel o.l. går forbi
  // Firmware og byggeinfo går alltid rett til nettet. Gammel firmware fra
  // bufferen må aldri brukes til oppdatering.
  if (url.pathname.includes('/firmware/') || url.pathname.endsWith('/build.json')) return;
  const req = e.request.mode === 'navigate'
    ? new Request(e.request.url, { cache: 'no-cache', credentials: 'same-origin' })
    : new Request(e.request, { cache: 'no-cache' });
  e.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
