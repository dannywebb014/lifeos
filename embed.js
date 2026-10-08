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

// A stand-in for `document`, so an app written for a page of its own runs in
// its shadow root unchanged: `const document = docFor(ctx)` at the top of
// its mount(). Lookups (getElementById, querySelector…) search the app's
// root; body is the app's page element; listeners go on the real document
// (and come off at unmount), and key presses reach the app only while it's
// on screen, with e.target the element really pressed in (not the app's box).
// Everything else is the real document.
const KEYS = new Set(["keydown", "keyup", "keypress"]);
export function docFor({ root, host, active }) {
  const real = document;
  const added = [];
  const unwrap = (e) => new Proxy(e, {
    get: (t, k) => {
      if (k === "target") return t.composedPath()[0] || t.target;
      const v = Reflect.get(t, k, t);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  const doc = new Proxy(real, {
    get(t, k) {
      switch (k) {
        case "getElementById": return (id) => root.getElementById(id);
        case "querySelector": return (sel) => root.querySelector(sel);
        case "querySelectorAll": return (sel) => root.querySelectorAll(sel);
        case "getElementsByClassName": return (c) => root.querySelectorAll(`.${c}`);
        case "body": return root.querySelector(".page") || root;
        case "documentElement": return host;
        case "activeElement": return root.activeElement || null;
        // For the app's unmount: takes off every listener it added.
        case "off": return () => { for (const [type, wrapped, opts] of added.splice(0)) real.removeEventListener(type, wrapped, opts); };
        case "addEventListener": return (type, fn, opts) => {
          const wrapped = KEYS.has(type)
            ? (e) => { if (active()) return (typeof fn === "function" ? fn : fn.handleEvent.bind(fn))(unwrap(e)); }
            : fn;
          real.addEventListener(type, wrapped, opts);
          added.push([type, wrapped, opts, fn]);
        };
        case "removeEventListener": return (type, fn, opts) => {
          const i = added.findIndex(x => x[0] === type && x[3] === fn);
          if (i >= 0) { real.removeEventListener(type, added[i][1], opts); added.splice(i, 1); }
        };
        default: {
          const v = Reflect.get(t, k, t);
          return typeof v === "function" ? v.bind(t) : v;
        }
      }
    },
    set(t, k, v) { if (k === "title") return true; return Reflect.set(t, k, v, t); },
  });
  return doc;
}

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
