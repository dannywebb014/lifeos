// ─── Apps inside the lifeOS page, not in frames ─────────────────────
//
// An app that has an embed module (APPS[].embed in lifeos/index.html) runs in
// the lifeOS page itself, in its own shadow root, so its styles, ids and
// markup can't touch the picker's or another app's. It shares the page's one
// Supabase client (auth.js), so there is one sign-in check and one connection
// however many apps are open.
//
// An embed module exports mount(ctx), which fills ctx.root and may return
// { message(data), shown(), unmount() }. ctx:
//   root      the app's shadow root: getElementById, querySelector, append …
//   host      the element holding it (lifeOS shows and hides this)
//   url       a URL: the app's own address, with any ?query or #hash it was opened with
//   supabase  the shared client
//   active()  true while the app is the one on screen (gate keyboard shortcuts on it)
//   asset(p)  a URL for one of the app's own files, relative to the module
//
//   hostApp(app, url) / attach(host, app): for lifeOS. An element that stands in for an iframe:
//     .src (set to open another address in the app, or the same one to reload),
//     .contentWindow.postMessage(data) (handed to the app's message()),
//     and classes "on" / "ready" as the frames have.
//   standalone(moduleUrl): for the app's own page, filling the whole window.

import { supabase } from "./auth.js";

// The app's stylesheet and markup, fetched once each and kept (the service
// worker keeps them for offline too).
const files = new Map();
export function loadFile(url) {
  if (!files.has(url)) files.set(url, fetch(url).then(r => { if (!r.ok) throw new Error(`${url}: ${r.status}`); return r.text(); }));
  return files.get(url);
}

// Fills a shadow root with the app's stylesheet (a <link>, so it is cached)
// and markup, ready for its script.
export async function fill(root, { css, html }) {
  const markup = html ? await loadFile(html) : "";
  root.innerHTML = `${css ? `<link rel="stylesheet" href="${css}">` : ""}${markup}`;
  // Don't show the app unstyled: wait for its stylesheet.
  const link = root.querySelector("link[rel=stylesheet]");
  if (link && !link.sheet) await new Promise(r => { link.onload = link.onerror = r; });
}

// An app's own file, carrying its module's ?v= so a new release fetches it fresh.
function withVersion(p, base) {
  const u = new URL(p, base);
  if (!u.search) u.search = base.search;
  return u.href;
}

export function hostApp(app, url) {
  const host = document.createElement("div");
  host.className = "app-host";
  host.title = `${app.name}.`;
  host.src = url || app.url;
  return attach(host, app);
}

// The same, on an element lifeOS has already made and put in place (its frame
// code runs before modules load): it keeps any address given to .src so far.
export function attach(host, app) {
  host.dataset.app = app.id;
  const root = host.attachShadow({ mode: "open" });
  let current = host.src || app.url;
  delete host.src;
  let handle = null;
  let run = 0;

  async function start() {
    const mine = ++run;
    try { handle?.unmount?.(); } catch (err) { console.error(`${app.name}: unmount`, err); }
    handle = null;
    host.classList.remove("ready");
    root.replaceChildren();
    try {
      const mod = await import(app.embed);
      if (mine !== run) return;
      const base = new URL(app.embed, location.href);
      handle = (await mod.mount({
        root, host, supabase,
        url: new URL(current, location.origin),
        active: () => host.classList.contains("on") && document.body.classList.contains("open"),
        asset: (p) => withVersion(p, base),
      })) || null;
    } catch (err) {
      console.error(`${app.name} couldn’t start:`, err);
      root.innerHTML = `<p style="font:16px system-ui;padding:40px 24px;text-align:center">${app.name}. couldn’t start. Close it and try again.</p>`;
    }
    if (mine === run) host.classList.add("ready");
  }

  Object.defineProperty(host, "src", { get: () => current, set: (u) => { current = u; start(); } });
  Object.defineProperty(host, "contentWindow", {
    get: () => ({ postMessage: (data) => { try { data?.lifeosShown ? handle?.shown?.() : handle?.message?.(data); } catch (err) { console.error(err); } } }),
  });
  host.unmount = () => { run++; try { handle?.unmount?.(); } catch { /* going anyway */ } };
  start();
  return host;
}

// The app on its own page: a shadow root filling the window.
export async function standalone(moduleUrl) {
  const host = document.createElement("div");
  host.className = "app-host";
  host.style.cssText = "position:fixed;inset:0;overflow:auto;-webkit-overflow-scrolling:touch";
  document.body.append(host);
  const root = host.attachShadow({ mode: "open" });
  const mod = await import(moduleUrl);
  const base = new URL(moduleUrl, location.href);
  return mod.mount({ root, host, supabase, url: new URL(location.href), active: () => true, asset: (p) => withVersion(p, base) });
}
