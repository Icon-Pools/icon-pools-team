// Service worker: lets the app install and open even with a weak signal.
// It always tries the network first, so new versions show up right away,
// and falls back to the saved copy when offline. Database calls are never cached.
const CACHE = "ipt-v6";
const SHELL = ["./", "index.html", "app.js", "construction.js", "ann.js", "notify.js", "config.js", "board.html", "manifest.webmanifest",
               "icon-192.png", "icon-512.png", "apple-touch-icon.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// A new announcement arrived (sent by the notify-announcement function): show it.
self.addEventListener("push", e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) { d = { body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "Icon Pools", {
    body: d.body || "", icon: "icon-192.png", badge: "icon-192.png", data: { tab: d.tab || "home" }
  }));
});

// Tapping it opens the app on that department's announcements.
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const tab = (e.notification.data && e.notification.data.tab) || "home";
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    for (const c of list) {
      if ("focus" in c) { c.postMessage({ openTab: tab }); return c.focus(); }
    }
    return self.clients.openWindow(new URL("./?tab=" + encodeURIComponent(tab), self.registration.scope).href);
  }));
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then(hit => hit ||
      (req.mode === "navigate" ? caches.match("index.html") : Response.error())))
  );
});
