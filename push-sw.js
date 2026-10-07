// lifeOS's service worker, for notifications only: it shows each one sent by
// send-reminders and opens the right app when one is tapped. It has no fetch
// handler, so it never touches how pages load.
// Registered by connections. (scope /lifeos/) when notifications are turned on.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data?.text() || "" }; }
  // iPhone needs every push to show something, so there's always a title.
  e.waitUntil(self.registration.showNotification(d.title || "lifeOS.", {
    body: d.body || "",
    tag: d.tag || undefined,
    icon: "/lifeos/icon-192.png",
    badge: "/lifeos/icon-192.png",
    data: { url: d.url || "/lifeos/" },
  }));
});

// Tapping one: an open lifeOS. switches to the app ("?app=cal"); otherwise
// lifeOS opens at that address.
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || "/lifeos/", self.location.origin);
  e.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const home = open.find(c => new URL(c.url).pathname === "/lifeos/");
    if (home) {
      await home.focus();
      home.postMessage({ lifeosOpen: url.searchParams.get("app") });
      return;
    }
    await self.clients.openWindow(url.href);
  })());
});
