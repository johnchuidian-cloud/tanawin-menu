// Tanawin Menu — service worker for staff order alerts.
//
// Two jobs:
//   1. Raise notifications. Android Chrome refuses `new Notification(...)`
//      ("Illegal constructor"), so even the tab-is-open alerts go through
//      showNotification() here. `push` handles alerts with the app CLOSED.
//   2. Answer navigations when the network is down, which is what makes the
//      dashboard installable on Android (Chrome requires offline capability).
//
// Caching is deliberately limited to offline.html. App code (js/css/html) is
// ALWAYS fetched from the network, so a service worker can never pin staff to
// a stale build — the failure mode that bit this project before.

const OFFLINE_CACHE = 'tanawin-offline-v1';
const OFFLINE_URL = '/offline.html';

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    // NOT cache.add(): Cloudflare 307s /offline.html → /offline, and the Cache
    // API refuses to store a redirected response. Follow it ourselves and put
    // the final body under the key we look up.
    const res = await fetch(OFFLINE_URL, { cache: 'reload', redirect: 'follow' });
    const cache = await caches.open(OFFLINE_CACHE);
    await cache.put(OFFLINE_URL, new Response(await res.blob(), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== OFFLINE_CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

// Network-first, and ONLY for page navigations. Everything else is left alone
// (no respondWith → the browser fetches normally, nothing is cached).
self.addEventListener('fetch', event => {
  if (event.request.mode !== 'navigate') return;
  event.respondWith(
    fetch(event.request).catch(() => caches.match(OFFLINE_URL)),
  );
});

// An order arrived while the dashboard was closed or backgrounded.
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { /* keep defaults */ }
  const title = data.title || 'New order';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || 'Open the dashboard to see it.',
    icon: 'assets/icon-192.png',
    badge: 'assets/icon-192.png',
    tag: data.tag || 'order',
    renotify: true,
    requireInteraction: true,          // stays put until someone deals with it
    data: { url: data.url || '/staff' },
  }));
});

// Tapping the notification jumps to the already-open dashboard if there is one.
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || '/staff';
  event.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const dash = open.find(c => c.url.includes('/staff'));
    if (dash) return dash.focus();
    return self.clients.openWindow(url);
  })());
});
