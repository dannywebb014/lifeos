// The "today" strip on the lifeOS picker: a card per app for what matters
// today, each opening its app when tapped.
//
//   import { mountToday } from "/lifeos/today.js";
//   const today = mountToday(element, { open: (appId, url) => … });
//   today.refresh();   // e.g. on coming back from an app
//
// Cards: the next calendar event, tasks due today and overdue, tonight's
// dinner from food.'s plan, today's train. session, and the breathe. streak.
// Each loads on its own and keeps quiet if it can't (no data, no sign-in),
// so one slow or broken app never holds up the rest. The strip folds down to
// a one-line summary; that choice stays on this device.

import { supabase } from "./auth.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const read = (k) => { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch { return null; } };
const pad = (n) => String(n).padStart(2, "0");
const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const BASE = "https://dannywebb014.github.io";
const FOLD_KEY = "lifeos.today.folded";

// ── calendar.: the next event left today, on the main calendar ──
// Uses calendar.'s Google sign-in (same site, same storage). Once it has
// run out, calendar. renews it the next time it opens.
async function calendar() {
  const { token, expires } = read("calendar.google") || {};
  if (!token || !(expires > Date.now())) return { main: "Open to sync", muted: true };
  const now = new Date();
  const url = new URL("https://www.googleapis.com/calendar/v3/calendars/primary/events");
  Object.entries({
    timeMin: now.toISOString(), timeMax: addDays(startOfToday(), 1).toISOString(),
    singleEvents: "true", orderBy: "startTime", maxResults: "20",
    fields: "items(summary,start,status,extendedProperties)",
  }).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Google ${res.status}`);
  const items = ((await res.json()).items || []).filter(e => e.status !== "cancelled" && e.start?.dateTime
    && e.extendedProperties?.private?.calhubDone !== "1");
  if (!items.length) return { main: "Nothing else today", muted: true, short: "" };
  const first = items[0];
  const at = hhmm(new Date(first.start.dateTime));
  return {
    main: `${at} ${first.summary || "(no title)"}`,
    sub: items.length > 1 ? `then ${items.length - 1} more` : "last one today",
    short: `${at} ${first.summary || ""}`.trim(),
  };
}

// ── tasks.: due today and overdue, in Craft and Todoist ──
// The connections are the ones saved in tasks. on this device.
async function tasks() {
  const settings = read("tasks.settings") || {};
  const key = (k) => String(k || "").replace(/[\s ​-‍﻿]/g, "");
  const today = isoDay(new Date());
  let due = 0, late = 0, any = false;
  const count = (date) => { if (!date) return; if (date < today) late++; else if (date === today) due++; };
  await Promise.all(Object.values(settings.spaces || {}).filter(s => s?.url).map(async (s) => {
    any = true;
    const m = String(s.url).match(/connect\.craft\.do\/links\/[^/?#\s]+/i);
    const base = m ? `https://${m[0]}/api/v1` : s.url.replace(/\/+$/, "");
    const headers = { Accept: "application/json" };
    if (key(s.key)) headers.Authorization = `Bearer ${key(s.key)}`;
    // As tasks. reads them: a dated task in the inbox may only be in "inbox".
    const seen = new Set();
    for (const scope of ["active", "inbox"]) {
      const res = await fetch(`${base}/tasks?scope=${scope}`, { headers });
      if (!res.ok) throw new Error(`Craft ${res.status}`);
      for (const t of (await res.json()).items || []) {
        if (t.taskInfo?.state !== "todo" || seen.has(t.id)) continue;
        seen.add(t.id);
        count(t.taskInfo?.scheduleDate);
      }
    }
  }));
  if (key(settings.todoist?.token)) {
    any = true;
    const res = await fetch("https://api.todoist.com/api/v1/tasks?limit=200", { headers: { Authorization: `Bearer ${key(settings.todoist.token)}` } });
    if (!res.ok) throw new Error(`Todoist ${res.status}`);
    const body = await res.json();
    for (const t of body.results || body.items || []) count(t.due?.date?.slice(0, 10));
  }
  if (!any) return { main: "Open to set up", muted: true };
  if (!due && !late) return { main: "All clear", sub: "nothing due today", short: "no tasks" };
  return {
    main: `${due + late} to do`,
    sub: late ? `<span class="late">${late} overdue</span>` : "all due today",
    subHtml: true,
    short: `${due + late} task${due + late === 1 ? "" : "s"}`,
  };
}

// ── food.: tonight's dinner on the plan ──
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
async function dinner() {
  const hid = await householdId();
  if (!hid) return null;
  const { data, error } = await supabase.from("meal_plan").select("recipe_id, note")
    .eq("household_id", hid).eq("day", DAY_NAMES[new Date().getDay()]).eq("meal", "Dinner");
  if (error) throw error;
  const row = data.find(r => r.recipe_id) || data.find(r => r.note);
  if (!row) return { main: "Nothing planned", sub: "dinner", muted: true, short: "" };
  if (!row.recipe_id) return { main: row.note, sub: "dinner", short: row.note };
  const r = await supabase.from("recipes").select("name").eq("id", row.recipe_id).maybeSingle();
  const name = r.data?.name || "A recipe";
  return { main: name, sub: data.length > 1 ? `dinner · +${data.length - 1} more` : "dinner", short: name, url: `${BASE}/foodhub/?recipe=${row.recipe_id}` };
}

// ── train.: today's session in the half marathon plan ──
// A copy of train.'s weekly schedule (fitnesshub index.html, schedFor): change
// both together. Monday and Friday are rest days.
const PLAN_START = new Date(2026, 8, 21), PLAN_WEEKS = 13;
function sessionFor(week, offset) {
  if (week === PLAN_WEEKS) return { 1: ["tue", "Race-week upper"], 3: ["thu", "Easy run"], 6: ["sun", "Half marathon 🏁"] }[offset];
  return {
    1: ["tue", "Strength A"], 2: ["wed", "Strength B"], 3: ["thu", "Football or run"],
    5: week % 2 === 0 ? ["sat", "Easy run"] : ["sat", "Strength C"], 6: ["sun", "Long run"],
  }[offset];
}
async function appState(app) {
  const { data, error } = await supabase.from("app_state").select("data").eq("app", app).maybeSingle();
  if (error) console.warn("app_state:", error.message);
  return data?.data || null;
}
async function training() {
  const days = Math.round((startOfToday() - PLAN_START) / 86400000);
  const week = Math.floor(days / 7) + 1;
  if (days < 0 || week > PLAN_WEEKS) return null;
  const s = sessionFor(week, days % 7);
  if (!s) return { main: "Rest day", sub: `week ${week}`, muted: true, short: "rest day" };
  const localKey = Object.keys(localStorage).find(k => k.startsWith("train:"));
  const data = (await appState("train")) || (localKey && read(localKey)) || {};
  const done = Boolean(data.logs?.[`w${week}-${s[0]}`]?.done);
  return { main: `${done ? "✓ " : ""}${s[1]}`, sub: done ? "done" : `week ${week}`, done, short: s[1].toLowerCase() };
}

// ── breathe.: the run of days practised ──
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
    short: doneToday ? "breathed" : "",
  };
}

const CARDS = [
  { id: "cal", label: "calendar", load: calendar },
  { id: "tasks", label: "tasks", load: tasks },
  { id: "food", label: "food", load: dinner },
  { id: "train", label: "train", load: training },
  { id: "breathe", label: "breathe", load: breathing },
];

const CSS = `
  .today { position:relative; width:100%; max-width:520px; margin-top:1rem; }
  .today-head { display:flex; align-items:center; gap:.4rem; width:100%; border:0; background:none; padding:.2rem .3rem; color:var(--muted);
    font:inherit; font-size:.8rem; font-weight:700; letter-spacing:.08em; text-transform:uppercase; cursor:pointer; text-align:left; }
  .today-head svg { width:12px; height:12px; flex-shrink:0; transition:transform .2s; }
  .today.folded .today-head svg { transform:rotate(-90deg); }
  .today-sum { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; text-transform:none; letter-spacing:0; font-weight:500; opacity:0; transition:opacity .2s; }
  .today.folded .today-sum { opacity:1; }
  .today-cards { display:flex; gap:.5rem; overflow-x:auto; scrollbar-width:none; padding:.4rem .1rem .3rem; scroll-snap-type:x proximity; }
  .today-cards::-webkit-scrollbar { display:none; }
  .today.folded .today-cards { display:none; }
  .tcard { flex:0 0 auto; width:9.2rem; min-height:4.6rem; padding:.55rem .7rem; border-radius:14px; text-align:left; cursor:pointer;
    background:var(--surface); border:1px solid var(--line); color:var(--text); font:inherit; scroll-snap-align:start;
    display:flex; flex-direction:column; gap:.15rem; }
  .tcard:active { transform:scale(.97); }
  .tcard .tl { font-family:var(--disp); font-style:var(--hub-logo-style, italic); font-weight:600; font-size:.88rem; color:var(--c); }
  .tcard .tl i { font-style:normal; color:var(--a); }
  .tcard .tm { font-weight:600; font-size:.95rem; line-height:1.2; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
  .tcard .ts { font-size:.78rem; color:var(--muted); }
  .tcard .ts .late { color:#c0504d; font-weight:600; }
  .tcard.muted .tm { color:var(--muted); font-weight:500; }
  .tcard.done .tm { color:var(--c); }
  .tcard.wait .tm { color:var(--muted); opacity:.5; }
`;

export function mountToday(el, { open }) {
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.append(style);

  el.classList.add("today");
  el.innerHTML = `<button class="today-head" type="button" aria-expanded="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
      <span>today</span><span class="today-sum"></span></button>
    <div class="today-cards"></div>`;
  const head = el.querySelector(".today-head"), sum = el.querySelector(".today-sum"), row = el.querySelector(".today-cards");

  const fold = (on) => {
    el.classList.toggle("folded", on);
    head.setAttribute("aria-expanded", String(!on));
    try { localStorage.setItem(FOLD_KEY, on ? "1" : "0"); } catch { /* private mode */ }
  };
  fold(localStorage.getItem(FOLD_KEY) === "1");
  head.onclick = () => fold(!el.classList.contains("folded"));

  const cards = CARDS.map(c => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "tcard wait";
    b.style.setProperty("--c", `var(--${c.id}-logo)`);
    b.style.setProperty("--a", `var(--${c.id}-accent)`);
    b.innerHTML = `<span class="tl">${c.label}<i>.</i></span><span class="tm">…</span><span class="ts"></span>`;
    row.append(b);
    return { ...c, el: b, result: undefined };
  });

  function paintSummary() {
    sum.textContent = cards.map(c => c.result?.short).filter(Boolean).join(" · ");
  }

  let gen = 0;
  async function refresh() {
    const mine = ++gen;
    await Promise.all(cards.map(async (c) => {
      let r;
      try { r = await c.load(); } catch (err) { console.warn(`today: ${c.label}:`, err); r = { main: "Couldn’t load", muted: true }; }
      if (mine !== gen) return;
      c.result = r;
      c.el.hidden = r === null;
      if (!r) return;
      c.el.className = `tcard${r.muted ? " muted" : ""}${r.done ? " done" : ""}`;
      c.el.querySelector(".tm").textContent = r.main;
      const ts = c.el.querySelector(".ts");
      if (r.subHtml) ts.innerHTML = r.sub || ""; else ts.textContent = r.sub || "";
      c.el.onclick = () => open(c.id, r.url);
      paintSummary();
    }));
  }
  for (const c of cards) c.el.onclick = () => open(c.id);
  refresh();
  return { refresh };
}
