// Google Calendar access kept on the server, so lifeOS stays connected
// without a trip through Google every hour.
//
// Google gives a server a long-lived refresh token (with the client secret,
// which only this function has). It's stored encrypted in google_tokens
// (lifeos/sql/google.sql), which no browser can read, and the apps ask here
// for a fresh one-hour access token whenever theirs runs out.
//
//   POST { action: "start", return: "<page on a lifeOS site>" }   → { url }   (signed-in, two-factor)
//   GET  ?code=…&state=…        Google's reply → stores the token → back to /lifeos/google/?next=<return>
//   POST { action: "token" }                                      → { access_token, expires_in, email } or 404
//   POST { action: "disconnect" }                                 → { ok }   (revokes it at Google too)
//
// Secrets: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET. The client's authorised
// redirect URIs must include this function's own address. Deploy with
// verify_jwt off: Google's reply arrives with no Supabase sign-in, and the
// POSTs check theirs here.
import { createClient } from "npm:@supabase/supabase-js@2";

const ALLOWED_ORIGINS = ["https://dannywebb014.github.io", "https://lifeos-app-nine-indol.vercel.app", "http://localhost:8765"];
const SCOPE = "https://www.googleapis.com/auth/calendar";
const CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID") ?? "";
const CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SELF = `${SUPABASE_URL}/functions/v1/google-auth`;
const admin = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
const json = (body: unknown, status: number, headers: Record<string, string>) =>
  new Response(JSON.stringify(body), { status, headers: { ...headers, "Content-Type": "application/json" } });

function claim(token: string, name: string): unknown {
  try {
    const part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(part.padEnd(part.length + ((4 - (part.length % 4)) % 4), "=")))[name];
  } catch { return undefined; }
}

// ── Signing the round trip, and encrypting what's stored ──────────────
// Both keys come from the client secret, so nothing else needs keeping.
// (A new client secret means everyone connects Google once more.)
const enc = new TextEncoder(), dec = new TextDecoder();
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(s.length + ((4 - (s.length % 4)) % 4), "=")), c => c.charCodeAt(0));
const keyBytes = async (purpose: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(`${purpose}:${CLIENT_SECRET}`)));
const hmacKey = keyBytes("lifeos-google-state").then(k => crypto.subtle.importKey("raw", k, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]));
const aesKey = keyBytes("lifeos-google-token").then(k => crypto.subtle.importKey("raw", k, "AES-GCM", false, ["encrypt", "decrypt"]));

async function sign(payload: object): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey, enc.encode(body)));
  return `${body}.${b64url(sig)}`;
}
async function unsign(state: string): Promise<{ u: string; r: string; e: number } | null> {
  const [body, sig] = state.split(".");
  if (!body || !sig) return null;
  const ok = await crypto.subtle.verify("HMAC", await hmacKey, unb64url(sig), enc.encode(body)).catch(() => false);
  if (!ok) return null;
  const p = JSON.parse(dec.decode(unb64url(body)));
  return p.e > Date.now() ? p : null;
}
async function seal(text: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const out = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey, enc.encode(text)));
  return `${b64url(iv)}.${b64url(out)}`;
}
async function unseal(sealed: string): Promise<string | null> {
  try {
    const [iv, data] = sealed.split(".");
    return dec.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64url(iv) }, await aesKey, unb64url(data)));
  } catch { return null; }
}

// Only back to a page on a lifeOS site.
function safeReturn(raw: string): URL | null {
  try {
    const u = new URL(raw);
    return ALLOWED_ORIGINS.includes(u.origin) ? u : null;
  } catch { return null; }
}

async function google(params: Record<string, string>) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...params }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

// The account's email: the primary calendar's id.
async function emailFor(accessToken: string): Promise<string> {
  const res = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary?fields=id", { headers: { Authorization: `Bearer ${accessToken}` } });
  return res.ok ? (await res.json()).id ?? "" : "";
}

// Google's reply: swap the code for tokens, keep the refresh token, go back.
async function reply(url: URL): Promise<Response> {
  const state = await unsign(url.searchParams.get("state") ?? "");
  if (!state) return new Response("That Google sign-in link has expired. Go back to lifeOS and connect again.", { status: 400 });
  const back = safeReturn(state.r)!;
  const done = (result: string) => {
    const page = new URL("/lifeos/google/", back.origin);
    page.searchParams.set("next", back.pathname + back.search);
    page.searchParams.set("result", result);
    return Response.redirect(page.toString(), 302);
  };
  const err = url.searchParams.get("error");
  if (err) return done(err === "access_denied" ? "denied" : "error");

  const { body } = await google({ grant_type: "authorization_code", code: url.searchParams.get("code") ?? "", redirect_uri: SELF });
  if (!body.access_token) { console.error("Google code swap failed:", body.error, body.error_description); return done("error"); }
  // Google only sends a refresh token the first time (or with prompt=consent,
  // which start asks for), so keep any already stored.
  const row: Record<string, unknown> = { user_id: state.u, email: await emailFor(body.access_token), scope: body.scope ?? SCOPE, updated_at: new Date().toISOString() };
  if (body.refresh_token) row.refresh_token = await seal(body.refresh_token);
  else {
    const { data } = await admin.from("google_tokens").select("user_id").eq("user_id", state.u).maybeSingle();
    if (!data) return done("norefresh");
  }
  const { error } = await admin.from("google_tokens").upsert(row, { onConflict: "user_id" });
  if (error) { console.error("Saving the Google token failed:", error.message); return done("error"); }
  return done("connected");
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (req.method === "GET" && (url.searchParams.has("state"))) return reply(url);

  const cors = corsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Use POST." }, 405, cors);
  if (!CLIENT_ID || !CLIENT_SECRET) return json({ error: "Google isn't set up on the server yet." }, 503, cors);

  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: who, error: whoErr } = await admin.auth.getUser(token);
  if (whoErr || !who?.user || claim(token, "aal") !== "aal2") return json({ error: "Sign in again." }, 401, cors);
  const userId = who.user.id;
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* none */ }

  if (body.action === "start") {
    const back = safeReturn(String(body.return ?? ""));
    if (!back) return json({ error: "Unknown return address." }, 400, cors);
    const { data: had } = await admin.from("google_tokens").select("email").eq("user_id", userId).maybeSingle();
    const params = new URLSearchParams({
      client_id: CLIENT_ID, redirect_uri: SELF, response_type: "code", scope: SCOPE,
      access_type: "offline", include_granted_scopes: "true",
      // consent: so Google sends a refresh token even if this account said yes before.
      prompt: "consent",
      state: await sign({ u: userId, r: back.toString(), e: Date.now() + 15 * 60 * 1000, n: crypto.randomUUID() }),
    });
    const hint = String(body.hint ?? had?.email ?? "");
    if (hint) params.set("login_hint", hint);
    return json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` }, 200, cors);
  }

  const { data: row } = await admin.from("google_tokens").select("refresh_token, email").eq("user_id", userId).maybeSingle();

  if (body.action === "token") {
    const refresh = row?.refresh_token ? await unseal(row.refresh_token) : null;
    if (!refresh) return json({ error: "not connected" }, 404, cors);
    const { status, body: g } = await google({ grant_type: "refresh_token", refresh_token: refresh });
    if (g.access_token) return json({ access_token: g.access_token, expires_in: g.expires_in ?? 3600, email: row!.email ?? "" }, 200, cors);
    // Revoked or expired at Google (invalid_grant): forget it, so the apps ask to connect again.
    if (g.error === "invalid_grant") {
      await admin.from("google_tokens").delete().eq("user_id", userId);
      return json({ error: "not connected" }, 404, cors);
    }
    console.error("Google refresh failed:", status, g.error, g.error_description);
    return json({ error: "Google didn't answer. Try again in a moment." }, 502, cors);
  }

  if (body.action === "disconnect") {
    const refresh = row?.refresh_token ? await unseal(row.refresh_token) : null;
    if (refresh) await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(refresh)}`, { method: "POST" }).catch(() => {});
    await admin.from("google_tokens").delete().eq("user_id", userId);
    return json({ ok: true }, 200, cors);
  }

  return json({ error: "Unknown action." }, 400, cors);
});
