/*
  Gesetzessammlung Web-App - Service Worker (Offline-Fähigkeit)
  Speichert die Programmdateien auf dem Gerät. Die Gesetzestexte liegen nicht hier, sondern in IndexedDB.
  Nach jeder Änderung an den Programmdateien: CacheName erhöhen, damit iPhone/iPad die neue Fassung laden.
*/
const CacheName = "Gesetzessammlung-4";
const Files = ["./", "index.html", "app.css", "app.js", "manifest.json", "icon-180.png", "icon-512.png"];

self.addEventListener("install", E => {
  E.waitUntil(caches.open(CacheName).then(Cache => Cache.addAll(Files)));
  self.skipWaiting();
});

self.addEventListener("activate", E => {
  // alte Fassungen löschen
  E.waitUntil(caches.keys().then(Keys =>
    Promise.all(Keys.filter(Key => Key !== CacheName).map(Key => caches.delete(Key)))));
  self.clients.claim();
});

// Erst aus dem Speicher, sonst aus dem Netz
self.addEventListener("fetch", E => {
  E.respondWith(caches.match(E.request, { ignoreSearch: true }).then(Found => Found || fetch(E.request)));
});
