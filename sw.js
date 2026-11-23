// sw.js i roten: fjerner service workeren fra den gamle appen, som lå i roten
// før 2026-11-23. Appen ligger nå i /app/ og har sin egen service worker der.
// Telefoner som hadde appen fra roten, henter denne fila ved neste besøk,
// avregistrerer seg og laster siden på nytt fra nettet.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    await self.registration.unregister();
    const vinduer = await self.clients.matchAll({ type: 'window' });
    for (const c of vinduer) c.navigate(c.url);
  })());
});
