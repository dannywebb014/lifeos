// Google Calendar through the google-auth function: connect once, then the
// server hands out fresh one-hour tokens, so no app ever has to bounce
// through Google again to renew.
//
// The token still lives where every app reads it ("calendar.google":
// { token, expires, email }), plus `server: true` once the server holds the
// refresh token. The three Google modules (calhub/google.js,
// lifeos/google.js, taskhub/calendar.js) ask freshToken() before each call.

import { supabase } from "/lifeos/auth.js";

const KEY = "calendar.google";
const FN = "https://tvpmeysctvlhjyhotfyk.supabase.co/functions/v1/google-auth";

const read = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } };
const write = (v) => { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* private mode */ } };

export const isServer = () => Boolean(read().server);

async function call(action, extra = {}) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw Object.assign(new Error("Not signed in"), { status: 401 });
  const res = await fetch(FN, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify({ action, ...extra }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || `google-auth ${res.status}`), { status: res.status });
  return body;
}

// A new access token from the server, once at a time however many ask.
// Resolves with the token, or null when the server doesn't hold one (which
// also clears `server`, so the apps offer to connect again).
let inFlight = null;
export function refresh() {
  inFlight ||= (async () => {
    try {
      const t = await call("token");
      write({ ...read(), token: t.access_token, expires: Date.now() + ((t.expires_in || 3600) - 120) * 1000, email: t.email || read().email, server: true });
      return t.access_token;
    } catch (err) {
      if (err.status === 404) { write({ ...read(), token: null, expires: 0, server: false }); return null; }
      console.error("Renewing Google access:", err);
      return null;
    } finally { setTimeout(() => { inFlight = null; }, 0); }
  })();
  return inFlight;
}

// A token good for at least another minute, renewed from the server if needed.
export async function freshToken() {
  const a = read();
  if (a.token && a.expires > Date.now() + 60000) return a.token;
  if (a.server) return refresh();
  return a.token && a.expires > Date.now() ? a.token : null;
}

// Connecting: off to Google (through the function), back to `returnTo`.
// Throws if the server isn't set up, so callers can fall back to the old way.
export async function connect(returnTo = location.href) {
  const back = new URL(returnTo, location.href);
  back.hash = "";
  const { url } = await call("start", { return: back.toString(), hint: read().email || "" });
  (window.top || window).location.assign(url);
}

export async function disconnect() {
  try { await call("disconnect"); } catch (err) { console.error("Disconnecting Google:", err); }
  try { localStorage.removeItem(KEY); } catch { /* none */ }
}

// Keep the token topped up while a page is open, so the apps rarely wait.
if (!globalThis.__lifeosGoogleKeeper) {
  globalThis.__lifeosGoogleKeeper = true;
  const topUp = () => { const a = read(); if (a.server && (a.expires || 0) - Date.now() < 10 * 60000) refresh(); };
  topUp();
  setInterval(topUp, 5 * 60000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") topUp(); });
}
