// The first time someone opens lifeOS: their name and which apps they want on
// the wheel. Shown once per person (settings.welcomed, kept in Supabase, so
// not again on their other devices). Apps can be changed later in Account.

import { supabase } from "/lifeos/auth.js";
import * as settings from "/lifeos/shared/settings.js?v=1";

const CSS = `
  .wl-back { position:fixed; inset:0; z-index:200; display:grid; place-items:center; padding:16px;
    background:color-mix(in srgb, var(--bg) 70%, transparent); backdrop-filter:blur(10px); -webkit-backdrop-filter:blur(10px); overflow-y:auto; }
  .wl { width:100%; max-width:440px; max-height:calc(100dvh - 32px); overflow-y:auto; background:var(--surface); color:var(--text);
    border:1px solid var(--line); border-radius:20px; box-shadow:0 24px 60px rgba(0,0,0,.18); padding:22px 20px 18px; display:grid; gap:14px; font-family:var(--body); }
  .wl h2 { font-family:var(--disp); font-style:var(--hub-logo-style, italic); font-weight:600; font-size:1.9rem; color:var(--life-logo); letter-spacing:-.02em; line-height:1.1; }
  .wl h2 i { font-style:normal; color:var(--life-accent); }
  .wl p { color:var(--muted); font-size:.95rem; line-height:1.45; }
  .wl label.nm { display:grid; gap:6px; font-size:.82rem; font-weight:600; color:var(--muted); }
  .wl input[type=text] { font:inherit; font-size:16px; color:var(--text); background:transparent; border:1px solid var(--line); border-radius:10px; padding:10px 12px; min-height:44px; }
  .wl h3 { font-size:.82rem; font-weight:600; color:var(--muted); margin-top:2px; }
  .wl ul { list-style:none; display:grid; gap:6px; }
  .wl li label { display:grid; grid-template-columns:1fr auto; gap:2px 12px; align-items:center; padding:9px 12px; border:1px solid var(--line); border-radius:12px; cursor:pointer; }
  .wl li b { font-family:var(--disp); font-style:var(--hub-logo-style, italic); font-weight:600; font-size:1.1rem; color:var(--c); }
  .wl li b i { font-style:normal; color:var(--a); }
  .wl li span { grid-column:1; color:var(--muted); font-size:.85rem; line-height:1.3; }
  .wl li input { grid-column:2; grid-row:1 / span 2; width:20px; height:20px; accent-color:var(--life-accent); }
  .wl .go { border:0; border-radius:12px; min-height:46px; font:inherit; font-weight:700; color:#fff; background:var(--life-logo); cursor:pointer; }
  .wl .go:disabled { opacity:.5; }
  .wl .err { color:#b54e4e; font-size:.88rem; }
  .wl .err:empty { display:none; }
`;

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

export async function maybeWelcome() {
  let saved;
  try { saved = await settings.load(); } catch { return; }
  // Offline (found null) or seen before: nothing to do.
  if (saved.found === null || saved.settings.welcomed) return;
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return;
  const { data: profile } = await supabase.from("profiles").select("display_name").eq("id", session.user.id).maybeSingle();
  show(session.user, profile?.display_name || "", saved.settings.apps);
}

function show(user, name, chosen) {
  const style = document.createElement("style");
  style.textContent = CSS;
  const back = document.createElement("div");
  back.className = "wl-back";
  back.innerHTML = `
    <form class="wl" role="dialog" aria-modal="true" aria-labelledby="wl-title">
      <h2 id="wl-title">Welcome to lifeOS<i>.</i></h2>
      <p>One place for your days: calendar, tasks, food and the rest. Two quick things and you’re in.</p>
      <label class="nm">What should we call you?<input type="text" name="name" autocomplete="given-name" value="${esc(name)}"></label>
      <h3>Which apps do you want? You can change this any time in Account.</h3>
      <ul>${settings.APP_LIST.map(a => `
        <li><label style="--c:var(--${a.id}-logo);--a:var(--${a.id}-accent)"><b>${a.name}<i>.</i></b><span>${esc(a.about)}</span>
          <input type="checkbox" name="app" value="${a.id}" ${!Array.isArray(chosen) || chosen.includes(a.id) ? "checked" : ""}></label></li>`).join("")}
      </ul>
      <p>Live with someone? Invite them from Account (the person button at the bottom) to share food and joint. tasks.</p>
      <p class="err" role="alert"></p>
      <button class="go">Start</button>
    </form>`;
  document.head.append(style);
  document.body.append(back);
  const form = back.querySelector("form"), go = form.querySelector(".go"), err = form.querySelector(".err");
  const picked = () => [...form.querySelectorAll("[name=app]:checked")].map(x => x.value);
  form.addEventListener("change", () => { go.disabled = !picked().length; });
  // Escape would close an open app underneath; here it does nothing.
  back.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); } });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    go.disabled = true; err.textContent = "";
    const apps = picked(), all = apps.length === settings.APP_LIST.length;
    try {
      const typed = form.elements.name.value.trim();
      if (typed !== name) await supabase.from("profiles").update({ display_name: typed || null }).eq("id", user.id);
      await settings.save({ apps: all ? undefined : apps, welcomed: new Date().toISOString() });
    } catch (ex) {
      err.textContent = `Couldn’t save that (${ex.message || ex}). Check your connection and try again.`;
      go.disabled = false;
      return;
    }
    // The wheel is drawn as the page loads, so a new set of apps needs a fresh start.
    const before = window.lifeosApps || [];
    const same = before.length === (all ? settings.APP_LIST.length : apps.length) && (all || apps.every(a => before.includes(a)));
    if (same) { back.remove(); style.remove(); } else location.reload();
  });
  setTimeout(() => form.elements.name.focus(), 50);
}
