// calendar.'s Google sign-in, renewed from the lifeOS picker itself.
//
// calendar. keeps its Google token under "calendar.google" for an hour, and
// lifeOS (same site) reads it for today.'s calendar card. Rather than wait
// for calendar. to be opened, lifeOS can fetch a new one the way calendar.
// does: a trip through Google with prompt=none, which comes straight back
// with no screen while you're still signed in to Google in this browser.
// Google returns to /lifeos/ (already an authorised redirect URI, see
// calhub's connect()), and a state starting "lifeos:" marks the reply as
// lifeOS's own rather than calendar.'s or tasks.' (index.html sorts them).
//
// The client ID is calendar.'s ("calendar.settings"), or tasks.' if only
// that one is set.

const AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const SCOPE = "https://www.googleapis.com/auth/calendar";
const KEY = "calendar.google";
const STATE_KEY = "lifeos.oauthState";
const SILENT_KEY = "lifeos.silentTried";
export const STATE_PREFIX = "lifeos:";

const read = (k, fallback) => { try { return JSON.parse(localStorage.getItem(k)) ?? fallback; } catch { return fallback; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };

export const auth = () => read(KEY, {});
export const isConnected = () => { const a = auth(); return Boolean(a.token && a.expires > Date.now()); };
export const wasConnected = () => Boolean(auth().email);
export const email = () => auth().email || "";
export const minutesLeft = () => Math.max(0, Math.round(((auth().expires || 0) - Date.now()) / 60000));
export const silentTried = () => { try { return sessionStorage.getItem(SILENT_KEY) === "1"; } catch { return true; } };

export const clientId = () => read("calendar.settings", {}).clientId || read("tasks.settings", {}).google?.clientId || "";
export function setClientId(id) {
  write("calendar.settings", { ...read("calendar.settings", {}), clientId: String(id || "").trim() });
}

// `then` says what to show on the way back: "today" reopens today., "connections" the connections box.
export function connect({ silent = false, then = "" } = {}) {
  const id = clientId();
  if (!id) return false;
  const state = `${STATE_PREFIX}${then}:${crypto.randomUUID()}`;
  try {
    sessionStorage.setItem(STATE_KEY, state);
    if (silent) sessionStorage.setItem(SILENT_KEY, "1");
  } catch { /* private mode: the state check will fail safe */ }
  const params = new URLSearchParams({
    // Back to /lifeos/ (the address Google knows), wherever lifeOS is served.
    client_id: id.trim(), redirect_uri: location.origin + "/lifeos/",
    response_type: "token", scope: SCOPE, include_granted_scopes: "true", state,
  });
  if (silent) params.set("prompt", "none");
  if (email()) params.set("login_hint", email());
  location.assign(`${AUTH}?${params}`);
  return true;
}

// Google's reply (the page's hash when it came back). { ok, then } or { error, then }.
export function takeReply(hash) {
  const h = new URLSearchParams(String(hash || "").replace(/^#/, ""));
  const state = h.get("state") || "";
  const then = state.split(":")[1] || "";
  let expected = null;
  try { expected = sessionStorage.getItem(STATE_KEY); sessionStorage.removeItem(STATE_KEY); } catch { /* none */ }
  if (!expected || state !== expected) return { error: "state", then };
  if (h.get("error")) return { error: h.get("error"), then };
  const seconds = Number(h.get("expires_in")) || 3600;
  write(KEY, { ...auth(), token: h.get("access_token"), expires: Date.now() + (seconds - 60) * 1000 });
  try { sessionStorage.removeItem(SILENT_KEY); } catch { /* none */ }
  rememberEmail();
  return { ok: true, then };
}

// The primary calendar's ID is the account's email: the hint for signing in quietly next time.
async function rememberEmail() {
  if (email()) return;
  const { token } = auth();
  const res = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary?fields=id", { headers: { Authorization: `Bearer ${token}` } }).catch(() => null);
  const cal = res?.ok ? await res.json().catch(() => null) : null;
  if (cal?.id) write(KEY, { ...auth(), email: cal.id });
}

// A quiet renewal, at most once a visit; false when it can't be tried.
export function renewQuietly(then = "") {
  if (isConnected() || !wasConnected() || silentTried() || !clientId()) return false;
  return connect({ silent: true, then });
}
