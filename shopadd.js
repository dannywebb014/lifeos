// Quick add to food.'s shopping list, for the lifeOS picker.
//
//   import { mountShopAdd } from "/lifeos/shopadd.js";
//   mountShopAdd({ enabled });
//
// Adds a small basket beside search (top right) and opens a box from it, or
// with A. Typing searches the master list; Enter or a tap puts the item on
// the list, the way food.'s own quick-add bar does: an item not on the list is
// switched on, and one already ticked off as bought is unticked. A name that
// isn't on the master list can go on as a one-off. The box stays open for the
// next item; Escape clears, then closes.
//
// It borrows search's look (spotlight.js), so mount that on the page too.

import { supabase } from "./auth.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fold = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
// food. remembers a master item's tick under this key (see page.jsx).
const checkKey = (name) => `${name}||||m`;
const BASKET = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 9h14l-1.5 10.5a1 1 0 0 1-1 .5h-9a1 1 0 0 1-1-.5z"/><path d="m9 9 3-5 3 5"/></svg>`;

const CSS = `
  .sa-btn { right:66px; }
  .sa-hit { display:flex; align-items:center; gap:10px; width:100%; border:none; background:none; color:inherit; font:inherit; text-align:left; cursor:pointer; }
  .sa-hit .sl-t { flex:1; min-width:0; }
  .sa-tag { flex-shrink:0; font-size:.78rem; color:var(--sl-muted); }
  .sa-tag.on { color:var(--food); font-weight:600; }
  .sl-foot .ok { color:var(--food); font-weight:600; }
`;

export function mountShopAdd({ enabled = () => true } = {}) {
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.append(style);

  const back = document.createElement("div");
  back.className = "sl-back"; back.hidden = true;
  back.innerHTML = `<div class="sl-panel" role="dialog" aria-modal="true" aria-label="Add to the shopping list">
    <div class="sl-box">${BASKET}
      <input class="sl-q" type="search" placeholder="Add to the shopping list…" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="done" aria-label="Item to add"></div>
    <div class="sl-out" role="listbox"></div>
    <div class="sl-foot" aria-live="polite"></div></div>`;
  document.body.append(back);
  const q = back.querySelector(".sl-q"), out = back.querySelector(".sl-out"), foot = back.querySelector(".sl-foot");

  const btn = document.createElement("button");
  btn.type = "button"; btn.className = "sl-btn sa-btn"; btn.title = "Add to the shopping list (A)"; btn.setAttribute("aria-label", "Add to the shopping list");
  btn.innerHTML = BASKET;
  btn.addEventListener("click", open);
  document.body.append(btn);

  // ── Loading: the household, its master list, and what's ticked off ──
  // Fetched fresh each time it opens, so changes made in food. show up.
  let household = null, items = [], bought = new Set(), loadError = null, loading = null;
  const hint = `<span class="sl-hint">↑↓ to move · ↵ to add · esc to close</span>`;
  const say = (html) => { foot.innerHTML = html + hint; };
  function load() {
    loadError = null;
    say(`<span>Loading the master list…</span>`);
    return loading = (async () => {
      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) throw new Error("Not signed in");
        const p = await supabase.from("profiles").select("household_id").eq("id", user.id).single();
        if (p.error) throw p.error;
        household = p.data.household_id;
        const [m, c] = await Promise.all([
          supabase.from("master_items").select("id, name, category, active").eq("household_id", household),
          supabase.from("shop_checked").select("item_key").eq("household_id", household).eq("checked", true),
        ]);
        if (m.error) throw m.error;
        if (c.error) throw c.error;
        items = m.data.map(x => ({ ...x, f: fold(x.name) })).sort((a, b) => a.name.localeCompare(b.name));
        bought = new Set(c.data.map(x => x.item_key));
        say(`<span>${items.length} on the master list · ${items.filter(onList).length} on the shopping list</span>`);
      } catch (err) {
        console.error("shopping list:", err);
        loadError = err;
        say(`<span class="err">Couldn’t load the master list${navigator.onLine ? "" : " (offline)"}</span>`);
      }
      run();
    })();
  }
  const onList = (m) => m.active && !bought.has(checkKey(m.name));

  // ── Matching: names starting with what's typed first, then containing it ──
  let opts = [], sel = 0;
  function run() {
    const raw = q.value.trim(), t = fold(raw);
    opts = []; sel = 0;
    if (!t) { out.innerHTML = ""; return; }
    if (loadError) { out.innerHTML = `<p class="sl-empty">The master list didn’t load, so nothing can be added.</p>`; return; }
    const hits = items.filter(m => m.f.includes(t))
      .sort((a, b) => (a.f.startsWith(t) ? 0 : 1) - (b.f.startsWith(t) ? 0 : 1)).slice(0, 8);
    opts = hits.map(m => ({ m }));
    if (household && !items.some(m => m.f === t)) opts.push({ oneOff: raw });
    if (!opts.length) { out.innerHTML = `<p class="sl-empty">Loading…</p>`; return; }
    out.innerHTML = opts.map((o, i) => `<button type="button" class="sl-hit sa-hit${i === 0 ? " sel" : ""}" data-i="${i}" role="option">${o.m
      ? `<span class="sl-t">${esc(o.m.name)}</span><span class="sa-tag${onList(o.m) ? " on" : ""}">${onList(o.m) ? "on the list" : esc(o.m.category || "")}</span>`
      : `<span class="sl-t">Add “${esc(o.oneOff)}” as a one-off</span><span class="sa-tag">not on the master list</span>`}</button>`).join("");
  }
  function select(i) {
    if (!opts.length) return;
    sel = (i + opts.length) % opts.length;
    out.querySelectorAll(".sa-hit").forEach(h => h.classList.toggle("sel", Number(h.dataset.i) === sel));
    out.querySelector(`.sa-hit[data-i="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }

  // ── Adding ──
  async function add(o) {
    try {
      if (o.oneOff) {
        const { error } = await supabase.from("shop_extras").insert({ id: crypto.randomUUID(), household_id: household, name: o.oneOff, amount: "", unit: "" });
        if (error) throw error;
        done(o.oneOff);
        return;
      }
      const m = o.m;
      if (onList(m)) { say(`<span>${esc(m.name)} is already on the list</span>`); clear(); return; }
      if (!m.active) {
        const { error } = await supabase.from("master_items").update({ active: true }).eq("id", m.id);
        if (error) throw error;
        m.active = true;
      }
      if (bought.has(checkKey(m.name))) {
        const { error } = await supabase.from("shop_checked").upsert({ household_id: household, item_key: checkKey(m.name), checked: false });
        if (error) throw error;
        bought.delete(checkKey(m.name));
      }
      done(m.name);
    } catch (err) {
      console.error("shopping list add:", err);
      say(`<span class="err">Couldn’t add ${esc(o.oneOff || o.m.name)}${navigator.onLine ? "" : " (offline)"}</span>`);
    }
  }
  function done(name) { say(`<span class="ok">Added ${esc(name)}</span>`); clear(); }
  function clear() { q.value = ""; run(); q.focus(); }

  // ── Opening and closing ──
  function open() {
    back.hidden = false;
    q.value = ""; run();
    q.focus();
    load();
  }
  function close() { back.hidden = true; }
  q.addEventListener("input", run);
  q.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); select(sel + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); select(sel - 1); }
    else if (e.key === "Enter") { e.preventDefault(); if (opts[sel]) loading?.then(() => add(opts[sel])); }
    else if (e.key === "Escape") { e.preventDefault(); if (q.value) clear(); else close(); }
  });
  out.addEventListener("click", (e) => {
    const hit = e.target.closest(".sa-hit");
    if (hit) add(opts[Number(hit.dataset.i)]);
  });
  back.addEventListener("click", (e) => { if (e.target === back) close(); });

  // A from anywhere that isn't a text box or an open dialog.
  document.addEventListener("keydown", (e) => {
    if (!back.hidden || !enabled()) return;
    if (e.target.closest?.("input, textarea, select, [contenteditable], dialog[open]") || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "a" || e.key === "A") { e.preventDefault(); open(); }
  });

  return { open, close };
}
