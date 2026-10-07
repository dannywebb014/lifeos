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
// move them all over. The first time lifeOS is opened each morning (5am to
// noon) and each evening (from 6pm) it opens by itself, once per slot.
// An expired Google sign-in is renewed quietly when it opens (google.js).

import { supabase } from "./auth.js";
import * as google from "./google.js?v=1";
import * as todoist from "./shared/todoist.js?v=19";
import * as hub from "./shared/hubtasks.js?v=4";

const read = (k) => { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch { return null; } };
const pad = (n) => String(n).padStart(2, "0");
const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const cleanKey = (k) => String(k || "").replace(/[\s ​-‍﻿]/g, "");
const BASE = "https://dannywebb014.github.io";
const AUTO_KEY = "lifeos.today.auto";
const EVENING = 18;

// Each loader gets the view: { day (midnight of the day shown), tomorrow }.

// ── calendar.: the next event left today, or tomorrow's first ──
async function calendar({ day, tomorrow }) {
  const { token } = google.auth();
  if (!google.isConnected()) {
    return google.clientId() ? { main: "Tap to renew", sub: "Google sign-in ran out", muted: true, action: "renew" }
      : { main: "Not connected", sub: "set up in connections", muted: true, action: "setup" };
  }
  const url = new URL("https://www.googleapis.com/calendar/v3/calendars/primary/events");
  Object.entries({
    timeMin: (tomorrow ? day : new Date()).toISOString(), timeMax: addDays(day, 1).toISOString(),
    singleEvents: "true", orderBy: "startTime", maxResults: "30",
    fields: "items(summary,start,status,extendedProperties)",
  }).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Google ${res.status}`);
  const items = ((await res.json()).items || []).filter(e => e.status !== "cancelled" && e.start?.dateTime
    && e.extendedProperties?.private?.calhubDone !== "1");
  if (!items.length) return { main: tomorrow ? "Nothing booked" : "Nothing else today", muted: true };
  const first = items[0];
  return {
    main: `${hhmm(new Date(first.start.dateTime))} ${first.summary || "(no title)"}`,
    sub: items.length > 1 ? `${tomorrow ? "first of" : "then"} ${tomorrow ? items.length : items.length - 1}${tomorrow ? "" : " more"}` : tomorrow ? "the only one" : "last one today",
  };
}

// ── tasks.: due on the day shown, and what's left over from before ──
// The connections are the ones saved in tasks. on this device. Each task
// left over is kept in `leftovers`, for moving them all to tomorrow.
let leftovers = [];   // { spaceId, id, text, todoist?, builtin? }
async function tasks({ day, tomorrow }) {
  const settings = read("tasks.settings") || {};
  const today = isoDay(new Date()), shown = isoDay(day);
  let due = 0, late = 0, high = 0, any = false;
  const found = [];
  // Red (high priority) ones due on the day shown or before are counted too.
  const seenTask = (spaceId, id, text, date, todo, builtin = false, priority = 0) => {
    if (!date) return;
    if (date === shown) due++;
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
  if (!any) return { main: tomorrow ? "Nothing yet" : "All clear", sub: tomorrow ? "nothing for tomorrow" : "nothing due today", muted: true };
  if (tomorrow) {
    return {
      main: due ? `${due} for tomorrow` : "Nothing yet",
      sub: late ? `<span class="late">${late} left from today</span>` : "today’s all done",
      subHtml: true, muted: !due && !late,
    };
  }
  if (!due && !late) return { main: "All clear", sub: "nothing due today" };
  const red = high ? ` · <span class="late">${high} high</span>` : "";
  return {
    main: `${due + late} to do`,
    sub: (late ? `<span class="late">${late} overdue</span>` : "all due today") + red,
    subHtml: true,
  };
}

// Moves every task left over (due today or before) to tomorrow, as tasks.'
// "move all to tomorrow" does: Craft by date, Todoist keeping a repeat, and
// any time block on the calendar along with it. Resolves { moved, failed }.
async function moveLeftovers() {
  const settings = read("tasks.settings") || {};
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
async function dinner({ day }) {
  const hid = await householdId();
  if (!hid) return null;
  const { data, error } = await supabase.from("meal_plan").select("recipe_id, note")
    .eq("household_id", hid).eq("day", DAY_NAMES[day.getDay()]).eq("meal", "Dinner");
  if (error) throw error;
  const row = data.find(r => r.recipe_id) || data.find(r => r.note);
  if (!row) return { main: "Nothing planned", sub: "dinner", muted: true };
  if (!row.recipe_id) return { main: row.note, sub: "dinner" };
  const r = await supabase.from("recipes").select("name").eq("id", row.recipe_id).maybeSingle();
  return { main: r.data?.name || "A recipe", sub: data.length > 1 ? `dinner · +${data.length - 1} more` : "dinner", url: `${BASE}/foodhub/?recipe=${row.recipe_id}` };
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
  const s = plan.weeks[week - 1].find(x => x.offset === days % 7);
  if (!s) return { main: "Rest day", sub: `week ${week}`, muted: true };
  const done = Boolean(data.logs?.[`w${week}-${s.key}`]?.done);
  return { main: `${done ? "✓ " : ""}${s.title}`, sub: done ? "done" : `week ${week}`, done };
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
  return {
    main: doneToday ? "✓ Done today" : "Not yet today",
    sub: streak ? `${streak}-day streak` : "start a streak",
    done: doneToday, muted: !doneToday && !streak,
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
  .td-head { display:flex; align-items:center; gap:.6rem; margin:0 2px 10px; flex-wrap:wrap; }
  .td-tabs { display:flex; gap:2px; padding:2px; border-radius:999px; background:var(--sl-hover); }
  .td-tabs button { border:0; background:none; border-radius:999px; padding:.2rem .75rem; cursor:pointer; color:var(--sl-muted);
    font-family:var(--disp); font-style:var(--hub-logo-style, italic); font-weight:600; font-size:1.1rem; }
  .td-tabs button i { font-style:normal; color:var(--life-accent); }
  .td-tabs button[aria-pressed="true"] { background:var(--sl-surface); color:var(--life-logo); box-shadow:var(--sl-shadow); }
  .td-date { color:var(--sl-muted); font-size:.85rem; }
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
`;

// A sun beside search opens it (or T); a card closes it and opens its app.
// `setup()` opens the connections box, for a card that has nothing to show yet.
export function mountToday({ open: openApp, setup = () => {}, enabled = () => true }) {
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.append(style);

  const back = document.createElement("div");
  back.className = "sl-back"; back.hidden = true;
  back.innerHTML = `<div class="sl-panel td-panel" role="dialog" aria-modal="true" aria-label="Today">
    <div class="td-head"><div class="td-tabs" role="group">
      <button type="button" data-v="today">today<i>.</i></button><button type="button" data-v="tomorrow">tomorrow<i>.</i></button></div>
      <span class="td-date"></span></div>
    <div class="td-cards"></div>
    <div class="td-move" hidden><span></span><button type="button">Move to tomorrow</button></div></div>`;
  document.body.append(back);
  const row = back.querySelector(".td-cards"), date = back.querySelector(".td-date");
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
    b.innerHTML = `<span class="tl">${c.label}<i>.</i></span><span class="tm">…</span><span class="ts"></span>`;
    b.onclick = () => {
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

  // Opens by itself the first time each morning and each evening.
  function autoOpen() {
    const h = new Date().getHours();
    const slot = h >= 5 && h < 12 ? "morning" : h >= EVENING ? "evening" : "";
    if (!slot) return false;
    const mark = `${isoDay(new Date())}:${slot}`;
    let last = null;
    try { last = localStorage.getItem(AUTO_KEY); } catch { /* private mode */ }
    if (last === mark) return false;
    try { localStorage.setItem(AUTO_KEY, mark); } catch { return false; }
    open();
    return true;
  }

  return { open, close, refresh, autoOpen };
}
