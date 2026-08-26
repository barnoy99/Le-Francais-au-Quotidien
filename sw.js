/* Service worker — offline support.
   IMPORTANT: bump CACHE_VERSION on every deploy that changes assets,
   together with the ?v=N cache-busters in index.html. */
var CACHE_VERSION = 'v52';
var CACHE_NAME = 'quotidien-' + CACHE_VERSION;

var SHELL = [
  './',
  'index.html',
  'style.css?v=53',
  'app.js?v=69',
  'data.js?v=30',
  'firebase-config.js?v=3',
  'manifest.json',
  'icon-192.png',
  'icon-512.png'
];

// Cross-origin hosts we runtime-cache (fonts + Firebase SDK scripts).
// Firebase *data* (firebaseio.com) is never cached — the app falls back
// to localStorage on its own.
var RUNTIME_HOSTS = [
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'www.gstatic.com'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(SHELL);
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== CACHE_NAME) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  var url = new URL(req.url);

  // Navigations: network-first so updates arrive, cached shell offline.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE_NAME).then(function (c) { c.put('index.html', copy); });
        return res;
      }).catch(function () {
        return caches.match('index.html');
      })
    );
    return;
  }

  // Same-origin assets: cache-first (immutable thanks to ?v=N).
  if (url.origin === self.location.origin) {
    e.respondWith(
      caches.match(req).then(function (hit) {
        return hit || fetch(req).then(function (res) {
          var copy = res.clone();
          caches.open(CACHE_NAME).then(function (c) { c.put(req, copy); });
          return res;
        });
      })
    );
    return;
  }

  // Fonts / Firebase SDKs: stale-while-revalidate.
  if (RUNTIME_HOSTS.indexOf(url.hostname) !== -1) {
    e.respondWith(
      caches.match(req).then(function (hit) {
        var refresh = fetch(req).then(function (res) {
          var copy = res.clone();
          caches.open(CACHE_NAME).then(function (c) { c.put(req, copy); });
          return res;
        }).catch(function () { return hit; });
        return hit || refresh;
      })
    );
  }
  // Everything else (e.g. firebaseio.com data): straight to network.
});
