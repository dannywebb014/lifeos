// Spotlight-style search across the hub apps, for any lifeOS page.
//
//   import { mountSpotlight } from "/lifeos/spotlight.js";
//   mountSpotlight();
//
// Options: `go(href)` opens a result itself and returns true (the lifeOS
// picker opens it in that app's tab), else the page goes there. `enabled()`
// says whether the keys may open it (not while the picker shows an app).
//
// Adds a small magnifying glass (top right) and opens a search box over the page
// from it, or with S, / or ⌘K / Ctrl+K. Everything it searches loads the first
// time it opens; after that each letter filters instantly. Enter or a tap opens
// the result; Escape or a click outside closes it.

import { supabase } from "./auth.js";

const BASE = "https://dannywebb014.github.io";
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const read = (k) => { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch { return null; } };
const fold = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const words = (v) => (Array.isArray(v) ? v : [v]).flat(Infinity).filter(x => x != null && x !== "").map(String).join(" ");

// ── What it searches. Each entry: { title, sub, text (searched), href } ──
const SOURCES = [
  { id: "food", name: "food", load: async () => {
    const { data, error } = await supabase.from("recipes").select("id, name, cuisine, tags, ingredients, source").order("name");
    if (error) throw error;
    return data.map(r => ({ title: r.name, sub: [r.cuisine, (r.tags || []).slice(0, 3).join(", ")].filter(Boolean).join(" · "),
      text: words([r.name, r.cuisine, r.tags, r.source, (r.ingredients || []).map(i => i?.name)]), href: `${BASE}/foodhub/?recipe=${r.id}` }));
  } },
  { id: "places", name: "places", load: async () => {
    const { data, error } = await supabase.from("places_places").select("id, name, address, type_label, note, visit_note").order("name");
    if (error) throw error;
    return data.map(p => ({ title: p.name, sub: [p.type_label, p.address].filter(Boolean).join(" · "), text: words([p.name, p.address, p.type_label, p.note, p.visit_note]), href: `${BASE}/places/` }));
  } },
  { id: "tasks", name: "tasks", load: tasks },
  { id: "media", name: "media", load: async () => {
    const cache = read("media.cache");
    return (cache?.collections || []).flatMap(c => (c.items || []).map(it => ({
      title: it.title || "Untitled", sub: `${c.docTitle} · ${c.name}`,
      text: words([it.title, c.name, Object.values(it.props || {}).map(v => typeof v === "object" ? Object.values(v || {}) : v), it.preview]),
      href: `${BASE}/mediahub/?col=${encodeURIComponent(c.id)}&item=${encodeURIComponent(it.id)}` })));
  } },
  { id: "wish", name: "wish", load: async () => {
    const [i, p] = await Promise.all([
      supabase.from("wish_items").select("id, name, notes, url, person_id, status"),
      supabase.from("wish_people").select("id, name"),
    ]);
    if (i.error) throw i.error;
    const who = Object.fromEntries((p.data || []).map(x => [x.id, x.name]));
    return i.data.map(w => ({ title: w.name, sub: `${w.person_id ? `for ${who[w.person_id] || "someone"}` : "my wishlist"}${w.status !== "open" ? ` · ${w.status === "given" ? "given" : "got it"}` : ""}`,
      text: words([w.name, w.notes, w.url, who[w.person_id]]), href: `${BASE}/lifeos/wish/#${w.id}` }));
  } },
  { id: "motivation", name: "motivation", load: async () => {
    const { data, error } = await supabase.from("motivation_quotes").select("text, author");
    if (error) throw error;
    return data.map(q => ({ title: q.text, sub: q.author || "", text: words([q.text, q.author]), href: `${BASE}/motivation/` }));
  } },
  { id: "week", name: "week", load: async () => {
    const { data, error } = await supabase.from("week_reviews").select("week_start, went_well, didnt, next_three, rating").order("week_start", { ascending: false });
    if (error) throw error;
    return data.map(r => {
      const d = new Date(r.week_start + "T12:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
      return { title: `Week of ${d}${r.rating ? ` · ${r.rating}/10` : ""}`, sub: (r.went_well || r.next_three || "").split("\n")[0],
        text: words([r.went_well, r.didnt, r.next_three]), href: `${BASE}/lifeos/week/#${r.week_start}` };
    });
  } },
];

// Open tasks from lifeOS, Craft (the connections saved in tasks.) and Todoist.
async function tasks() {
  const settings = read("tasks.settings") || {};
  const { loadTasks } = await import("./shared/hubtasks.js?v=2");
  const spaceName = { my: "my space.", work: "work.", todoist: "joint." };
  const out = (await loadTasks()).map(t => ({ title: t.text, sub: `${spaceName[t.spaceId] || t.spaceId}${t.date ? ` · ${t.date}` : ""}`, text: t.text, href: `${BASE}/taskhub/` }));
  const key = (k) => String(k || "").replace(/[\s ​-‍﻿]/g, "");
  const labels = { my: "my space.", work: "work." };
  await Promise.all(Object.entries(settings.spaces || {}).filter(([, s]) => s?.url).map(async ([id, s]) => {
    const m = String(s.url).match(/connect\.craft\.do\/links\/[^/?#\s]+/i);
    const base = m ? `https://${m[0]}/api/v1` : s.url.replace(/\/+$/, "");
    const headers = { Accept: "application/json" };
    if (key(s.key)) headers.Authorization = `Bearer ${key(s.key)}`;
    const seen = new Set();
    // "all" adds tasks in documents with no date, which the other three
    // leave out; it also holds trashed and template ones, which are skipped.
    const get = async (path) => { const res = await fetch(base + path, { headers }); if (!res.ok) throw new Error(`Craft ${res.status}`); return (await res.json()).items || []; };
    const undated = await Promise.all([get("/tasks?scope=all"), get("/documents?location=trash"), get("/documents?location=templates")])
      .then(([all, trash, templates]) => { const skip = new Set([...trash, ...templates].map(d => d.id));
        return all.filter(t => t.location?.type === "document" && !skip.has(t.location.documentId)); })
      .catch(() => []);
    for (const scope of ["active", "upcoming", "inbox", "all"]) {
      const items = scope === "all" ? undated : await get(`/tasks?scope=${scope}`);
      for (const t of items) {
        if (t.taskInfo?.state !== "todo" || seen.has(t.id)) continue;
        seen.add(t.id);
        const text = String(t.markdown || "").replace(/^\s*[-*]\s*\[[ x]\]\s*/, "").trim();
        out.push({ title: text, sub: `${labels[id] || id}${t.taskInfo?.scheduleDate ? ` · ${t.taskInfo.scheduleDate}` : ""}`, text, href: `${BASE}/taskhub/` });
      }
    }
  }));
  const token = key(settings.todoist?.token);
  if (token) {
    const res = await fetch("https://api.todoist.com/api/v1/tasks?limit=200", { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Todoist ${res.status}`);
    const body = await res.json();
    for (const t of body.results || body.items || []) out.push({ title: t.content, sub: `joint.${t.due?.date ? ` · ${t.due.date}` : ""}`, text: words([t.content, t.description]), href: `${BASE}/taskhub/` });
  }
  return out;
}

const CSS = `
  .sl-btn { position:fixed; top:calc(14px + env(safe-area-inset-top)); right:16px; z-index:40; width:42px; height:42px; border-radius:12px;
    border:1px solid var(--sl-line); background:var(--sl-surface); color:var(--sl-muted); display:grid; place-items:center; cursor:pointer; box-shadow:var(--sl-shadow); }
  .sl-btn:hover { color:var(--sl-text); }
  .sl-btn svg { width:19px; height:19px; }
  .sl-back { position:fixed; inset:0; z-index:200; background:var(--sl-veil); -webkit-backdrop-filter:blur(6px); backdrop-filter:blur(6px);
    display:flex; justify-content:center; align-items:flex-start; padding:calc(10vh + env(safe-area-inset-top)) 16px 16px; }
  .sl-back[hidden] { display:none; }
  .sl-panel { width:min(640px, 100%); max-height:min(70vh, 640px); display:flex; flex-direction:column; background:var(--sl-surface); color:var(--sl-text);
    border:1px solid var(--sl-line); border-radius:16px; box-shadow:0 24px 70px rgba(0,0,0,.28); overflow:hidden; font-family:var(--hub-body, system-ui, sans-serif); }
  .sl-box { position:relative; border-bottom:1px solid var(--sl-line); }
  .sl-box svg { position:absolute; left:18px; top:50%; translate:0 -50%; width:20px; height:20px; color:var(--sl-dim); }
  .sl-q { width:100%; border:none; background:none; outline:none; color:inherit; font:inherit; font-size:1.15rem; padding:17px 16px 17px 50px; }
  .sl-q::-webkit-search-cancel-button { display:none; }
  .sl-out { overflow-y:auto; padding:6px; }
  .sl-out:empty { display:none; }
  .sl-group { padding:6px 10px 2px; font-size:.72rem; font-weight:700; letter-spacing:.08em; text-transform:uppercase; color:var(--sl-dim); display:flex; gap:6px; align-items:center; }
  .sl-group i { width:8px; height:8px; border-radius:50%; background:var(--c); }
  .sl-hit { display:block; text-decoration:none; color:inherit; padding:8px 10px; border-radius:10px; }
  .sl-hit.sel, .sl-hit:hover { background:var(--sl-hover); }
  .sl-t { font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .sl-s { font-size:.85rem; color:var(--sl-muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .sl-hit mark { background:var(--sl-mark); color:inherit; border-radius:3px; padding:0 1px; }
  .sl-more { border:none; background:none; color:var(--sl-muted); font:inherit; font-size:.82rem; font-weight:600; padding:2px 10px 6px; cursor:pointer; }
  .sl-foot { border-top:1px solid var(--sl-line); padding:7px 14px; font-size:.75rem; color:var(--sl-dim); display:flex; flex-wrap:wrap; gap:4px 12px; }
  .sl-foot .err { color:#b54e4e; }
  .sl-hint { margin-left:auto; }
  @media (hover: none) { .sl-hint { display:none; } }
  .sl-empty { padding:18px 14px; color:var(--sl-muted); text-align:center; }
  .sl-back, .sl-btn { --sl-surface:#fffdf8; --sl-line:#e5dfd0; --sl-text:#2c2218; --sl-muted:#6b6055; --sl-dim:#a8a295; --sl-hover:#f2eee5;
    --sl-mark:#7d6fd630; --sl-veil:rgba(30,24,16,.25); --sl-shadow:0 1px 3px rgba(44,34,24,.06);
    --food:#3d6b3d; --places:#b8436d; --motivation:#3d6ba8; --media:#b08a1c; --tasks:#2f8a84; --wish:#c4475a; --week:#7d6fd6; }
  @media (prefers-color-scheme: dark) { .sl-back, .sl-btn { --sl-surface:#232823; --sl-line:#3a423a; --sl-text:#ebe8de; --sl-muted:#a8a89c; --sl-dim:#6b7568;
    --sl-hover:#2e342e; --sl-mark:#b4a9ff38; --sl-veil:rgba(0,0,0,.45); --sl-shadow:0 1px 4px rgba(0,0,0,.35);
    --food:#9fc89f; --places:#f0a8c4; --motivation:#9fc0e0; --media:#ecd27a; --tasks:#8fd0c9; --wish:#f2a7b0; --week:#b4a9ff; } }
`;

export function mountSpotlight({ button = true, go = () => false, enabled = () => true } = {}) {
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.append(style);

  const back = document.createElement("div");
  back.className = "sl-back"; back.hidden = true;
  back.innerHTML = `<div class="sl-panel" role="dialog" aria-modal="true" aria-label="Search">
    <div class="sl-box"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
      <input class="sl-q" type="search" placeholder="Search recipes, places, tasks, quotes…" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Search everything"></div>
    <div class="sl-out" role="listbox"></div>
    <div class="sl-foot" aria-live="polite"></div></div>`;
  document.body.append(back);
  const q = back.querySelector(".sl-q"), out = back.querySelector(".sl-out"), foot = back.querySelector(".sl-foot");

  if (button) {
    const btn = document.createElement("button");
    btn.type = "button"; btn.className = "sl-btn"; btn.title = "Search (S)"; btn.setAttribute("aria-label", "Search");
    btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>`;
    btn.addEventListener("click", open);
    document.body.append(btn);
  }

  // ── Loading, the first time it opens ──
  const index = {}, status = {};
  let loading = null;
  function paintFoot() {
    foot.innerHTML = SOURCES.map(s => {
      const st = status[s.id];
      if (st === undefined) return `<span>${s.name}…</span>`;
      if (st instanceof Error) return `<span class="err" title="${esc(st.message)}">${s.name}: couldn’t load</span>`;
      return st ? `<span>${st} in ${s.name}</span>` : "";
    }).join("") + `<span class="sl-hint">↑↓ to move · ↵ to open · esc to close</span>`;
  }
  function loadAll() {
    paintFoot();
    loading ||= Promise.all(SOURCES.map(async (s) => {
      try { index[s.id] = (await s.load()).map(e => ({ ...e, f: fold(`${e.title} ${e.text}`), ft: fold(e.title) })); status[s.id] = index[s.id].length; }
      catch (err) {
        const notSetUp = /does not exist|PGRST205|Could not find the table/i.test(`${err?.code} ${err?.message}`);
        if (!notSetUp) console.error(`search ${s.id}:`, err);
        status[s.id] = notSetUp ? 0 : err; index[s.id] = [];
      }
      paintFoot(); run();
    }));
  }

  // ── Matching: every word must appear; title matches rank first ──
  const expanded = new Set();
  let flat = [], sel = 0;
  function highlight(text, terms) {
    let html = esc(text);
    for (const t of terms) {
      const i = fold(text).indexOf(t);
      if (i < 0) continue;
      const raw = text.slice(i, i + t.length);
      html = html.replace(esc(raw), `<mark>${esc(raw)}</mark>`);
    }
    return html;
  }
  function why(e, terms) {
    const shown = fold(`${e.title} ${e.sub || ""}`);
    const hidden = terms.find(t => !shown.includes(t));
    if (!hidden) return e.sub;
    const i = fold(e.text).indexOf(hidden);
    if (i < 0) return e.sub;
    const start = Math.max(0, i - 30);
    return `${start ? "…" : ""}${e.text.slice(start, i + hidden.length + 40).trim()}…`;
  }
  function run() {
    const raw = q.value.trim();
    const terms = fold(raw).split(/\s+/).filter(Boolean);
    flat = []; sel = 0;
    if (!terms.length) { out.innerHTML = ""; return; }
    const groups = SOURCES.map(s => ({ s, hits: (index[s.id] || []).filter(e => terms.every(t => e.f.includes(t)))
      .map(e => ({ e, score: e.ft.startsWith(terms[0]) ? 0 : terms.every(t => e.ft.includes(t)) ? 1 : 2 }))
      .sort((a, b) => a.score - b.score || a.e.title.localeCompare(b.e.title)).map(x => x.e) }))
      .filter(g => g.hits.length)
      .sort((a, b) => (a.hits[0].ft.startsWith(terms[0]) ? 0 : 1) - (b.hits[0].ft.startsWith(terms[0]) ? 0 : 1));
    if (!groups.length) {
      const still = SOURCES.some(s => status[s.id] === undefined);
      out.innerHTML = `<p class="sl-empty">${still ? "Still loading some apps…" : `Nothing matches “${esc(raw)}”.`}</p>`;
      return;
    }
    out.innerHTML = groups.map(({ s, hits }) => {
      const shown = expanded.has(s.id) ? hits : hits.slice(0, 4);
      const rows = shown.map(e => { flat.push(e); const sub = why(e, terms);
        return `<a class="sl-hit${flat.length === 1 ? " sel" : ""}" href="${esc(e.href)}" data-i="${flat.length - 1}" role="option"><div class="sl-t">${highlight(e.title, terms)}</div>${sub ? `<div class="sl-s">${highlight(sub, terms)}</div>` : ""}</a>`; }).join("");
      const more = hits.length > shown.length ? `<button type="button" class="sl-more" data-more="${s.id}">Show all ${hits.length}</button>` : "";
      return `<div style="--c:var(--${s.id})"><div class="sl-group"><i></i>${s.name}.</div>${rows}${more}</div>`;
    }).join("");
  }
  function select(i) {
    if (!flat.length) return;
    sel = (i + flat.length) % flat.length;
    out.querySelectorAll(".sl-hit").forEach(h => h.classList.toggle("sel", Number(h.dataset.i) === sel));
    out.querySelector(`.sl-hit[data-i="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }

  // ── Opening and closing ──
  function open() {
    back.hidden = false;
    q.focus(); q.select();
    loadAll();
  }
  function close() { back.hidden = true; }
  q.addEventListener("input", () => { expanded.clear(); run(); });
  q.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); select(sel + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); select(sel - 1); }
    else if (e.key === "Enter") { e.preventDefault(); const h = flat[sel]; if (h) follow(h.href); }
    else if (e.key === "Escape") { e.preventDefault(); if (q.value) { q.value = ""; run(); } else close(); }
  });
  function follow(href) {
    if (go(href)) close();
    else location.href = href;
  }
  out.addEventListener("click", (e) => {
    const b = e.target.closest("[data-more]");
    if (b) { expanded.add(b.dataset.more); run(); q.focus(); return; }
    const hit = e.target.closest(".sl-hit");
    // A plain tap only: a modified click still opens a new tab as links do.
    if (hit && !e.metaKey && !e.ctrlKey && !e.shiftKey && go(hit.getAttribute("href"))) { e.preventDefault(); close(); }
  });
  back.addEventListener("click", (e) => { if (e.target === back) close(); });

  // S, / or ⌘K / Ctrl+K from anywhere that isn't a text box or an open dialog.
  document.addEventListener("keydown", (e) => {
    const typing = e.target.closest?.("input, textarea, select, [contenteditable], dialog[open]");
    if (back.hidden && !enabled()) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); back.hidden ? open() : close(); return; }
    if (typing || e.metaKey || e.ctrlKey || e.altKey || !back.hidden) return;
    if (e.key === "s" || e.key === "S" || e.key === "/") { e.preventDefault(); open(); }
  });

  return { open, close };
}
