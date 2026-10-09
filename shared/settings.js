// lifeOS settings that follow a person to every device: which apps are on
// the wheel, whether they've seen the welcome, their shared calendar.
// Kept in Supabase (app_state, app "lifeos") with a copy on the device under
// lifeos.settings.<user id>, so pages can read it at once without waiting.
//
//   { apps: ["cal", "tasks", …] | undefined (all), welcomed: ISO date,
//     sharedCalendar: Google calendar id | "" (none) | undefined (guess by name) }
//
// lifeos/index.html reads the device copy itself (a plain script, before
// any module loads): keep the key the same there.

import { supabase } from "/lifeos/auth.js";

const TOKEN_KEY = "sb-tvpmeysctvlhjyhotfyk-auth-token";

// The signed-in person's id, from the saved sign-in (no network).
function userId() {
  try { return JSON.parse(localStorage.getItem(TOKEN_KEY) || "null")?.user?.id || null; } catch { return null; }
}
const key = () => `lifeos.settings.${userId() || "anon"}`;

// Every app, wheel order, with a line for the welcome and Account.
export const APP_LIST = [
  { id: "cal", name: "calendar", about: "Your Google calendars, with quick add in plain English." },
  { id: "tasks", name: "tasks", about: "Task lists, including joint ones shared with your household." },
  { id: "food", name: "food", about: "Recipes, a weekly meal plan and a shared shopping list." },
  { id: "train", name: "train", about: "A training plan built around your race or goal." },
  { id: "breathe", name: "breathe", about: "Short guided breathing sessions, and a streak." },
  { id: "motivation", name: "motivation", about: "Quotes and reminders to keep you going." },
  { id: "places", name: "places", about: "Places you want to go, on a map." },
  { id: "media", name: "media", about: "What you’re watching, reading and listening to (uses Craft)." },
  { id: "wish", name: "wish", about: "Wishlists, and gift ideas for the people you buy for." },
];

export function get() {
  try { return JSON.parse(localStorage.getItem(key()) || "{}") || {}; } catch { return {}; }
}
function keep(s) { try { localStorage.setItem(key(), JSON.stringify(s)); } catch { /* private mode */ } }

// The saved copy from Supabase (also kept on the device). Falls back to the
// device copy when offline. `found` says whether Supabase had one at all.
export async function load() {
  const { data, error } = await supabase.from("app_state").select("data").eq("app", "lifeos").maybeSingle();
  if (error) return { settings: get(), found: null };
  const s = data?.data || {};
  keep(s);
  return { settings: s, found: Boolean(data) };
}

// Merge in a change and save it everywhere. Returns the new settings.
export async function save(patch) {
  const next = { ...get(), ...patch };
  keep(next);
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error("Not signed in");
  const { error } = await supabase.from("app_state").upsert(
    { user_id: session.user.id, app: "lifeos", data: next, updated_at: new Date().toISOString() },
    { onConflict: "user_id,app" });
  if (error) throw error;
  return next;
}
