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
export async function verifiedSession() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return null;
  const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  return data?.currentLevel === "aal2" ? session : null;
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
    supabase.auth.onAuthStateChange((event) => { if (event === "SIGNED_OUT") location.replace(signInUrl()); });
    return session;
  }
  location.replace(signInUrl());
  return new Promise(() => {});
}

// Signs out of every hub app in this browser (other devices stay signed in).
export async function signOut() {
  try { await supabase.auth.signOut({ scope: "local" }); } catch (err) { console.error("Signing out failed:", err); }
  location.replace(signInUrl(HOME_PATH));
}
