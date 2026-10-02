// One sign-in for every hub app on dannywebb014.github.io.
//
// All the apps share this site, so they share the browser's storage and the
// Supabase session in it: signing in once on /lifeos/signin/ signs in every
// app. An app calls requireAuth() before showing anything; without a session
// that has passed two-factor (Supabase calls it "aal2") it sends the browser to
// the sign-in page, which comes back to the same address afterwards.
//
//   import { requireAuth, supabase } from "https://dannywebb014.github.io/lifeos/auth.js";
//   const session = await requireAuth();
//
// The page is hidden until the check passes, so nothing flashes before a redirect.

// supabase-js 2.57.4, bundled into one file on this site (vendor/) so it loads in one request.
import { createClient } from "./vendor/supabase-js-2.57.4.js";

const SUPABASE_URL = "https://tvpmeysctvlhjyhotfyk.supabase.co";
// The anon key is meant to be public: every table it can reach is guarded by
// row-level security, so it only ever returns the signed-in user's own rows.
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR2cG1leXNjdHZsaGp5aG90ZnlrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ3MjkxMjcsImV4cCI6MjA5MDMwNTEyN30.FyerEiT3XA6uAXH_JlFhi_v2Job4GKLWuTFmbGVIjMg";

export const SIGNIN_PATH = "/lifeos/signin/";
export const HOME_PATH = "/lifeos/";

// Where supabase-js keeps the session, shared by every app on this site.
const STORAGE_KEY = "sb-tvpmeysctvlhjyhotfyk-auth-token";
// Why the last trip to the sign-in page happened, shown there in small print.
export const REASON_KEY = "hub.signin.reason";
let lastReason = "";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// A failure to reach Supabase (no signal yet, a timeout, a server hiccup), as
// opposed to Supabase answering that the session is no longer valid.
const unreachable = (err) =>
  !!err && (err.name === "AuthRetryableFetchError" || err.status === 0 || err.status >= 500 || /fetch|network|load failed|timed? ?out/i.test(err.message || ""));

function claim(token, name) {
  try {
    const part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(part.padEnd(part.length + ((4 - (part.length % 4)) % 4), "=")))[name];
  } catch { return undefined; }
}
function savedSession() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "null"); } catch { return null; }
}

// Read before supabase-js starts: if it then refuses to renew this session it
// deletes it straight away, and this is how that's told apart from "never signed in".
const hadSession = !!savedSession()?.refresh_token;

// One client per page, however many scripts import this file.
export const supabase = (globalThis.__hubSupabase ||= createClient(SUPABASE_URL, SUPABASE_ANON_KEY));

// Only addresses on this site may be returned to after signing in.
export function safeNext(raw) {
  try {
    const url = new URL(raw || HOME_PATH, location.origin);
    if (url.origin !== location.origin || url.pathname.startsWith(SIGNIN_PATH)) return HOME_PATH;
    return url.pathname + url.search + url.hash;
  } catch {
    return HOME_PATH;
  }
}

export function signInUrl(next = location.href) {
  return `${SIGNIN_PATH}?next=${encodeURIComponent(safeNext(next))}`;
}

// The session, if it has passed two-factor; otherwise null.
//
// Opening an app after an hour or more renews the session first, and a home
// screen app often opens before the phone has signal. That used to look like
// "signed out" and meant a full sign-in, so now: keep trying for a few seconds (under four in all),
// and if Supabase still can't be reached, trust the two-factor session saved on
// this device. Only Supabase saying the session is gone means signing in again.
export async function verifiedSession() {
  for (let attempt = 0; attempt < 4; attempt++) {
    const { data, error } = await supabase.auth.getSession();
    const session = data?.session;
    if (session) {
      const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      if (aal?.currentLevel === "aal2") return session;
      lastReason = "this device's session hasn't had its two-factor code";
      return null;
    }
    if (!error) {
      lastReason = hadSession ? "Supabase refused to renew the session saved on this device" : "no session saved on this device";
      return null;
    }
    if (!unreachable(error)) { lastReason = `Supabase ended the session (${error.message})`; return null; }
    if (attempt < 3) await wait(600 * (attempt + 1));
  }
  const saved = savedSession();
  if (saved?.refresh_token && claim(saved.access_token, "aal") === "aal2") return saved;
  lastReason = "couldn't reach Supabase to renew the session";
  return null;
}

function hide() { document.documentElement.style.visibility = "hidden"; }
function show() { document.documentElement.style.visibility = ""; }

// Resolves with the verified session, or sends the page to sign in and never
// resolves. allowDemo lets a page's ?demo mode through without an account.
export async function requireAuth({ allowDemo = false } = {}) {
  if (allowDemo && new URLSearchParams(location.search).has("demo")) return null;
  hide();
  let session = null;
  try { session = await verifiedSession(); } catch (err) { console.error("Checking the sign-in failed:", err); }
  if (session) {
    show();
    // Signed out in another tab or app: follow it here too.
    supabase.auth.onAuthStateChange((event) => {
      if (event !== "SIGNED_OUT") return;
      // Keep a reason written a moment ago (signOut() writes "you signed out" first).
      let recent = false;
      try { recent = Date.now() - (JSON.parse(localStorage.getItem(REASON_KEY) || "{}").at || 0) < 5000; } catch { /* none */ }
      if (!recent) try { localStorage.setItem(REASON_KEY, JSON.stringify({ reason: "signed out (here, in another app, or by Supabase)", at: Date.now(), from: location.pathname })); } catch { /* private mode */ }
      location.replace(signInUrl());
    });
    return session;
  }
  try { localStorage.setItem(REASON_KEY, JSON.stringify({ reason: lastReason || "unknown", at: Date.now(), from: location.pathname })); } catch { /* private mode */ }
  location.replace(signInUrl());
  return new Promise(() => {});
}

// Signs out of every hub app in this browser (other devices stay signed in).
export async function signOut() {
  try { localStorage.setItem(REASON_KEY, JSON.stringify({ reason: "you signed out", at: Date.now(), from: location.pathname })); } catch { /* private mode */ }
  try { await supabase.auth.signOut({ scope: "local" }); } catch (err) { console.error("Signing out failed:", err); }
  location.replace(signInUrl(HOME_PATH));
}
