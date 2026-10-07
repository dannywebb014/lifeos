// send-reminders: sends every reminder that's due (table reminders) to each
// device its person turned notifications on for (push_subscriptions).
//
// Run once a minute by pg_cron (sql/notifications-cron.sql), which passes
// CRON_SECRET in the x-cron-secret header; nothing else may call it.
// Secrets: CRON_SECRET, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY. The service role
// key and URL are provided by Supabase.
//
// Deploy from the lifeos repo:
//   npx -y supabase@2 functions deploy send-reminders --project-ref tvpmeysctvlhjyhotfyk --use-api --no-verify-jwt

import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2";

const env = (k: string) => Deno.env.get(k) ?? "";
webpush.setVapidDetails("https://dannywebb014.github.io/lifeos/", env("VAPID_PUBLIC_KEY"), env("VAPID_PRIVATE_KEY"));

// A reminder more than 10 minutes late is dropped rather than sent: by then
// the event has started and the nudge is useless.
const LATE_MS = 10 * 60 * 1000;

Deno.serve(async (req) => {
  if (!env("CRON_SECRET") || req.headers.get("x-cron-secret") !== env("CRON_SECRET")) {
    return new Response("Not allowed", { status: 401 });
  }
  const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
  const now = Date.now();

  // Claim what's due by marking it sent first, so two runs never send one twice.
  const { data: due, error } = await db.from("reminders")
    .update({ sent_at: new Date(now).toISOString() })
    .is("sent_at", null)
    .lte("fire_at", new Date(now + 30_000).toISOString())
    .select("id,user_id,title,body,url,fire_at,source_key");
  if (error) return Response.json({ error: error.message }, { status: 500 });

  const fresh = (due ?? []).filter(r => now - Date.parse(r.fire_at) < LATE_MS);
  const users = [...new Set(fresh.map(r => r.user_id))];
  const { data: subs } = users.length
    ? await db.from("push_subscriptions").select("id,user_id,endpoint,p256dh,auth").in("user_id", users)
    : { data: [] };

  let sent = 0;
  const gone: string[] = [];
  for (const r of fresh) {
    const payload = JSON.stringify({ title: r.title, body: r.body, url: r.url, tag: r.source_key });
    for (const s of (subs ?? []).filter(s => s.user_id === r.user_id)) {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 600, urgency: "high" });
        sent++;
      } catch (err) {
        // 404 / 410: the device turned them off or the subscription expired.
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) gone.push(s.id);
        else console.error("Push failed:", status, (err as Error).message);
      }
    }
  }
  if (gone.length) await db.from("push_subscriptions").delete().in("id", gone);
  if (Math.random() < 0.02) await db.rpc("reminders_tidy");
  return Response.json({ due: due?.length ?? 0, sent, dropped: (due?.length ?? 0) - fresh.length, removed: gone.length });
});
