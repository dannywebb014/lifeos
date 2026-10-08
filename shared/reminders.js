// ─── Reminders before calendar events ───────────────────────────────
//
// The notification sender (supabase/functions/send-reminders) can't read
// Google Calendar: the sign-in lives in the browser and lasts an hour. So
// whenever lifeOS or calendar. is open with a Google sign-in, this reads the
// next 36 hours of events and time blocks and keeps a reminder for each, 10
// minutes before it starts, in the reminders table. The sender sends them.
//
// Every calendar shown in Google (selected) and not hidden in calendar. is
// read, so lifeOS and calendar. agree on the list. Time blocks already
// ticked off are skipped.

import { supabase } from "/lifeos/auth.js";

export const LEAD_MINUTES = 10;
const WINDOW_MS = 36 * 3600 * 1000;
const STAMP = "lifeos.reminders.synced";
const API = "https://www.googleapis.com/calendar/v3";

const pad = (n) => String(n).padStart(2, "0");
const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

async function google(token, path) {
  const res = await fetch(`${API}/${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw Object.assign(new Error(`Google ${res.status}`), { status: res.status });
  return res.json();
}

// Reads Google and rewrites the reminders still to come. Skipped if it ran in
// the last 5 minutes on this device, unless `force` (a change was just made).
export async function syncFromGoogle(token, { force = false } = {}) {
  if (!token) return;
  try { if (!force && Date.now() - Number(localStorage.getItem(STAMP) || 0) < 5 * 60e3) return; } catch { /* storage blocked */ }
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return;
  const now = Date.now();
  const from = new Date(now).toISOString(), to = new Date(now + WINDOW_MS).toISOString();
  const cals = (await google(token, "users/me/calendarList?minAccessRole=reader&fields=items(id,selected)")).items || [];
  let hidden = [];
  try { hidden = JSON.parse(localStorage.getItem("calendar.settings") || "{}").hidden || []; } catch { /* none */ }
  const events = (await Promise.all(cals.filter(c => c.selected !== false && !hidden.includes(c.id)).map(c =>
    google(token, `calendars/${encodeURIComponent(c.id)}/events?singleEvents=true&orderBy=startTime&maxResults=100&timeMin=${encodeURIComponent(from)}&timeMax=${encodeURIComponent(to)}&fields=items(id,summary,status,location,start,extendedProperties)`)
      .then(r => r.items || [], () => []),
  ))).flat();

  const lead = LEAD_MINUTES * 60e3;
  const seen = new Set();
  const rows = [];
  for (const e of events) {
    if (e.status === "cancelled" || !e.start?.dateTime) continue;            // all-day events don't get one
    if (e.extendedProperties?.private?.calhubDone === "1") continue;          // a time block already ticked off
    const start = new Date(e.start.dateTime);
    const fire = start.getTime() - lead;
    const key = `event:${e.id}:${start.toISOString()}`;
    if (fire <= now || seen.has(key)) continue;
    seen.add(key);
    const block = Boolean(e.extendedProperties?.private?.calhubTask);
    rows.push({
      user_id: session.user.id,
      kind: "event",
      source_key: key,
      title: `${hhmm(start)} · ${e.summary || "(no title)"}`,
      body: `${block ? "Time block" : "Starts"} in ${LEAD_MINUTES} minutes${e.location ? ` · ${e.location}` : ""}`,
      url: "/lifeos/?app=cal",
      fire_at: new Date(fire).toISOString(),
    });
  }

  // What's still to come is replaced, so a moved or deleted event loses its
  // old reminder. One already sent stays sent (and isn't made again).
  const del = await supabase.from("reminders").delete()
    .eq("kind", "event").is("sent_at", null).gt("fire_at", new Date(now).toISOString());
  if (del.error) throw del.error;
  if (rows.length) {
    const put = await supabase.from("reminders").upsert(rows, { onConflict: "user_id,source_key", ignoreDuplicates: true });
    if (put.error) throw put.error;
  }
  try { localStorage.setItem(STAMP, String(now)); } catch { /* storage blocked */ }
}

// A test sent within the next minute to every device turned on.
export async function sendTest() {
  const { data: { session } } = await supabase.auth.getSession();
  const { error } = await supabase.from("reminders").insert({
    user_id: session.user.id, kind: "test", source_key: `test:${Date.now()}`,
    title: "lifeOS.", body: "Notifications are working on this device.", url: "/lifeos/", fire_at: new Date().toISOString(),
  });
  if (error) throw error;
}
