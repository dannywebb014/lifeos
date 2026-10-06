// One box for putting anything into lifeOS, for the picker.
//
//   import { mountCapture } from "/lifeos/capture.js";
//   mountCapture({ enabled, added: (appIds) => … });
//
// A + beside search (top right), or A, opens it. Each line is one thing, and
// it works out where each goes, shown under the box before anything is added:
//   - shopping: "buy milk", "get eggs, butter" (a comma makes several), or a
//     line that is exactly an item on food.'s master list
//   - wish.: "want AirPods" for my wishlist; "… for Sam" (someone on a gift
//     list) or "gift for Sam: …" for theirs
//   - tasks.: everything else, read the way tasks. reads dictation (space,
//     date, time), with a time blocked out on the calendar
// Tapping a line's label sends it somewhere else instead. Enter adds them all;
// shift+Enter starts a new line. A line that fails stays in the box.
// `added` is told which apps changed, so the picker can reload their frames.

import { supabase } from "./auth.js";
import { shoppingList } from "./shopadd.js?v=2";
import { parseTasks, SPACES } from "./shared/parse.js?v=15";
import * as todoist from "./shared/todoist.js?v=15";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const read = (k) => { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch { return null; } };
const fold = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
const cap = (s) => s ? s[0].toUpperCase() + s.slice(1) : s;
const PLUS = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>`;
const KINDS = ["task", "shop", "wish"];
const KIND_LABEL = { task: "tasks.", shop: "shopping", wish: "wish." };

const CSS = `
  .cap-btn { right:66px; }
  .cap-q { display:block; width:100%; min-height:3.4rem; max-height:30vh; resize:none; border:none; background:none; outline:none; color:inherit;
    font:inherit; font-size:1.1rem; line-height:1.4; padding:16px 16px 14px 50px; }
  .sl-box svg.cap-ic { top:28px; }
  .cap-row { display:flex; align-items:center; gap:10px; padding:7px 10px; border-radius:10px; }
  .cap-kind { flex-shrink:0; min-width:5.4rem; border:1px solid var(--c); color:var(--c); background:none; border-radius:999px;
    font:inherit; font-size:.78rem; font-weight:700; padding:3px 9px; cursor:pointer; }
  .cap-kind.task { --c:var(--tasks); } .cap-kind.shop { --c:var(--food); } .cap-kind.wish { --c:var(--wish); }
  .cap-main { flex:1; min-width:0; }
  .cap-main .sl-s .on { color:var(--food); }
  .cap-state { flex-shrink:0; font-size:.78rem; color:var(--sl-muted); }
  .cap-state.ok { color:var(--food); font-weight:600; }
  .cap-state.err { color:#b54e4e; }
  .cap-go { margin-left:auto; border:none; border-radius:9px; padding:5px 14px; background:var(--sl-text); color:var(--sl-surface); font:inherit; font-weight:700; cursor:pointer; }
  .cap-go:disabled { opacity:.4; cursor:default; }
`;

// The date reader tasks. uses, fetched the first time the box opens.
let chrono = null, chronoLoading = null;
const loadChrono = () => chronoLoading ||= import("https://cdn.jsdelivr.net/npm/chrono-node@2.10.1/+esm").then(m => { chrono = m; });

const dayText = (iso) => {
  const d = new Date(iso + "T12:00");
  const t = new Date(); t.setHours(12, 0, 0, 0);
  const n = Math.round((d - t) / 86400000);
  return n === 0 ? "today" : n === 1 ? "tomorrow" : d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
};

export function mountCapture({ enabled = () => true, added = () => {} } = {}) {
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.append(style);

  const back = document.createElement("div");
  back.className = "sl-back"; back.hidden = true;
  back.innerHTML = `<div class="sl-panel" role="dialog" aria-modal="true" aria-label="Add anything">
    <div class="sl-box">${PLUS.replace("<svg", `<svg class="cap-ic"`)}
      <textarea class="cap-q" rows="1" placeholder="Add anything… a task, “buy milk”, “want AirPods”" autocapitalize="sentences" enterkeyhint="done" aria-label="What to add, one per line"></textarea></div>
    <div class="sl-out"></div>
    <div class="sl-foot" aria-live="polite"><span class="cap-msg"></span><button type="button" class="cap-go" disabled>Add</button></div></div>`;
  document.body.append(back);
  const q = back.querySelector(".cap-q"), out = back.querySelector(".sl-out"), msg = back.querySelector(".cap-msg"), go = back.querySelector(".cap-go");

  const btn = document.createElement("button");
  btn.type = "button"; btn.className = "sl-btn cap-btn"; btn.title = "Add anything (A)"; btn.setAttribute("aria-label", "Add anything");
  btn.innerHTML = PLUS;
  btn.addEventListener("click", open);
  document.body.append(btn);

  // ── What it needs: the shopping list, the people on gift lists, the task parser ──
  const shop = shoppingList();
  let people = [], ready = null, problems = [];
  const settings = () => read("tasks.settings") || {};
  function load() {
    problems = [];
    return ready = Promise.all([
      shop.load().catch(err => { console.error("capture: shopping list:", err); problems.push("the shopping list"); }),
      supabase.from("wish_people").select("id, name").then(({ data, error }) => {
        if (error) { console.error("capture: wish people:", error); problems.push("gift lists"); return; }
        people = data;
      }),
      loadChrono().catch(err => { console.error("capture: date reader:", err); problems.push("the date reader"); }),
    ]).then(() => { paint(); });
  }

  // ── Working out where each line goes ──
  let lines = [];          // { raw, kind, chosen (a kind tapped), state, note }
  const personIn = (text) => {
    for (const p of [...people].sort((a, b) => b.name.length - a.name.length)) {
      const n = p.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      let m = text.match(new RegExp(`^(?:gift|present)s?\\s+(?:idea\\s+)?for\\s+${n}\\s*[:,\\-–—]?\\s*(.+)$`, "i"));
      if (m) return { person: p, name: m[1] };
      m = text.match(new RegExp(`^(.+?)\\s+for\\s+${n}$`, "i"));
      if (m) return { person: p, name: m[1].replace(/^(?:get|buy|gift)\s+/i, "") };
    }
    return null;
  };
  function guess(raw) {
    const t = raw.trim();
    if (/^(?:shop(?:ping)?\s*[:\-]|buy\s|get\s|pick\s+up\s|need\s(?!to\b))/i.test(t)) return "shop";
    if (/^(?:wish(?:list)?\s*[:\-]|(?:i\s+)?want\s(?!to\b))/i.test(t)) return "wish";
    if (personIn(t)) return "wish";
    if (shop.find(t)) return "shop";
    return "task";
  }
  // The finished thing for a line in a given kind.
  function shape(line, kind) {
    const t = line.raw.trim();
    if (kind === "shop") {
      const rest = t.replace(/^(?:shop(?:ping)?\s*[:\-]\s*|buy\s+|get\s+|pick\s+up\s+|need\s+)/i, "");
      const names = rest.split(/\s*,\s*|\s+and\s+(?=\S+$)/).map(s => s.trim()).filter(Boolean);
      return { names: names.map(n => { const m = shop.find(n); return { name: m ? m.name : cap(n), master: m, on: m && shop.onList(m) }; }) };
    }
    if (kind === "wish") {
      const hit = personIn(t);
      const name = (hit ? hit.name : t.replace(/^(?:wish(?:list)?\s*[:\-]\s*|(?:i\s+)?want\s+)/i, "")).trim();
      return { name: cap(name), person: hit?.person || null };
    }
    if (!chrono) return { text: t, space: settings().defaultSpace || SPACES[0].id };
    const [task] = parseTasks(t, chrono, { defaultSpace: settings().defaultSpace || SPACES[0].id });
    return task || { text: t, space: settings().defaultSpace || SPACES[0].id };
  }
  function detail(kind, s) {
    if (kind === "shop") return s.names.map(n => n.on ? `<span class="on">${esc(n.name)} is on the list</span>` : `${esc(n.name)}${n.master ? "" : " (one-off)"}`).join(", ");
    if (kind === "wish") return s.person ? `for ${esc(s.person.name)}` : "my wishlist";
    const space = SPACES.find(x => x.id === s.space)?.label || s.space;
    return [space, s.date && dayText(s.date), s.time && `${s.time}${s.minutes ? ` for ${s.minutes} min` : ""}`].filter(Boolean).map(esc).join(" · ");
  }
  const title = (kind, s) => kind === "shop" ? s.names.map(n => n.name).join(", ") : kind === "wish" ? s.name : s.text;

  function read_() {
    const old = new Map(lines.map(l => [l.raw, l]));
    lines = q.value.split("\n").map(r => r.trim()).filter(Boolean).map(raw => {
      const had = old.get(raw);
      return { raw, chosen: had?.chosen || null, state: had?.state === "err" ? null : had?.state || null, note: "" };
    });
    paint();
  }
  function paint() {
    for (const l of lines) { l.kind = l.chosen || guess(l.raw); l.shape = shape(l, l.kind); }
    out.innerHTML = lines.map((l, i) => `<div class="cap-row">
      <button type="button" class="cap-kind ${l.kind}" data-i="${i}" title="Tap to send it somewhere else">${KIND_LABEL[l.kind]}</button>
      <div class="cap-main"><div class="sl-t">${esc(title(l.kind, l.shape) || "…")}</div><div class="sl-s">${detail(l.kind, l.shape)}</div></div>
      ${l.state ? `<span class="cap-state ${l.state}">${l.state === "ok" ? "added" : l.state === "busy" ? "adding…" : esc(l.note || "failed")}</span>` : ""}
    </div>`).join("");
    go.disabled = !lines.length || busy;
    go.textContent = lines.length > 1 ? `Add ${lines.length}` : "Add";
    if (!busy && !msg.dataset.keep) msg.textContent = problems.length ? `Couldn’t load ${problems.join(" or ")}` : lines.length ? "Tap a label to change where it goes" : "One thing per line";
    q.style.height = "auto"; q.style.height = `${q.scrollHeight}px`;
  }
  out.addEventListener("click", (e) => {
    const b = e.target.closest(".cap-kind");
    if (!b || busy) return;
    const l = lines[Number(b.dataset.i)];
    l.chosen = KINDS[(KINDS.indexOf(l.kind) + 1) % KINDS.length];
    paint();
  });

  // ── Adding ──
  let busy = false;
  async function addAll() {
    if (busy || !lines.length) return;
    busy = true; delete msg.dataset.keep;
    await ready;
    for (const l of lines) { l.kind = l.chosen || guess(l.raw); l.shape = shape(l, l.kind); l.state = "busy"; }
    paint();
    const touched = new Set();
    // Tasks go in one request per Craft space, as in tasks.
    const taskLines = lines.filter(l => l.kind === "task");
    await addTasks(taskLines).then(() => taskLines.length && touched.add("tasks"));
    for (const l of lines.filter(x => x.kind !== "task")) {
      try {
        if (l.kind === "shop") {
          if (!shop.household) throw new Error("no shopping list");
          for (const n of l.shape.names) await shop.add(n.master || n.name);
          touched.add("food");
        } else {
          const { data: { user } } = await supabase.auth.getUser();
          const { error } = await supabase.from("wish_items").insert({ name: l.shape.name, user_id: user.id, person_id: l.shape.person?.id || null, status: "open" });
          if (error) throw error;
          touched.add("wish");
        }
        l.state = "ok";
      } catch (err) {
        console.error(`capture: ${l.kind}:`, err);
        l.state = "err"; l.note = navigator.onLine ? "failed" : "offline";
      }
    }
    busy = false;
    const ok = lines.filter(l => l.state === "ok").length, bad = lines.length - ok;
    msg.textContent = bad ? `Added ${ok}. ${bad} didn’t go in and ${bad === 1 ? "is" : "are"} still here.` : `Added ${ok === 1 ? "it" : `all ${ok}`}`;
    msg.dataset.keep = "1";
    // What went in leaves the box; what failed stays to try again.
    q.value = lines.filter(l => l.state !== "ok").map(l => l.raw).join("\n");
    paint();
    setTimeout(() => { lines = lines.filter(l => l.state !== "ok"); paint(); }, 1400);
    if (touched.size) added([...touched]);
    q.focus();
  }

  async function addTasks(list) {
    if (!list.length) return;
    const s = settings();
    const bySpace = new Map();
    for (const l of list) bySpace.set(l.shape.space, [...(bySpace.get(l.shape.space) || []), l]);
    const timed = [];
    for (const [spaceId, group] of bySpace) {
      try {
        if (spaceId === "todoist") {
          todoist.setToken(s.todoist?.token);
          if (!todoist.hasToken()) throw new Error("set up joint. in tasks.");
          const projects = await todoist.loadProjects();
          for (const l of group) {
            const made = await todoist.addTask({ text: l.shape.text, date: l.shape.date, projectId: todoist.pickProject(l.shape.text, projects).project?.id });
            l.state = "ok";
            timed.push({ l, id: made?.id });
          }
          continue;
        }
        const conn = s.spaces?.[spaceId];
        if (!conn?.url) throw new Error(`set up ${SPACES.find(x => x.id === spaceId)?.label || spaceId} in tasks.`);
        const m = String(conn.url).match(/connect\.craft\.do\/links\/[^/?#\s]+/i);
        const base = m ? `https://${m[0]}/api/v1` : conn.url.replace(/\/+$/, "");
        const key = String(conn.key || "").replace(/[\s ​-‍﻿]/g, "");
        const res = await fetch(`${base}/tasks`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
          body: JSON.stringify({ tasks: group.map(l => ({ markdown: l.shape.text, location: { type: "inbox" }, ...(l.shape.date ? { taskInfo: { scheduleDate: l.shape.date } } : {}) })) }),
        });
        if (!res.ok) throw new Error(`Craft ${res.status}`);
        const made = await res.json().catch(() => null);
        const ids = (made?.items || made?.tasks || (Array.isArray(made) ? made : [])).map(x => x?.id);
        group.forEach((l, i) => { l.state = "ok"; timed.push({ l, id: ids.length === group.length ? ids[i] : null }); });
      } catch (err) {
        console.error(`capture: tasks (${spaceId}):`, err);
        for (const l of group) { l.state = "err"; l.note = err instanceof TypeError ? "couldn’t reach it" : err.message; }
      }
    }
    // A time becomes a block on the calendar, made by tasks.' own code. With
    // no new ID or no Google sign-in, tasks. places it the next time it loads
    // (it finds the task by its text), which the picker makes happen now.
    const blocks = timed.filter(x => x.l.shape.time && x.l.shape.date);
    if (!blocks.length) return;
    const gcal = await import("/taskhub/calendar.js");
    const later = [];
    for (const { l, id } of blocks) {
      const item = { id: id ? String(id) : null, text: l.shape.text, spaceId: l.shape.space, date: l.shape.date, time: l.shape.time, minutes: l.shape.minutes || gcal.DEFAULT_MINUTES };
      if (id && gcal.isConnected()) {
        try { await gcal.createBlock({ id: item.id, text: item.text, spaceId: item.spaceId }, item.date, item.time, item.minutes); continue; }
        catch (err) { console.error("capture: time block:", err); }
      }
      later.push(item);
    }
    if (later.length) gcal.setPending([...gcal.pending(), ...later]);
  }

  // ── Opening and closing ──
  function open() {
    back.hidden = false;
    delete msg.dataset.keep;
    load();
    read_();
    q.focus();
  }
  function close() { if (!busy) back.hidden = true; }
  q.addEventListener("input", () => { delete msg.dataset.keep; read_(); });
  q.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); addAll(); }
    else if (e.key === "Escape") { e.preventDefault(); if (q.value) { q.value = ""; read_(); } else close(); }
  });
  go.addEventListener("click", addAll);
  back.addEventListener("click", (e) => { if (e.target === back) close(); });

  // A from anywhere that isn't a text box or an open dialog.
  document.addEventListener("keydown", (e) => {
    if (!back.hidden || !enabled()) return;
    if (e.target.closest?.("input, textarea, select, [contenteditable], dialog[open]") || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "a" || e.key === "A") { e.preventDefault(); open(); }
  });

  return { open, close };
}
