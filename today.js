// "today." on the lifeOS picker: a pop-up with a card per app for what
// matters today (or, in the evening, tomorrow), each opening its app.
//
//   import { mountToday } from "/lifeos/today.js";
//   mountToday({ open: (appId, url) => …, setup: () => …, enabled });
//
// Cards: calendar events, tasks due (and overdue), dinner from food.'s plan,
// the train. session, and the breathe. streak. Each loads on its own and
// keeps quiet if it can't (no data, no sign-in), so one slow or broken app
// never holds up the rest.
//
// It has two views. "today" from the morning; from 6pm it starts on
// "tomorrow": what's planned, and today's leftover tasks with a button to
// move them all over. It opens from the sun button (or T), never by itself.
// On a phone each app is a small card; on a wider screen it fills the page,
// and each card lists the day in full (every event, task, meal, the week's
// training and the last seven days of breathing).
// An expired Google sign-in is renewed quietly when it opens (google.js).

import { supabase } from "./auth.js";
import * as google from "./google.js?v=1";
import * as todoist from "./shared/todoist.js?v=19";
import * as hub from "./shared/hubtasks.js?v=5";

const read = (k) => { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch { return null; } };
const pad = (n) => String(n).padStart(2, "0");
const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const cleanKey = (k) => String(k || "").replace(/[\s ​-‍﻿]/g, "");
const BASE = "";   // same site: every app is served from this one
const EVENING = 18;

// Each loader gets the view: { day (midnight of the day shown), tomorrow }.

// ── calendar.: the next event left today, or tomorrow's first ──
// Every calendar shown in Google and not hidden in calendar. (as the
// reminders read them), and the whole day in `items`.
async function calendar({ day, tomorrow }) {
  const { token } = google.auth();
  if (!google.isConnected()) {
    return google.clientId() ? { main: "Tap to renew", sub: "Google sign-in ran out", muted: true, action: "renew" }
      : { main: "Not connected", sub: "set up in connections", muted: true, action: "setup" };
  }
  const api = async (path) => {
    const res = await fetch(`https://www.googleapis.com/calendar/v3/${path}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Google ${res.status}`);
    return res.json();
  };
  const cals = (await api("users/me/calendarList?minAccessRole=reader&fields=items(id,selected,backgroundColor)")).items || [];
  const range = `timeMin=${encodeURIComponent(day.toISOString())}&timeMax=${encodeURIComponent(addDays(day, 1).toISOString())}`;
  // Calendars hidden in calendar. stay hidden here too.
  const hidden = new Set(read("calendar.settings")?.hidden || []);
  const lists = await Promise.all(cals.filter(c => c.selected !== false && !hidden.has(c.id)).map(c =>
    api(`calendars/${encodeURIComponent(c.id)}/events?singleEvents=true&orderBy=startTime&maxResults=50&${range}&fields=items(summary,status,location,start,end,extendedProperties)`)
      .then(r => (r.items || []).map(e => ({ ...e, colour: c.backgroundColor })), () => [])));
  // An event on two calendars (shared, or invited twice) shows once.
  const seen = new Set();
  const events = lists.flat().filter(e => {
    if (e.status === "cancelled" || e.extendedProperties?.private?.calhubDone === "1") return false;
    const k = `${e.summary}|${e.start?.dateTime || e.start?.date}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const now = new Date();
  const allDay = events.filter(e => !e.start?.dateTime);
  const timed = events.filter(e => e.start?.dateTime)
    .map(e => ({ ...e, s: new Date(e.start.dateTime), e: new Date(e.end?.dateTime || e.start.dateTime) }))
    .sort((a, b) => a.s - b.s);
  const items = [
    ...allDay.map(e => ({ time: "all day", text: e.summary || "(no title)", sub: e.location, colour: e.colour })),
    ...timed.map(e => ({ time: `${hhmm(e.s)}–${hhmm(e.e)}`, text: e.summary || "(no title)", sub: e.location, colour: e.colour,
      past: !tomorrow && e.e <= now, now: !tomorrow && e.s <= now && e.e > now })),
  ];
  const left = tomorrow ? timed : timed.filter(e => e.e > now);
  if (!left.length) return { main: tomorrow ? "Nothing booked" : "Nothing else today", sub: allDay.length ? `${allDay.length} all-day` : "", muted: true, items };
  const first = left[0];
  return {
    main: `${hhmm(first.s)} ${first.summary || "(no title)"}`,
    sub: left.length > 1 ? `${tomorrow ? "first of" : "then"} ${tomorrow ? left.length : left.length - 1}${tomorrow ? "" : " more"}` : tomorrow ? "the only one" : "last one today",
    items,
  };
}

// ── tasks.: due on the day shown, and what's left over from before ──
const SPACE = { my: "my space", work: "work", todoist: "joint", joint: "joint" };
const PRIORITY = { 3: "#d9534f", 2: "#e0a030", 1: "#4caf6a" };
const shortDay = (iso) => new Date(`${iso}T12:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
// The connections are the ones saved in tasks. on this device. Each task
// left over is kept in `leftovers`, for moving them all to tomorrow.
let leftovers = [];   // { spaceId, id, text, todoist?, builtin? }
async function tasks({ day, tomorrow }) {
  // A list trying lifeOS tasks has no Craft or Todoist here (hubtasks.js).
  const settings = hub.effective(read("tasks.settings") || {});
  const today = isoDay(new Date()), shown = isoDay(day);
  let due = 0, late = 0, high = 0, any = false;
  const found = [], listed = [];
  // Red (high priority) ones due on the day shown or before are counted too.
  const seenTask = (spaceId, id, text, date, todo, builtin = false, priority = 0) => {
    if (!date) return;
    if (date === shown) due++;
    const over = date <= today && (tomorrow || date < today);
    if (date === shown || over) listed.push({ text, date, spaceId, priority, late: over });
    if (priority === 3 && (date === shown || (date <= today && (tomorrow || date < today)))) high++;
    if (date <= today && (tomorrow || date < today)) { late++; found.push({ spaceId, id, text, todoist: todo, builtin }); }
  };
  // Tasks kept in lifeOS, which everyone signed in has.
  const builtin = hub.loadTasks().then(list => {
    if (list.length) any = true;
    for (const t of list) seenTask(t.spaceId, t.id, t.text, t.date, undefined, true, t.priority);
  });
  await Promise.all(Object.entries(settings.spaces || {}).filter(([, s]) => s?.url).map(async ([spaceId, s]) => {
    any = true;
    const m = String(s.url).match(/connect\.craft\.do\/links\/[^/?#\s]+/i);
    const base = m ? `https://${m[0]}/api/v1` : s.url.replace(/\/+$/, "");
    const headers = { Accept: "application/json" };
    if (cleanKey(s.key)) headers.Authorization = `Bearer ${cleanKey(s.key)}`;
    // As tasks. reads them: a dated task in the inbox may only be in "inbox",
    // and tomorrow's are in "upcoming".
    const seen = new Set();
    for (const scope of tomorrow ? ["active", "upcoming", "inbox"] : ["active", "inbox"]) {
      const res = await fetch(`${base}/tasks?scope=${scope}`, { headers });
      if (!res.ok) throw new Error(`Craft ${res.status}`);
      for (const t of (await res.json()).items || []) {
        if (t.taskInfo?.state !== "todo" || seen.has(t.id)) continue;
        seen.add(t.id);
        seenTask(spaceId, t.id, String(t.markdown || "").replace(/^\s*[-*]\s*\[[ x]\]\s*/, "").trim(), t.taskInfo?.scheduleDate);
      }
    }
  }));
  if (cleanKey(settings.todoist?.token)) {
    any = true;
    const res = await fetch("https://api.todoist.com/api/v1/tasks?limit=200", { headers: { Authorization: `Bearer ${cleanKey(settings.todoist.token)}` } });
    if (!res.ok) throw new Error(`Todoist ${res.status}`);
    const body = await res.json();
    for (const t of body.results || body.items || []) seenTask("todoist", String(t.id), t.content, t.due?.date?.slice(0, 10), { id: String(t.id), due: t.due }, false, Math.max(0, (t.priority || 1) - 1));
  }
  await builtin;
  leftovers = tomorrow ? found : [];
  // Overdue first, then red, amber, green.
  listed.sort((a, b) => b.late - a.late || b.priority - a.priority || a.text.localeCompare(b.text));
  const items = listed.map(t => ({
    text: t.text, colour: PRIORITY[t.priority] || "",
    sub: `${SPACE[t.spaceId] || t.spaceId}${t.late ? ` · ${t.date === today ? "left from today" : `was due ${shortDay(t.date)}`}` : ""}`,
    late: t.late,
  }));
  if (!any) return { main: tomorrow ? "Nothing yet" : "All clear", sub: tomorrow ? "nothing for tomorrow" : "nothing due today", muted: true };
  if (tomorrow) {
    return {
      main: due ? `${due} for tomorrow` : "Nothing yet",
      sub: late ? `<span class="late">${late} left from today</span>` : "today’s all done",
      subHtml: true, muted: !due && !late, items,
    };
  }
  if (!due && !late) return { main: "All clear", sub: "nothing due today", items };
  const red = high ? ` · <span class="late">${high} high</span>` : "";
  return {
    main: `${due + late} to do`,
    sub: (late ? `<span class="late">${late} overdue</span>` : "all due today") + red,
    subHtml: true, items,
  };
}

// Moves every task left over (due today or before) to tomorrow, as tasks.'
// "move all to tomorrow" does: Craft by date, Todoist keeping a repeat, and
// any time block on the calendar along with it. Resolves { moved, failed }.
async function moveLeftovers() {
  // A list trying lifeOS tasks has no Craft or Todoist here (hubtasks.js).
  const settings = hub.effective(read("tasks.settings") || {});
  const date = isoDay(addDays(startOfToday(), 1));
  let moved = 0;
  const failed = [], done = [];
  todoist.setToken(settings.todoist?.token);
  // lifeOS's own in one request.
  const own = leftovers.filter(t => t.builtin);
  if (own.length) {
    try {
      await hub.rescheduleTask(own.map(t => t.id), date);
      moved += own.length;
      done.push(...own.map(t => String(t.id)));
    } catch (err) {
      console.error("today: moving lifeOS tasks:", err);
      failed.push(...own.map(t => t.text));
    }
  }
  // One at a time per Craft space: a task in a document the connection
  // can't edit fails on its own instead of taking the batch with it.
  await Promise.all(leftovers.filter(t => !t.builtin).map(async (t) => {
    try {
      if (t.todoist) await todoist.rescheduleTask(t.todoist, date);
      else {
        const s = settings.spaces?.[t.spaceId] || {};
        const m = String(s.url).match(/connect\.craft\.do\/links\/[^/?#\s]+/i);
        const base = m ? `https://${m[0]}/api/v1` : String(s.url).replace(/\/+$/, "");
        const res = await fetch(`${base}/tasks`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", Accept: "application/json", ...(cleanKey(s.key) ? { Authorization: `Bearer ${cleanKey(s.key)}` } : {}) },
          body: JSON.stringify({ tasksToUpdate: [{ id: t.id, taskInfo: { scheduleDate: date } }] }),
        });
        if (!res.ok) throw new Error(`Craft ${res.status}`);
      }
      moved++;
      done.push(String(t.id));
    } catch (err) {
      console.error("today: moving a task:", err);
      failed.push(t.text);
    }
  }));
  if (done.length && google.isConnected()) {
    try {
      const gcal = await import("/taskhub/calendar.js");
      const blocks = await gcal.loadBlocks();
      await Promise.all(done.map(id => blocks.get(id)).filter(b => b && b.day !== date).map(b => gcal.moveBlock(b, date)));
    } catch (err) { console.error("today: moving time blocks:", err); }
  }
  return { moved, failed };
}

// ── food.: dinner on the plan ──
// The plan is a rolling Monday–Sunday week of rows keyed by day and meal name.
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
async function householdId() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const k = `food.household.${user.id}`;
  const cached = localStorage.getItem(k);
  if (cached) return cached;
  const { data, error } = await supabase.from("profiles").select("household_id").eq("id", user.id).maybeSingle();
  if (error) throw error;
  if (data?.household_id) try { localStorage.setItem(k, data.household_id); } catch { /* private mode */ }
  return data?.household_id || null;
}
const MEAL_ORDER = ["Breakfast", "Lunch", "Dinner"];
async function dinner({ day }) {
  const hid = await householdId();
  if (!hid) return null;
  const { data, error } = await supabase.from("meal_plan").select("meal, recipe_id, note")
    .eq("household_id", hid).eq("day", DAY_NAMES[day.getDay()]);
  if (error) throw error;
  const ids = [...new Set(data.map(r => r.recipe_id).filter(Boolean))];
  const names = {};
  if (ids.length) {
    const r = await supabase.from("recipes").select("id, name").in("id", ids);
    for (const x of r.data || []) names[x.id] = x.name;
  }
  const rank = (m) => { const i = MEAL_ORDER.indexOf(m); return i < 0 ? 9 : i; };
  const items = data.filter(r => r.recipe_id || r.note)
    .sort((a, b) => rank(a.meal) - rank(b.meal))
    .map(r => ({ time: String(r.meal || "").toLowerCase(), text: r.recipe_id ? names[r.recipe_id] || "A recipe" : r.note }));
  const dinners = data.filter(r => r.meal === "Dinner");
  const row = dinners.find(r => r.recipe_id) || dinners.find(r => r.note);
  if (!row) return { main: "Nothing planned", sub: "dinner", muted: true, items };
  if (!row.recipe_id) return { main: row.note, sub: "dinner", items };
  return { main: names[row.recipe_id] || "A recipe", sub: dinners.length > 1 ? `dinner · +${dinners.length - 1} more` : "dinner", url: `${BASE}/foodhub/?recipe=${row.recipe_id}`, items };
}

// ── train.: the day's session in the training plan ──
// train. saves its plan with its data (app_state "train", data.plan:
// { start, weeks: [[{ key, offset, title }]] }), so nothing is copied here.
// A day with no session in the plan is a rest day.
async function appState(app) {
  const { data, error } = await supabase.from("app_state").select("data").eq("app", app).maybeSingle();
  if (error) console.warn("app_state:", error.message);
  return data?.data || null;
}
async function training({ day }) {
  const localKey = Object.keys(localStorage).find(k => k.startsWith("train:"));
  const data = (await appState("train")) || (localKey && read(localKey)) || {};
  const plan = data.plan;
  if (!plan?.start || !plan.weeks?.length) return null;
  const [y, m, d] = plan.start.split("-").map(Number);
  const days = Math.round((day - new Date(y, m - 1, d)) / 86400000);
  const week = Math.floor(days / 7) + 1;
  if (days < 0 || week > plan.weeks.length) return null;
  const monday = addDays(day, -(days % 7));
  const items = [...plan.weeks[week - 1]].sort((a, b) => a.offset - b.offset).map(x => ({
    time: addDays(monday, x.offset).toLocaleDateString("en-GB", { weekday: "short" }).toLowerCase(),
    text: x.title, done: Boolean(data.logs?.[`w${week}-${x.key}`]?.done), now: x.offset === days % 7,
  }));
  const s = plan.weeks[week - 1].find(x => x.offset === days % 7);
  if (!s) return { main: "Rest day", sub: `week ${week}`, muted: true, items };
  const done = Boolean(data.logs?.[`w${week}-${s.key}`]?.done);
  return { main: `${done ? "✓ " : ""}${s.title}`, sub: done ? "done" : `week ${week}`, done, items };
}

// ── breathe.: today's practice and the run of days (tomorrow too: an evening nudge) ──
async function breathing() {
  const s = (await appState("breathe")) || read("breathhub.v1");
  if (!s) return null;
  const days = new Set(Object.keys(s.days || {}));
  const today = startOfToday();
  const doneToday = days.has(isoDay(today));
  let streak = 0;
  for (let d = doneToday ? today : addDays(today, -1); days.has(isoDay(d)); d = addDays(d, -1)) streak++;
  const week = Array.from({ length: 7 }, (_, i) => {
    const d = addDays(today, i - 6);
    return { label: d.toLocaleDateString("en-GB", { weekday: "narrow" }), done: days.has(isoDay(d)) };
  });
  return {
    main: doneToday ? "✓ Done today" : "Not yet today",
    sub: streak ? `${streak}-day streak` : "start a streak",
    done: doneToday, muted: !doneToday && !streak, week,
  };
}

const CARDS = [
  { id: "cal", label: "calendar", load: calendar },
  { id: "tasks", label: "tasks", load: tasks },
  { id: "food", label: "food", load: dinner },
  { id: "train", label: "train", load: training },
  { id: "breathe", label: "breathe", load: breathing },
];

const SUN = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>`;

// It borrows search's look (spotlight.js), so mount that on the page too.
const CSS = `
  .td-btn { right:116px; }
  .td-panel { padding:14px 14px 12px; }
  .td-head { display:flex; align-items:center; gap:.6rem; margin:0 2px 10px; }
  .td-tabs { display:flex; gap:2px; padding:2px; border-radius:999px; background:var(--sl-hover); }
  .td-tabs button { border:0; background:none; border-radius:999px; padding:.2rem .75rem; cursor:pointer; color:var(--sl-muted);
    font-family:var(--disp); font-style:var(--hub-logo-style, italic); font-weight:600; font-size:1.1rem; }
  .td-tabs button i { font-style:normal; color:var(--life-accent); }
  .td-tabs button[aria-pressed="true"] { background:var(--sl-surface); color:var(--life-logo); box-shadow:var(--sl-shadow); }
  .td-date { color:var(--sl-muted); font-size:.85rem; flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .td-cards { display:grid; grid-template-columns:repeat(auto-fill, minmax(9.5rem, 1fr)); gap:.5rem; overflow-y:auto; }
  .tcard { min-height:4.8rem; padding:.6rem .75rem; border-radius:14px; text-align:left; cursor:pointer;
    background:var(--bg); border:1px solid var(--sl-line); color:var(--sl-text); font:inherit;
    display:flex; flex-direction:column; gap:.15rem; }
  .tcard[hidden] { display:none; }
  .tcard:hover { border-color:var(--a); }
  .tcard:active { transform:scale(.97); }
  .tcard .tl { font-family:var(--disp); font-style:var(--hub-logo-style, italic); font-weight:600; font-size:.9rem; color:var(--c); }
  .tcard .tl i { font-style:normal; color:var(--a); }
  .tcard .tm { font-weight:600; font-size:.98rem; line-height:1.2; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
  .tcard .ts { font-size:.8rem; color:var(--sl-muted); }
  .tcard .ts .late { color:#c0504d; font-weight:600; }
  .tcard.muted .tm { color:var(--sl-muted); font-weight:500; }
  .tcard.done .tm { color:var(--c); }
  .tcard.wait .tm { color:var(--sl-muted); opacity:.5; }
  .td-move { display:flex; align-items:center; gap:.6rem; margin-top:.6rem; padding:.55rem .75rem; border-radius:12px; background:var(--sl-hover); font-size:.88rem; }
  .td-move[hidden] { display:none; }
  .td-move span { flex:1; min-width:0; }
  .td-move button { flex-shrink:0; border:0; border-radius:9px; padding:5px 12px; background:var(--sl-text); color:var(--sl-surface); font:inherit; font-weight:700; cursor:pointer; }
  .td-move button:disabled { opacity:.5; }
  .td-x { flex-shrink:0; width:34px; height:34px; border-radius:10px; border:0; background:none; color:var(--sl-muted); cursor:pointer; display:grid; place-items:center; }
  .td-x:hover { background:var(--sl-hover); color:var(--sl-text); }
  .td-x svg { width:18px; height:18px; }
  /* The full day, shown on a wider screen only. */
  .tdl, .tweek { display:none; }

  @media (min-width: 900px) {
    .td-back { padding:clamp(16px, 3vh, 32px) clamp(16px, 3vw, 40px); align-items:stretch; }
    .td-back .td-panel { width:min(1240px, 100%); max-height:none; height:100%; padding:22px 26px 20px; border-radius:20px; }
    .td-head { margin:0 0 18px; gap:1rem; }
    .td-x { margin-left:auto; }
    .td-date { order:-1; flex:0 1 auto; font-family:var(--disp); font-style:var(--hub-logo-style, italic); font-weight:600; font-size:1.9rem; color:var(--life-logo); margin-right:.4rem; }
    .td-cards { grid-template-columns:repeat(3, minmax(0, 1fr)); grid-auto-flow:row dense; grid-auto-rows:min-content; gap:14px; align-content:start; flex:1; padding:2px; }
    .tcard[data-id="cal"], .tcard[data-id="tasks"] { grid-row:span 3; }
    .tcard { min-height:0; padding:16px 18px 14px; gap:.2rem; border-radius:16px; cursor:default; }
    .tcard:active { transform:none; }
    .tcard .tl { font-size:1.2rem; cursor:pointer; }
    .tcard .tl::after { content:"open →"; float:right; margin-top:.3rem; font-family:var(--hub-body, system-ui, sans-serif); font-style:normal; font-size:.75rem; font-weight:600; color:var(--sl-dim); }
    .tcard:hover .tl::after { color:var(--a); }
    .tcard .tm { font-size:1.08rem; }
    .tcard .ts { font-size:.85rem; }
    .tdl { display:flex; flex-direction:column; margin-top:.7rem; padding-top:.4rem; border-top:1px solid var(--sl-line); }
    .tdl:empty { display:none; }
    .tdi { display:grid; grid-template-columns:5.4rem minmax(0, 1fr); gap:.7rem; align-items:baseline; padding:.42rem 0; font-size:.92rem; line-height:1.3; }
    .tdi + .tdi { border-top:1px dashed color-mix(in srgb, var(--sl-line) 70%, transparent); }
    .tdi .tt { color:var(--sl-muted); font-size:.82rem; font-variant-numeric:tabular-nums; white-space:nowrap; }
    .tdl.notime .tdi { grid-template-columns:minmax(0, 1fr); }
    .tdl.notime .tt { display:none; }
    .tdi .tx { display:flex; gap:.5rem; align-items:baseline; min-width:0; }
    .tdi .tx > i { flex-shrink:0; width:9px; height:9px; border-radius:50%; background:var(--dot); translate:0 -1px; }
    .tdi .tx b { font-weight:600; overflow-wrap:anywhere; }
    .tdi .tx small { display:block; font-size:.8rem; color:var(--sl-muted); font-weight:400; }
    .tdi .tx small .late { color:#c0504d; font-weight:600; }
    .tdi.past { opacity:.45; }
    .tdi.now .tt, .tdi.now b { color:var(--a); }
    .tdi.done b { text-decoration:line-through; text-decoration-color:var(--sl-dim); color:var(--sl-muted); }
    .tdi.late .tt { color:#c0504d; }
    .tdl .more { font-size:.8rem; color:var(--sl-muted); padding:.4rem 0 0; }
    .tweek { display:flex; gap:.4rem; margin-top:.8rem; }
    .tweek span { flex:1; display:grid; place-items:center; gap:.25rem; font-size:.72rem; color:var(--sl-muted); }
    .tweek span i { width:20px; height:20px; border-radius:50%; border:2px solid var(--sl-line); }
    .tweek span.on i { background:var(--a); border-color:var(--a); }
    .td-move { margin-top:14px; }
  }
`;
const X = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>`;
const escHtml = (t) => String(t ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const MAX_ITEMS = 14;

// The full list under a card (wide screens): a time or label, then the thing.
function detail(r) {
  const items = r?.items || [];
  if (!items.length) return "";
  const rows = items.slice(0, MAX_ITEMS).map(x => `<span class="tdi${x.past ? " past" : ""}${x.now ? " now" : ""}${x.done ? " done" : ""}${x.late ? " late" : ""}">
    <span class="tt">${escHtml(x.time || "")}</span>
    <span class="tx">${x.colour ? `<i style="--dot:${escHtml(x.colour)}"></i>` : ""}<span><b>${escHtml(x.text)}</b>${x.sub ? `<small>${escHtml(x.sub)}</small>` : ""}</span></span></span>`).join("");
  const more = items.length > MAX_ITEMS ? `<span class="more">and ${items.length - MAX_ITEMS} more</span>` : "";
  return rows + more;
}

// A sun beside search opens it (or T); a card closes it and opens its app.
// `setup()` opens the connections box, for a card that has nothing to show yet.
export function mountToday({ open: openApp, setup = () => {}, enabled = () => true }) {
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.append(style);

  const back = document.createElement("div");
  back.className = "sl-back td-back"; back.hidden = true;
  back.innerHTML = `<div class="sl-panel td-panel" role="dialog" aria-modal="true" aria-label="Today">
    <div class="td-head"><div class="td-tabs" role="group">
      <button type="button" data-v="today">today<i>.</i></button><button type="button" data-v="tomorrow">tomorrow<i>.</i></button></div>
      <span class="td-date"></span><button type="button" class="td-x" aria-label="Close">${X}</button></div>
    <div class="td-cards"></div>
    <div class="td-move" hidden><span></span><button type="button">Move to tomorrow</button></div></div>`;
  document.body.append(back);
  const row = back.querySelector(".td-cards"), date = back.querySelector(".td-date");
  back.querySelector(".td-x").onclick = () => close();
  const wide = matchMedia("(min-width: 900px)");
  const move = back.querySelector(".td-move"), moveMsg = move.querySelector("span"), moveBtn = move.querySelector("button");

  const btn = document.createElement("button");
  btn.type = "button"; btn.className = "sl-btn td-btn"; btn.title = "Today (T)"; btn.setAttribute("aria-label", "Today");
  btn.innerHTML = SUN;
  btn.addEventListener("click", () => (back.hidden ? open() : close()));
  document.body.append(btn);

  let view = "today";
  const viewInfo = () => {
    const tomorrow = view === "tomorrow";
    return { tomorrow, day: tomorrow ? addDays(startOfToday(), 1) : startOfToday() };
  };

  const cards = CARDS.map(c => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "tcard wait";
    b.style.setProperty("--c", `var(--${c.id}-logo)`);
    b.style.setProperty("--a", `var(--${c.id}-accent)`);
    b.dataset.id = c.id;
    b.innerHTML = `<span class="tl">${c.label}<i>.</i></span><span class="tm">…</span><span class="ts"></span><span class="tdl"></span><span class="tweek"></span>`;
    b.onclick = (e) => {
      // Full page: the app opens from the card's name, so the lists can be read and selected.
      if (wide.matches && !e.target.closest(".tl") && !c.result?.action) return;
      const action = c.result?.action;
      if (action === "renew" && google.connect({ then: "today" })) return;
      close();
      if (action === "setup" || action === "renew") setup();
      else openApp(c.id, c.result?.url);
    };
    row.append(b);
    return { ...c, el: b, result: undefined };
  });

  let gen = 0;
  async function refresh() {
    const mine = ++gen;
    const info = viewInfo();
    back.querySelectorAll(".td-tabs button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.v === view)));
    date.textContent = info.day.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" }).toLowerCase();
    move.hidden = true;
    for (const c of cards) c.el.classList.add("wait");
    await Promise.all(cards.map(async (c) => {
      let r;
      try { r = await c.load(info); } catch (err) { console.warn(`today: ${c.label}:`, err); r = { main: "Couldn’t load", muted: true }; }
      if (mine !== gen) return;
      c.result = r;
      c.el.hidden = r === null;
      if (!r) return;
      c.el.className = `tcard${r.muted ? " muted" : ""}${r.done ? " done" : ""}`;
      c.el.querySelector(".tm").textContent = r.main;
      const ts = c.el.querySelector(".ts");
      if (r.subHtml) ts.innerHTML = r.sub || ""; else ts.textContent = r.sub || "";
      const list = c.el.querySelector(".tdl");
      list.innerHTML = detail(r);
      list.classList.toggle("notime", !(r.items || []).some(x => x.time));
      c.el.querySelector(".tweek").innerHTML = (r.week || []).map(d => `<span class="${d.done ? "on" : ""}"><i></i>${escHtml(d.label)}</span>`).join("");
    }));
    if (mine !== gen || !info.tomorrow || !leftovers.length) return;
    moveMsg.textContent = `${leftovers.length} task${leftovers.length === 1 ? "" : "s"} left from today`;
    moveBtn.disabled = false;
    moveBtn.textContent = "Move to tomorrow";
    move.hidden = false;
  }

  moveBtn.onclick = async () => {
    moveBtn.disabled = true;
    moveBtn.textContent = "Moving…";
    const { moved, failed } = await moveLeftovers();
    await refresh();
    move.hidden = false;
    moveBtn.hidden = !failed.length;
    moveBtn.textContent = "Try again";
    moveBtn.disabled = false;
    moveMsg.textContent = failed.length
      ? `Moved ${moved}. Couldn’t move ${failed.join(", ")}.`
      : `Moved ${moved} to tomorrow`;
    window.lifeosReload?.("tasks");
  };
  back.querySelector(".td-tabs").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b || b.dataset.v === view) return;
    view = b.dataset.v;
    moveBtn.hidden = false;
    refresh();
  });

  function open(as) {
    view = as || (new Date().getHours() >= EVENING ? "tomorrow" : "today");
    back.hidden = false;
    moveBtn.hidden = false;
    // Google's sign-in lasts an hour; renew it now (the page comes back here).
    if (google.renewQuietly("today")) return;
    refresh();
  }
  function close() { back.hidden = true; }
  back.addEventListener("click", (e) => { if (e.target === back) close(); });
  document.addEventListener("keydown", (e) => {
    if (!back.hidden && e.key === "Escape") { e.preventDefault(); close(); return; }
    if (!back.hidden || !enabled()) return;
    if (e.target.closest?.("input, textarea, select, [contenteditable], dialog[open]") || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "t" || e.key === "T") { e.preventDefault(); open(); }
  });

  return { open, close, refresh };
}
