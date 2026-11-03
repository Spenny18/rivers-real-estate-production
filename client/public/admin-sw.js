// The admin's service worker: shows push notifications (server/push.ts) and
// opens the right page when one is tapped. Nothing is cached here: the admin
// always loads fresh from the server.
//
// Registered by the admin shell with scope /admin, so it never touches the
// public site.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: "Rivers Admin", body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "Rivers Admin";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "",
      tag: data.tag || undefined,
      renotify: !!data.tag,
      icon: "/favicon-192x192.png",
      badge: "/favicon-96x96.png",
      data: { url: data.url || "/admin/dashboard" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || "/admin/dashboard", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if (new URL(w.url).pathname.startsWith("/admin") && "focus" in w) {
          return w.focus().then((f) => (f && "navigate" in f ? f.navigate(url) : f));
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
