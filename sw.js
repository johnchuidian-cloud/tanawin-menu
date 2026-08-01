// Tanawin Menu — minimal service worker.
//
// It exists for ONE reason: Android Chrome refuses `new Notification(...)`
// ("Illegal constructor") and will only raise a system notification through a
// service-worker registration. The staff dashboard registers this so order
// alerts reach the phone's notification shade while the tab is backgrounded.
//
// Deliberately NO fetch handler: nothing is intercepted or cached, so this can
// never pin the site to a stale build (the whole app is served fresh by
// Cloudflare). Push subscriptions aren't set up either — alerts only fire while
// the dashboard is open somewhere.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

// Tapping the notification jumps to the already-open dashboard if there is one.
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const dash = open.find(c => c.url.includes('/staff'));
    if (dash) return dash.focus();
    return self.clients.openWindow('/staff');
  })());
});
