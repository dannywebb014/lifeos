// "today." on the lifeOS picker: a pop-up with a card per app for what
// matters today, each opening its app when tapped.
//
//   import { mountToday } from "/lifeos/today.js";
//   mountToday({ open: (appId, url) => …, enabled });
//
// Cards: the next calendar event, tasks due today and overdue, tonight's
// dinner from food.'s plan, today's train. session, and the breathe. streak.
// Each loads on its own and keeps quiet if it can't (no data, no sign-in),
// so one slow or broken app never holds up the rest.

import { supabase } from "./auth.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const read = (k) => { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch { return null; } };
const pad = (n) => String(n).padStart(2, "0");
const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const BASE = "https://dannywebb014.github.io";

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

const SUN = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>`;

// It borrows search's look (spotlight.js), so mount that on the page too.
const CSS = `
  .td-btn { right:116px; }
  .td-panel { padding:14px 14px 12px; }
  .td-head { display:flex; align-items:baseline; gap:.5rem; margin:0 2px 10px; }
  .td-head h2 { font-family:var(--disp); font-style:var(--hub-logo-style, italic); font-weight:600; font-size:1.35rem; color:var(--life-logo); }
  .td-head h2 i { font-style:normal; color:var(--life-accent); }
  .td-head span { color:var(--sl-muted); font-size:.85rem; }
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
`;

// A sun beside search opens it (or T); a card closes it and opens its app.
export function mountToday({ open: openApp, enabled = () => true }) {
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.append(style);

  const back = document.createElement("div");
  back.className = "sl-back"; back.hidden = true;
  back.innerHTML = `<div class="sl-panel td-panel" role="dialog" aria-modal="true" aria-label="Today">
    <div class="td-head"><h2>today<i>.</i></h2><span></span></div>
    <div class="td-cards"></div></div>`;
  document.body.append(back);
  back.querySelector(".td-head span").textContent =
    new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" }).toLowerCase();
  const row = back.querySelector(".td-cards");

  const btn = document.createElement("button");
  btn.type = "button"; btn.className = "sl-btn td-btn"; btn.title = "Today (T)"; btn.setAttribute("aria-label", "Today");
  btn.innerHTML = SUN;
  btn.addEventListener("click", () => (back.hidden ? open() : close()));
  document.body.append(btn);

  const cards = CARDS.map(c => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "tcard wait";
    b.style.setProperty("--c", `var(--${c.id}-logo)`);
    b.style.setProperty("--a", `var(--${c.id}-accent)`);
    b.innerHTML = `<span class="tl">${c.label}<i>.</i></span><span class="tm">…</span><span class="ts"></span>`;
    b.onclick = () => { close(); openApp(c.id, c.result?.url); };
    row.append(b);
    return { ...c, el: b, result: undefined };
  });

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
    }));
  }

  function open() { back.hidden = false; refresh(); }
  function close() { back.hidden = true; }
  back.addEventListener("click", (e) => { if (e.target === back) close(); });
  document.addEventListener("keydown", (e) => {
    if (!back.hidden && e.key === "Escape") { e.preventDefault(); close(); return; }
    if (!back.hidden || !enabled()) return;
    if (e.target.closest?.("input, textarea, select, [contenteditable], dialog[open]") || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "t" || e.key === "T") { e.preventDefault(); open(); }
  });
  // Loaded once now, so the first open is quick.
  refresh();
  return { open, close, refresh };
}
