// Firebase Cloud Messaging service worker (background push delivery).
// This is a SEPARATE service worker from /sw.js — Firebase looks for
// it at this exact path. Does not interfere with the main SW because
// each registers its own scope.
importScripts('https://www.gstatic.com/firebasejs/12.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/12.12.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyAQ7vikZutCQfAaXybQnJcfgnlqpXxHTr4",
  authDomain: "teebox-market.firebaseapp.com",
  projectId: "teebox-market",
  storageBucket: "teebox-market.firebasestorage.app",
  messagingSenderId: "982122063122",
  appId: "1:982122063122:web:416617dcacf912c907bfcb",
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  const title = (payload.notification && payload.notification.title) || 'TeeBox';
  const body  = (payload.notification && payload.notification.body)  || '';
  const data  = payload.data || {};
  self.registration.showNotification(title, {
    body,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data,
    tag: data.notificationId || undefined,
  });
});

// Click action — focus an open TeeBox tab or open a fresh one,
// deep-linking to the listing if we have an ID.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const target = data.listingId
    ? `/?listing=${encodeURIComponent(data.listingId)}`
    : '/';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({type: 'window', includeUncontrolled: true});
    for (const c of all) {
      if (c.url.includes(self.location.origin)) {
        c.navigate(target);
        return c.focus();
      }
    }
    if (self.clients.openWindow) await self.clients.openWindow(target);
  })());
});
