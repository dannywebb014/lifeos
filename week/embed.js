import { supabase } from "/lifeos/auth.js";

// week.: the weekly review, kept in Supabase (week_reviews).
// Runs inside lifeOS or on its own page (index.html), through /lifeos/embed.js.
// The code is the app as it was on its own page; `document` below is
// embed.js's stand-in, which looks inside this app's shadow root.
import { fill, docFor } from "/lifeos/embed.js";

export async function mount(ctx) {
  const { root, host, asset } = ctx;
  await fill(root, { css: asset("./app.css"), html: asset("./app.html") });
  const document = docFor(ctx);

  // Signed in already: lifeOS (or this app's own page) checked before starting.
  const { data: { session } } = await supabase.auth.getSession();
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const read = (k) => { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch { return null; } };

  // ── Weeks run Monday to Sunday; dates are local YYYY-MM-DD ──
  const DAY = 86400000;
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const mondayOf = (d) => { const m = new Date(d.getFullYear(), d.getMonth(), d.getDate()); m.setDate(m.getDate() - ((m.getDay() + 6) % 7)); return m; };
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const fmt = (d, opts) => d.toLocaleDateString("en-GB", opts);
  const thisMonday = mondayOf(new Date());
  // On Monday and Tuesday the week to review is usually the one just gone.
  let monday = [1, 2].includes(new Date().getDay()) ? addDays(thisMonday, -7) : thisMonday;
  const fromHash = /^#(\d{4}-\d{2}-\d{2})$/.exec(ctx.url.hash);
  if (fromHash) monday = mondayOf(new Date(fromHash[1] + "T12:00:00"));

  const inWeek = (isoDate) => isoDate >= iso(monday) && isoDate <= iso(addDays(monday, 6));
  const money = (n) => `£${Math.round(n).toLocaleString("en-GB")}`;

  // ── The cards: each app's numbers, loaded on their own so one failing doesn't stop the rest ──
  const SOURCES = [
    { id: "train", title: "train", colour: "--train", load: training },
    { id: "breathe", title: "breathe", colour: "--breathe", load: breathing },
    { id: "food", title: "food", colour: "--food", load: food },
    { id: "tasks", title: "tasks", colour: "--tasks", load: tasks },
    { id: "money", title: "money", colour: "--money", load: spending },
    { id: "places", title: "places", colour: "--places", load: places },
  ];
  let stats = {};

  function card(src, body, muted = false) {
    return `<article class="card${muted ? " muted" : ""}" style="--c:var(${src.colour})" data-src="${src.id}">
      <h2>${src.title}<span class="dot">.</span></h2>${body}</article>`;
  }
  async function renderCards() {
    stats = {};
    $("cards").innerHTML = SOURCES.map(s => card(s, `<p class="loading">Loading…</p>`)).join("");
    await Promise.all(SOURCES.map(async (src) => {
      let html;
      try {
        const r = await src.load();
        stats[src.id] = r.stat ?? null;
        html = card(src, `<div class="big">${r.big}${r.unit ? `<small>${esc(r.unit)}</small>` : ""}</div>${r.lines?.length ? `<ul class="lines">${r.lines.map(l => `<li>${l}</li>`).join("")}</ul>` : ""}`, r.muted);
      } catch (err) {
        console.error(`${src.id}:`, err);
        html = card(src, `<p class="err">Couldn’t load: ${esc(err.message)}</p>`, true);
      }
      const el = document.querySelector(`[data-src="${src.id}"]`);
      if (el) el.outerHTML = html;
    }));
  }

  // train. and breathe. keep everything in one app_state row each; until a device
  // has synced, fall back to what's stored on this one.
  let appStates = null;
  async function appState(app) {
    appStates ||= supabase.from("app_state").select("app, data").then(({ data, error }) => {
      if (error) { console.warn("app_state:", error.message); return {}; }
      return Object.fromEntries(data.map(r => [r.app, r.data]));
    });
    return (await appStates)[app] || null;
  }

  // train.: sessions ticked off in that plan week, and the weigh-ins.
  async function training() {
    const key = Object.keys(localStorage).find(k => k.startsWith("train:"));
    const data = (await appState("train")) || (key && read(key));
    if (!data) return { big: "–", lines: ["No training saved yet."], muted: true };
    // The plan's first Monday, which train. saves with its data.
    const start = data.plan?.start ? new Date(...data.plan.start.split("-").map((n, i) => Number(n) - (i === 1 ? 1 : 0))) : null;
    const planWeek = start ? Math.floor((monday - start) / (7 * DAY)) + 1 : 0;
    const done = Object.entries(data.logs || {}).filter(([k, v]) => k.startsWith(`w${planWeek}-`) && v?.done).length;
    const weights = Object.entries(data.weights || {}).filter(([, v]) => v !== "" && !isNaN(parseFloat(v))).sort();
    const inside = weights.filter(([d]) => inWeek(d));
    const before = weights.filter(([d]) => d < iso(monday));
    const lines = [];
    if (planWeek >= 1) lines.push(`Plan week <b>${planWeek}</b>`);
    if (inside.length) {
      const last = parseFloat(inside.at(-1)[1]);
      const prev = before.length ? parseFloat(before.at(-1)[1]) : parseFloat(inside[0][1]);
      const diff = last - prev;
      lines.push(`Weight <b>${last.toFixed(1)} kg</b>${diff ? ` <span class="${diff > 0 ? "up" : "down"}">${diff > 0 ? "+" : "−"}${Math.abs(diff).toFixed(1)}</span>` : ""}`);
    } else lines.push("No weigh-in this week");
    return { big: done, unit: done === 1 ? "session" : "sessions", lines, stat: { sessions: done, weight: inside.length ? parseFloat(inside.at(-1)[1]) : null } };
  }

  // breathe.: days practised and minutes.
  async function breathing() {
    const s = (await appState("breathe")) || read("breathhub.v1");
    if (!s) return { big: "–", lines: ["No practice saved yet."], muted: true };
    const days = Object.keys(s.days || {}).filter(inWeek).length;
    let minutes = 0, sessions = 0;
    for (const entry of s.log || []) {
      const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(entry.d || "");
      if (!m || !inWeek(`${m[3]}-${m[2]}-${m[1]}`) || /^BOLT/.test(entry.n)) continue;
      sessions++;
      minutes += parseInt((/— (\d+) min/.exec(entry.n) || [])[1] || "0", 10);
    }
    return { big: days, unit: days === 1 ? "day" : "days", lines: [`<b>${sessions}</b> session${sessions === 1 ? "" : "s"} · <b>${minutes}</b> min`], stat: { days, minutes } };
  }

  async function householdId() {
    const key = `food.household.${session.user.id}`;
    const cached = localStorage.getItem(key);
    if (cached) return cached;
    const { data, error } = await supabase.from("profiles").select("household_id").eq("id", session.user.id).maybeSingle();
    if (error) throw error;
    if (data?.household_id) localStorage.setItem(key, data.household_id);
    return data?.household_id;
  }

  // food.: the meals on this week's plan, and recipes added during it.
  async function food() {
    const hid = await householdId();
    if (!hid) return { big: "–", lines: ["No food. household yet."], muted: true };
    const [plan, added] = await Promise.all([
      supabase.from("meal_plan").select("meal, recipe_id, note").eq("household_id", hid),
      supabase.from("recipes").select("name, created_at").eq("household_id", hid)
        .gte("created_at", monday.toISOString()).lt("created_at", addDays(monday, 7).toISOString()),
    ]);
    if (plan.error) throw plan.error;
    if (added.error) throw added.error;
    const meals = (plan.data || []).filter(r => r.recipe_id || r.note).length;
    const lines = [`<b>${added.data.length}</b> new recipe${added.data.length === 1 ? "" : "s"}${added.data.length ? `: ${added.data.slice(0, 2).map(r => esc(r.name)).join(", ")}${added.data.length > 2 ? "…" : ""}` : ""}`];
    if (iso(monday) !== iso(thisMonday)) lines.push(`<span>The plan shows the current week</span>`);
    return { big: meals, unit: "meals planned", lines, stat: { meals, newRecipes: added.data.length } };
  }

  // money.: spending against the week before, and where it went.
  async function spending() {
    const from = iso(addDays(monday, -7)), to = iso(addDays(monday, 6));
    const { data, error } = await supabase.from("money_transactions")
      .select("amount, date, money_categories(name)").eq("type", "expense").gte("date", from).lte("date", to);
    if (error) throw error;
    const rows = data || [];
    const total = (list) => list.reduce((t, r) => t + Math.abs(Number(r.amount) || 0), 0);
    const now = rows.filter(r => inWeek(r.date));
    const before = rows.filter(r => !inWeek(r.date));
    if (!rows.length) return { big: "–", lines: ["No spending recorded."], muted: true };
    const spent = total(now), was = total(before);
    const byCat = {};
    for (const r of now) { const c = r.money_categories?.name || "Other"; byCat[c] = (byCat[c] || 0) + Math.abs(Number(r.amount) || 0); }
    const top = Object.entries(byCat).sort((a, b) => b[1] - a[1]).slice(0, 3);
    const lines = [];
    if (was) { const d = spent - was; lines.push(`<span class="${d > 0 ? "up" : "down"}">${d > 0 ? "+" : "−"}${money(Math.abs(d))}</span> on the week before`); }
    if (top.length) lines.push(top.map(([c, v]) => `${esc(c)} <b>${money(v)}</b>`).join(" · "));
    return { big: money(spent), unit: "spent", lines, stat: { spent: Math.round(spent) } };
  }

  // places.: saved and visited.
  async function places() {
    const [saved, visited] = await Promise.all([
      supabase.from("places_places").select("name").gte("created_at", monday.toISOString()).lt("created_at", addDays(monday, 7).toISOString()),
      supabase.from("places_places").select("name").gte("visited_on", iso(monday)).lte("visited_on", iso(addDays(monday, 6))),
    ]);
    if (saved.error) throw saved.error;
    if (visited.error) throw visited.error;
    const names = visited.data.slice(0, 3).map(p => esc(p.name)).join(", ");
    return { big: visited.data.length, unit: "visited", lines: [`<b>${saved.data.length}</b> new saved${names ? ` · ${names}` : ""}`], stat: { visited: visited.data.length, saved: saved.data.length } };
  }

  // Tasks finished: lifeOS, Craft (the connections saved in tasks.) and Todoist.
  async function tasks() {
    // A list trying lifeOS tasks has no Craft or Todoist here (hubtasks.js).
    const { effective } = await import("/lifeos/shared/hubtasks.js?v=5");
    const settings = effective(read("tasks.settings") || {});
    const from = monday, to = addDays(monday, 7);
    let craftDone = 0, craftUnknown = 0, todoistDone = 0, ownDone = 0;
    const problems = [];
    const cleanKey = (k) => String(k || "").replace(/[\s ​-‍﻿]/g, "");
    await Promise.all(Object.values(settings.spaces || {}).filter(s => s?.url).map(async (space) => {
      try {
        const m = String(space.url).match(/connect\.craft\.do\/links\/[^/?#\s]+/i);
        const base = m ? `https://${m[0]}/api/v1` : space.url.replace(/\/+$/, "");
        const headers = { Accept: "application/json" };
        if (cleanKey(space.key)) headers.Authorization = `Bearer ${cleanKey(space.key)}`;
        const res = await fetch(`${base}/tasks?scope=logbook`, { headers });
        if (!res.ok) throw new Error(`Craft ${res.status}`);
        for (const t of (await res.json()).items || []) {
          const when = t.taskInfo?.completedAt || t.taskInfo?.completionDate || t.completedAt || t.taskInfo?.doneDate || t.updatedAt;
          if (!when) { craftUnknown++; continue; }
          const d = new Date(when);
          if (d >= from && d < to) craftDone++;
        }
      } catch (err) { problems.push(err.message); }
    }));
    try {
      const { countDone } = await import("/lifeos/shared/hubtasks.js?v=5");
      ownDone = await countDone(from, to);
    } catch (err) { problems.push(`lifeOS (${err.message})`); }
    const token = cleanKey(settings.todoist?.token);
    if (token) {
      try {
        const url = `https://api.todoist.com/api/v1/tasks/completed/by_completion_date?since=${encodeURIComponent(from.toISOString())}&until=${encodeURIComponent(to.toISOString())}&limit=200`;
        const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) throw new Error(`Todoist ${res.status}`);
        const body = await res.json();
        todoistDone = (body.items || body.results || []).length;
      } catch (err) { problems.push(err.message); }
    }
    const lines = [[ownDone || (!settings.spaces && !token) ? `lifeOS <b>${ownDone}</b>` : "", settings.spaces ? `Craft <b>${craftDone}</b>` : "", token ? `Todoist <b>${todoistDone}</b>` : ""].filter(Boolean).join(" · ")];
    if (craftUnknown) lines.push(`${craftUnknown} finished in Craft with no date`);
    if (problems.length) lines.push(`<span class="up">Couldn’t reach ${esc(problems.join(", "))}</span>`);
    return { big: ownDone + craftDone + todoistDone, unit: "done", lines, stat: { lifeos: ownDone, craft: craftDone, todoist: todoistDone } };
  }

  // ── The review: rating and three questions, saved as you go ──
  const FIELDS = ["went_well", "didnt", "next_three"];
  let review = {}, saveTimer = null, tableMissing = false;
  $("rating").innerHTML = Array.from({ length: 10 }, (_, i) => `<button type="button" data-rate="${i + 1}" aria-pressed="false">${i + 1}</button>`).join("");

  function paintReview() {
    document.querySelectorAll("[data-rate]").forEach(b => b.setAttribute("aria-pressed", String(Number(b.dataset.rate) === review.rating)));
    for (const f of FIELDS) $(f).value = review[f] || "";
  }
  function status(text, err = false) { $("status").textContent = text; $("status").className = `status${err ? " err" : ""}`; }
  const missing = (error) => /relation .* does not exist|PGRST205|Could not find the table/i.test(`${error?.code} ${error?.message}`);

  async function loadReview() {
    review = {}; paintReview(); status("");
    const { data, error } = await supabase.from("week_reviews").select("*").eq("week_start", iso(monday)).maybeSingle();
    if (error) {
      tableMissing = missing(error);
      status(tableMissing ? "Saving isn’t set up yet: run lifeos/week/setup.sql in Supabase." : `Couldn’t load your answers: ${error.message}`, true);
      return;
    }
    review = data || {};
    paintReview();
    if (data?.updated_at) status(`Saved ${new Date(data.updated_at).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" })}`);
  }
  function queueSave() {
    clearTimeout(saveTimer);
    status("Saving…");
    saveTimer = setTimeout(save, 800);
  }
  async function save() {
    const row = { user_id: session.user.id, week_start: iso(monday), rating: review.rating ?? null, stats, updated_at: new Date().toISOString() };
    for (const f of FIELDS) row[f] = review[f] || "";
    const { error } = await supabase.from("week_reviews").upsert(row);
    if (error) { status(missing(error) ? "Saving isn’t set up yet: run lifeos/week/setup.sql in Supabase." : `Not saved: ${error.message}`, true); return; }
    status("Saved");
    loadPast();
  }
  $("rating").addEventListener("click", (e) => {
    const b = e.target.closest("[data-rate]"); if (!b) return;
    const n = Number(b.dataset.rate);
    review.rating = review.rating === n ? null : n;
    paintReview(); queueSave();
  });
  for (const f of FIELDS) $(f).addEventListener("input", () => { review[f] = $(f).value; queueSave(); });

  async function loadPast() {
    const { data, error } = await supabase.from("week_reviews").select("week_start, rating, went_well, next_three").order("week_start", { ascending: false }).limit(12);
    if (error) { $("past").innerHTML = `<p class="note">${missing(error) ? "Past weeks appear here once saving is set up." : esc(error.message)}</p>`; return; }
    if (!data.length) { $("past").innerHTML = `<p class="note">Nothing saved yet. Your first review will appear here.</p>`; return; }
    $("past").innerHTML = data.map(r => {
      const d = new Date(r.week_start + "T12:00:00");
      const gist = (r.went_well || r.next_three || "").split("\n").find(Boolean) || "";
      return `<button type="button" data-week="${r.week_start}"><span class="when">${fmt(d, { day: "numeric", month: "short" })}</span><span class="score">${r.rating ? `${r.rating}/10` : "–"}</span><span class="gist">${esc(gist)}</span></button>`;
    }).join("");
  }
  $("past").addEventListener("click", (e) => { const b = e.target.closest("[data-week]"); if (b) go(new Date(b.dataset.week + "T12:00:00")); });

  // ── Moving between weeks ──
  function paintRange() {
    const end = addDays(monday, 6);
    $("range").textContent = `${fmt(monday, { day: "numeric", month: "short" })} – ${fmt(end, { day: "numeric", month: "short" })}`;
    $("next").disabled = monday >= thisMonday;
  }
  async function go(d) {
    if (saveTimer) { clearTimeout(saveTimer); await save(); }
    monday = mondayOf(d);
    // On its own page the week goes in the address; inside lifeOS the address is lifeOS's.
    if (ctx.standalone) history.replaceState(null, "", `#${iso(monday)}`);
    paintRange();
    await Promise.all([renderCards(), loadReview()]);
  }
  $("prev").addEventListener("click", () => go(addDays(monday, -7)));
  $("next").addEventListener("click", () => go(addDays(monday, 7)));

  paintRange();
  await Promise.all([renderCards(), loadReview(), loadPast()]);

  return { unmount: () => document.off() };
}
