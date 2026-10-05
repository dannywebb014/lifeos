// Reads a shop link for wish.: the product's name, price and picture, from the
// details shops publish for link previews and search engines (Open Graph
// tags, product meta tags and schema.org Product data). Signed-in, two-factor
// users only, like parse-recipe. Some shops block requests like this; the
// page then just keeps the link and asks for the details by hand.
import { createClient } from "npm:@supabase/supabase-js@2";
import { read } from "./read.ts";

const ALLOWED_ORIGINS = ["https://dannywebb014.github.io", "http://localhost:8774"];

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

// Only public web addresses: nothing on this machine or a private network.
function publicUrl(raw: string): URL | null {
  try {
    const u = new URL(raw);
    if (!/^https?:$/.test(u.protocol)) return null;
    const h = u.hostname.toLowerCase();
    if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return null;
    if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || h.includes(":")) return null;
    return u;
  } catch { return null; }
}

// Page titles a blocked request gets instead of the product.
const BLOCKED = /^(access denied|just a moment|attention required|robot check|something went wrong|page not found|403|404|amazon\.[a-z.]+)\b/i;
const score = (r: ReturnType<typeof read> | null) =>
  !r ? 0 : (r.name && !BLOCKED.test(r.name) ? 2 : 0) + (r.price != null ? 1 : 0) + (r.image ? 1 : 0);
const useful = (r: ReturnType<typeof read> | null) => score(r) >= 3;

Deno.serve(async (req) => {
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ success: false, error: "Use POST." }, 405, cors);

  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!);
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user || claim(token, "aal") !== "aal2") {
    return json({ success: false, error: "Sign in again to read links." }, 401, cors);
  }

  let url: URL | null = null;
  try { url = publicUrl(String((await req.json())?.url ?? "")); } catch { /* bad body */ }
  if (!url) return json({ success: false, error: "That doesn't look like a web link." }, 400, cors);

  // The shop itself first. Many shops turn away requests from data centres
  // (429, 403, 503, or a robot-check page), so when that gives nothing
  // useful the page is fetched again through Jina's free reader, which
  // returns the same HTML from its own servers.
  let direct: ReturnType<typeof read> | null = null;
  let why = "";
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-GB,en;q=0.9",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) direct = read((await res.text()).slice(0, 2_000_000), publicUrl(res.url) ?? url);
    else why = `the shop answered ${res.status}`;
  } catch (err) {
    why = `couldn't reach the shop (${(err as Error).message})`;
  }
  if (useful(direct)) return json({ success: true, ...direct }, 200, cors);

  try {
    const res = await fetch(`https://r.jina.ai/${url.href}`, {
      headers: { "X-Return-Format": "html", "Accept": "text/html" },
      signal: AbortSignal.timeout(25000),
    });
    if (res.ok) {
      const via = read((await res.text()).slice(0, 3_000_000), url);
      if (score(via) > score(direct)) return json({ success: true, ...via }, 200, cors);
    } else if (!why) why = `the reader answered ${res.status}`;
  } catch (err) {
    if (!why) why = `the reader failed (${(err as Error).message})`;
  }
  if (direct) return json({ success: true, ...direct }, 200, cors);
  return json({ success: false, error: why || "the shop didn't send the page" }, 200, cors);
});
