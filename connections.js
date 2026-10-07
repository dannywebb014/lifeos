// "connections." on the lifeOS picker: every sign-in and API connection the
// hub apps use, in one place, each checked when it opens.
//
//   import { mountConnections } from "/lifeos/connections.js";
//   const c = mountConnections({ saved: () => … });
//   c.open();
//
// It edits the same settings the apps keep on this device, so a change here
// is a change there:
//   - lifeOS.: the Supabase sign-in every app shares (auth.js), and the
//     authenticator apps that give its two-factor codes: add a backup device
//     or remove one
//   - Google Calendar: calendar.'s token and client ID (google.js), renewed here
//   - Craft (my space., work.) and Todoist (joint.): "tasks.settings", which
//     tasks., media. and today. all read
// `saved` runs after a change, so the picker can reload the apps that use it.

import { supabase } from "./auth.js";
import * as google from "./google.js?v=1";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const read = (k, fallback) => { try { return JSON.parse(localStorage.getItem(k)) ?? fallback; } catch { return fallback; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };
const cleanKey = (k) => String(k || "").replace(/[\s ​-‍﻿]/g, "");
const craftBase = (url) => {
  const m = String(url || "").trim().match(/^(?:https?:\/\/)?(connect\.craft\.do\/links\/[^/?#\s]+)/i);
  return m ? `https://${m[1]}/api/v1` : String(url || "").trim().replace(/\/+$/, "");
};
const SPACES = [{ id: "my", label: "my space." }, { id: "work", label: "work." }];

const CSS = `
  .cn-panel { padding:14px 14px 12px; overflow-y:auto; }
  .cn-panel h2 { font-family:var(--disp); font-style:var(--hub-logo-style, italic); font-weight:600; font-size:1.35rem; color:var(--life-logo); margin:0 2px 2px; }
  .cn-panel h2 i { font-style:normal; color:var(--life-accent); }
  .cn-sub { color:var(--sl-muted); font-size:.85rem; margin:0 2px 12px; }
  .cn-box { border:1px solid var(--sl-line); border-radius:12px; padding:10px 12px; margin-bottom:8px; background:var(--bg); }
  .cn-top { display:flex; align-items:center; gap:8px; }
  .cn-top b { flex:1; font-size:.98rem; }
  .cn-st { font-size:.8rem; color:var(--sl-muted); text-align:right; }
  .cn-st.ok { color:#4a8a4a; font-weight:600; }
  .cn-st.err { color:#c0504d; font-weight:600; }
  .cn-st::before { content:""; display:inline-block; width:7px; height:7px; border-radius:50%; background:currentColor; margin-right:5px; vertical-align:1px; }
  .cn-note { font-size:.8rem; color:var(--sl-muted); margin-top:4px; line-height:1.35; }
  .cn-f { display:grid; gap:6px; margin-top:8px; }
  .cn-f input, .cn-f select { width:100%; padding:8px 10px; border-radius:9px; border:1px solid var(--sl-line); background:var(--sl-surface); color:var(--sl-text); font:inherit; font-size:.9rem; outline:none; }
  .cn-f[hidden] { display:none; }
  .cn-f input:focus { border-color:var(--life-accent); }
  .cn-row { display:flex; gap:6px; flex-wrap:wrap; margin-top:8px; }
  .cn-b { border:1px solid var(--sl-line); background:var(--sl-surface); color:var(--sl-text); border-radius:9px; padding:5px 12px; font:inherit; font-size:.85rem; font-weight:600; cursor:pointer; }
  .cn-b.main { background:var(--sl-text); color:var(--sl-surface); border-color:var(--sl-text); }
  .cn-more { border:0; background:none; color:var(--sl-muted); font:inherit; font-size:.8rem; text-decoration:underline; cursor:pointer; padding:0; margin-top:6px; }
  .cn-foot { display:flex; justify-content:flex-end; margin-top:6px; }
  .cn-auths { margin-top:8px; display:grid; gap:6px; }
  .cn-auth { display:flex; align-items:center; gap:8px; font-size:.88rem; }
  .cn-auth span { flex:1; min-width:0; overflow-wrap:anywhere; }
  .cn-auth small { color:var(--sl-muted); }
  .cn-qr { display:flex; justify-content:center; margin:6px 0; }
  .cn-qr img { width:180px; height:180px; background:#fff; border-radius:10px; padding:6px; }
  .cn-key { font-family:ui-monospace, Menlo, monospace; font-size:.82rem; overflow-wrap:anywhere; user-select:all; }
  .cn-err { color:#c0504d; font-size:.82rem; font-weight:600; min-height:1em; }
`;

export function mountConnections({ saved = () => {} } = {}) {
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.append(style);

  const back = document.createElement("div");
  back.className = "sl-back"; back.hidden = true;
  back.innerHTML = `<div class="sl-panel cn-panel" role="dialog" aria-modal="true" aria-label="Connections">
    <h2>connections<i>.</i></h2>
    <p class="cn-sub">Everything the apps sign in to, kept on this device. A change here is a change in every app.</p>
    <div class="cn-list"></div>
    <div class="cn-foot"><button type="button" class="cn-b main" data-close>Done</button></div></div>`;
  document.body.append(back);
  const list = back.querySelector(".cn-list");

  const tasksSettings = () => read("tasks.settings", {});
  function saveTasks(change) {
    const s = tasksSettings();
    change(s);
    write("tasks.settings", s);
    dirty = true;
  }
  let dirty = false;

  // ── Checks: each resolves { ok, text } ──
  async function checkCraft(id) {
    const s = tasksSettings().spaces?.[id];
    // No connection is fine: the space keeps its tasks in lifeOS (shared/hubtasks.js).
    if (!s?.url) return { ok: true, text: "Not connected · tasks kept in lifeOS" };
    const headers = { Accept: "application/json", ...(cleanKey(s.key) ? { Authorization: `Bearer ${cleanKey(s.key)}` } : {}) };
    try {
      const res = await fetch(`${craftBase(s.url)}/connection`, { headers });
      if (res.status === 401 || res.status === 403) return { ok: false, text: "Key refused" };
      if (!res.ok) return { ok: false, text: res.status === 404 ? "URL not found" : `Craft ${res.status}` };
      // Only an "All Documents" connection can edit tasks inside documents.
      const docs = await fetch(`${craftBase(s.url)}/documents?limit=1`, { headers });
      return docs.ok ? { ok: true, text: "Connected" } : { ok: true, text: "Connected · can’t edit tasks in documents" };
    } catch { return { ok: false, text: navigator.onLine ? "Couldn’t reach Craft" : "Offline" }; }
  }
  async function checkTodoist() {
    const t = cleanKey(tasksSettings().todoist?.token);
    if (!t) return { ok: true, text: "Not connected · tasks kept in lifeOS, shared with your household" };
    try {
      const res = await fetch("https://api.todoist.com/api/v1/projects?limit=1", { headers: { Authorization: `Bearer ${t}` } });
      return res.ok ? { ok: true, text: "Connected" } : { ok: false, text: res.status === 401 || res.status === 403 ? "Token refused" : `Todoist ${res.status}` };
    } catch { return { ok: false, text: navigator.onLine ? "Couldn’t reach Todoist" : "Offline" }; }
  }
  function googleState() {
    if (google.isConnected()) return { ok: true, text: `Connected · ${google.minutesLeft()} min left` };
    if (!google.clientId()) return { text: "Needs calendar.’s client ID" };
    return google.wasConnected() ? { ok: false, text: "Signed out" } : { text: "Not connected" };
  }
  const status = (el, r) => { el.className = `cn-st${r.ok === true ? " ok" : r.ok === false ? " err" : ""}`; el.textContent = r.text; };

  // ── Boxes ──
  function lifeosBox() {
    const box = document.createElement("div");
    box.className = "cn-box";
    box.innerHTML = `<div class="cn-top"><b>lifeOS.</b><span class="cn-st">Checking…</span></div><div class="cn-note"></div>
      <div class="cn-auths"></div>
      <button type="button" class="cn-more" data-a="add" hidden>Add another authenticator</button>
      <div class="cn-f" data-a="setup" hidden></div>`;
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      status(box.querySelector(".cn-st"), user ? { ok: aal?.currentLevel === "aal2", text: aal?.currentLevel === "aal2" ? "Signed in · two-factor" : "Signed in · no two-factor" } : { ok: false, text: "Signed out" });
      box.querySelector(".cn-note").textContent = user ? `${user.email}. The one sign-in every app shares.` : "";
      if (user && aal?.currentLevel === "aal2") authenticators(box);
    }).catch(() => status(box.querySelector(".cn-st"), { ok: false, text: "Couldn’t check" }));
    return box;
  }

  // ── Authenticators: the apps that give the two-factor code ──
  // A second one (another phone, an iPad, a password manager) means losing a
  // phone doesn't lock you out. Sign-in accepts a code from any of them.
  async function authenticators(box) {
    const listEl = box.querySelector(".cn-auths");
    const addBtn = box.querySelector("[data-a=add]");
    const setup = box.querySelector("[data-a=setup]");
    const { data, error } = await supabase.auth.mfa.listFactors();
    if (error) { listEl.innerHTML = `<div class="cn-err">Couldn’t list your authenticators: ${esc(error.message)}</div>`; return; }
    const verified = data.totp.filter(f => f.status === "verified");
    const when = (iso) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
    listEl.replaceChildren(...verified.map(f => {
      const row = document.createElement("div");
      row.className = "cn-auth";
      row.innerHTML = `<span><b></b> <small>added ${esc(when(f.created_at))}</small></span>${verified.length > 1 ? `<button type="button" class="cn-b">Remove</button>` : ""}`;
      row.querySelector("b").textContent = f.friendly_name || "Authenticator";
      const rm = row.querySelector("button");
      // Two taps, so one stray tap can't remove it. The last one can't be removed here.
      if (rm) rm.onclick = async () => {
        if (rm.dataset.sure !== "1") { rm.dataset.sure = "1"; rm.textContent = "Tap again to remove"; return; }
        rm.disabled = true;
        const { error: err } = await supabase.auth.mfa.unenroll({ factorId: f.id });
        if (err) { rm.disabled = false; rm.textContent = "Couldn’t remove"; return; }
        authenticators(box);
      };
      return row;
    }));
    addBtn.hidden = false;
    addBtn.onclick = () => startSetup(box, verified);
    setup.hidden = true;
  }

  async function startSetup(box, verified) {
    const setup = box.querySelector("[data-a=setup]");
    const addBtn = box.querySelector("[data-a=add]");
    setup.hidden = false;
    addBtn.hidden = true;
    setup.innerHTML = `<input data-a="name" placeholder="Name it, e.g. iPad or 1Password" maxlength="40" aria-label="Name for this authenticator">
      <div class="cn-row"><button type="button" class="cn-b main" data-a="go">Show the QR code</button><button type="button" class="cn-b" data-a="cancel">Cancel</button></div>
      <div class="cn-err" role="alert"></div>`;
    const err = setup.querySelector(".cn-err");
    const name = setup.querySelector("[data-a=name]");
    name.focus();
    setup.querySelector("[data-a=cancel]").onclick = () => authenticators(box);
    setup.querySelector("[data-a=go]").onclick = async () => {
      const label = name.value.trim() || `Authenticator ${verified.length + 1}`;
      if (verified.some(f => (f.friendly_name || "").toLowerCase() === label.toLowerCase())) { err.textContent = "You already have one with that name."; return; }
      err.textContent = "";
      // A set-up abandoned earlier would block a new one, so it goes first.
      const { data } = await supabase.auth.mfa.listFactors();
      for (const f of (data?.all || []).filter(f => f.factor_type === "totp" && f.status !== "verified")) {
        await supabase.auth.mfa.unenroll({ factorId: f.id });
      }
      const enrol = await supabase.auth.mfa.enroll({ factorType: "totp", friendlyName: label });
      if (enrol.error) { err.textContent = enrol.error.message; return; }
      const { id, totp } = enrol.data;
      setup.innerHTML = `<div class="cn-note">On the new device, add an account in your authenticator app and scan this, then enter the 6-digit code it shows.</div>
        <div class="cn-qr"><img alt="QR code for your authenticator app"></div>
        <div class="cn-note">Or type this key: <span class="cn-key"></span></div>
        <input data-a="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="6-digit code" aria-label="6-digit code from the new authenticator">
        <div class="cn-row"><button type="button" class="cn-b main" data-a="verify">Add it</button><button type="button" class="cn-b" data-a="cancel">Cancel</button></div>
        <div class="cn-err" role="alert"></div>`;
      setup.querySelector("img").src = totp.qr_code;
      setup.querySelector(".cn-key").textContent = totp.secret;
      const code = setup.querySelector("[data-a=code]");
      const err2 = setup.querySelector(".cn-err");
      code.focus();
      setup.querySelector("[data-a=cancel]").onclick = async () => {
        await supabase.auth.mfa.unenroll({ factorId: id });
        authenticators(box);
      };
      const verify = async () => {
        const digits = code.value.replace(/\D/g, "");
        if (digits.length !== 6) { err2.textContent = "Enter the 6 digits from the new device."; return; }
        err2.textContent = "Checking…";
        const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: id, code: digits });
        if (error) { err2.textContent = /invalid|expired/i.test(error.message) ? "That code didn’t match. Check it’s the new device’s code and try the next one." : error.message; code.select(); return; }
        authenticators(box);
        status(box.querySelector(".cn-st"), { ok: true, text: `Added ${label}` });
      };
      setup.querySelector("[data-a=verify]").onclick = verify;
      code.addEventListener("input", () => { if (code.value.replace(/\D/g, "").length === 6) verify(); });
    };
  }

  function googleBox() {
    const box = document.createElement("div");
    box.className = "cn-box";
    const st = googleState();
    box.innerHTML = `<div class="cn-top"><b>Google Calendar</b><span class="cn-st"></span></div>
      <div class="cn-note">${google.email() ? `${esc(google.email())}. ` : ""}Used by calendar., tasks.’ time blocks and today. Google’s sign-in lasts an hour; lifeOS renews it when today. opens.</div>
      <div class="cn-row">${google.clientId() ? `<button type="button" class="cn-b main" data-g="connect">${google.isConnected() ? "Renew now" : google.wasConnected() ? "Sign in again" : "Connect"}</button>` : ""}
        <button type="button" class="cn-more" data-g="id">${google.clientId() ? "Change client ID" : "Add calendar.’s client ID"}</button></div>
      <div class="cn-f" hidden><input placeholder="…apps.googleusercontent.com" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Google client ID">
        <div class="cn-row"><button type="button" class="cn-b" data-g="save">Save</button></div></div>`;
    status(box.querySelector(".cn-st"), st);
    const f = box.querySelector(".cn-f"), input = f.querySelector("input");
    input.value = google.clientId();
    box.addEventListener("click", (e) => {
      const g = e.target.closest("[data-g]")?.dataset.g;
      if (g === "connect") google.connect({ then: "connections" });
      if (g === "id") { f.hidden = !f.hidden; if (!f.hidden) input.focus(); }
      if (g === "save") {
        if (input.value.trim() && !input.value.trim().endsWith(".apps.googleusercontent.com")) { status(box.querySelector(".cn-st"), { ok: false, text: "That isn’t a client ID" }); return; }
        google.setClientId(input.value);
        dirty = true;
        box.replaceWith(googleBox());
      }
    });
    return box;
  }

  function craftBox(space) {
    const box = document.createElement("div");
    box.className = "cn-box";
    const s = tasksSettings().spaces?.[space.id] || {};
    box.innerHTML = `<div class="cn-top"><b>Craft · ${esc(space.label)}</b><span class="cn-st">Checking…</span></div>
      <div class="cn-note">Used by tasks., media. and today. In Craft: Imagine → API → an “All Documents” connection.</div>
      <button type="button" class="cn-more" data-edit>${s.url ? "Change" : "Set up"}</button>
      <div class="cn-f" hidden>
        <input data-k="url" placeholder="API URL (https://connect.craft.do/links/…)" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="${esc(space.label)} API URL">
        <input data-k="key" type="password" placeholder="API key, if the connection has one" autocomplete="off" aria-label="${esc(space.label)} API key">
        <div class="cn-row"><button type="button" class="cn-b" data-save>Save and check</button></div></div>`;
    const f = box.querySelector(".cn-f"), url = f.querySelector("[data-k=url]"), key = f.querySelector("[data-k=key]");
    url.value = s.url || ""; key.value = s.key || "";
    const check = () => checkCraft(space.id).then(r => status(box.querySelector(".cn-st"), r));
    box.querySelector("[data-edit]").onclick = () => { f.hidden = !f.hidden; if (!f.hidden) url.focus(); };
    box.querySelector("[data-save]").onclick = () => {
      saveTasks(all => {
        all.spaces ||= {};
        const prev = all.spaces[space.id] || {};
        const next = { url: url.value.trim(), key: key.value.trim() };
        // The Craft space ID tasks. learned is kept while the URL is unchanged.
        if (prev.spaceUuid && prev.url === next.url) next.spaceUuid = prev.spaceUuid;
        all.spaces[space.id] = next;
      });
      status(box.querySelector(".cn-st"), { text: "Checking…" });
      check();
    };
    check();
    return box;
  }

  function todoistBox() {
    const box = document.createElement("div");
    box.className = "cn-box";
    const t = tasksSettings().todoist?.token || "";
    box.innerHTML = `<div class="cn-top"><b>Todoist · joint.</b><span class="cn-st">Checking…</span></div>
      <div class="cn-note">The shared lists, in tasks. and today. Todoist → Settings → Integrations → Developer → API token.</div>
      <button type="button" class="cn-more" data-edit>${t ? "Change" : "Set up"}</button>
      <div class="cn-f" hidden><input type="password" placeholder="API token" autocomplete="off" aria-label="Todoist API token">
        <div class="cn-row"><button type="button" class="cn-b" data-save>Save and check</button></div></div>`;
    const f = box.querySelector(".cn-f"), input = f.querySelector("input");
    input.value = t;
    const check = () => checkTodoist().then(r => status(box.querySelector(".cn-st"), r));
    box.querySelector("[data-edit]").onclick = () => { f.hidden = !f.hidden; if (!f.hidden) input.focus(); };
    box.querySelector("[data-save]").onclick = () => {
      saveTasks(all => { all.todoist = { ...(all.todoist || {}), token: input.value.trim() }; });
      status(box.querySelector(".cn-st"), { text: "Checking…" });
      check();
    };
    check();
    return box;
  }

  function defaultBox() {
    const box = document.createElement("div");
    box.className = "cn-box";
    box.innerHTML = `<div class="cn-top"><b>New tasks go to</b></div>
      <div class="cn-note">When a task doesn’t say a space, in tasks. and the add box.</div>
      <div class="cn-f"><select aria-label="Default space">
        <option value="my">my space.</option><option value="work">work.</option><option value="todoist">joint.</option></select></div>`;
    const sel = box.querySelector("select");
    sel.value = tasksSettings().defaultSpace || "my";
    sel.onchange = () => saveTasks(all => { all.defaultSpace = sel.value; });
    return box;
  }

  function open() {
    dirty = false;
    list.replaceChildren(lifeosBox(), googleBox(), ...SPACES.map(craftBox), todoistBox(), defaultBox());
    back.hidden = false;
  }
  function close() {
    back.hidden = true;
    if (dirty) saved();
    dirty = false;
  }
  back.querySelector("[data-close]").onclick = close;
  back.addEventListener("click", (e) => { if (e.target === back) close(); });
  document.addEventListener("keydown", (e) => { if (!back.hidden && e.key === "Escape") { e.preventDefault(); close(); } });

  return { open, close };
}
