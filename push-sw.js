// lifeOS's service worker (scope /lifeos/: the picker, week., wish. and
// sign-in). It keeps their files on the device so they open fast and with no
// signal, shows each notification sent by send-reminders, and opens the right
// app when one is tapped. Registered by each of those pages, and by
// connections. when notifications are turned on.
const APP = "lifeos";
const CACHE = `${APP}-1`;

// ─── Opening fast, and with no signal ───────────────────────────────
// Pages come from the network when it answers within 2.5 seconds (so updates
// arrive), otherwise from the copy saved here. Scripts, styles, fonts and
// icons come from the saved copy at once and are refreshed behind it; their
// ?v= numbers make a new release a new file. Requests to Supabase, Google,
// Craft and Todoist aren't touched. Caches are named per app, as every app
// on this site shares one cache store.
const CDN = ["https://cdn.jsdelivr.net", "https://fonts.googleapis.com", "https://fonts.gstatic.com"];
const KEEP = 250;   // files kept per app; the oldest go first

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k.startsWith(`${APP}-`) && k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));

async function save(req, res) {
  if (!res || res.redirected || !(res.ok || res.type === "opaque")) return;
  const c = await caches.open(CACHE);
  await c.put(req, res);
  const keys = await c.keys();
  for (const k of keys.slice(0, Math.max(0, keys.length - KEEP))) await c.delete(k);
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin && !CDN.includes(url.origin)) return;

  if (req.mode === "navigate") {
    e.respondWith((async () => {
      // Saved without the #hash or ?query, so any address of the page finds it.
      const key = url.origin + url.pathname;
      const network = fetch(req).then((res) => {
        // A redirected page can't be handed back as it is (iPhone Safari won't
        // show it), so the browser is sent to where it ended up instead.
        if (res.redirected) return Response.redirect(res.url, 302);
        if (res.ok) save(key, res.clone());
        return res;
      });
      try {
        const res = await Promise.race([network, new Promise((r) => setTimeout(r, 2500))]);
        if (res) return res;
      } catch { /* offline */ }
      return (await caches.match(key)) || network;
    })());
    return;
  }

  e.respondWith((async () => {
    const cached = await caches.match(req);
    const fresh = fetch(req).then((res) => { save(req, res.clone()); return res; });
    if (cached) { e.waitUntil(fresh.catch(() => {})); return cached; }
    return fresh;
  })());
});


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
    // lifeOS: /lifeos/ on GitHub Pages; "/" or an app's word ("/tasks") on the lifeOS site.
    const SHELL = /^\/(lifeos\/|calendar|tasks|food|train|breathe|motivation|places|media|wish)?$/;
    const home = open.find(c => SHELL.test(new URL(c.url).pathname));
    if (home) {
      await home.focus();
      home.postMessage({ lifeosOpen: url.searchParams.get("app") });
      return;
    }
    await self.clients.openWindow(url.href);
  })());
});
