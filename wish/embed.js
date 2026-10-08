import { supabase } from "/lifeos/auth.js";

// wish.: my wishlist and gift lists for other people, kept in Supabase (wish_*).
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
  const money = (n) => n == null || n === "" ? "" : `£${Number(n).toLocaleString("en-GB", { minimumFractionDigits: Number(n) % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;

  // Red is the thing I most want, matching the traffic light on tasks (red is
  // high priority); the labels say so wherever a colour appears.
  const PRIORITY = [
    { id: "red", label: "Really want", c: "var(--red)", cs: "var(--red-soft)" },
    { id: "amber", label: "Would like", c: "var(--amber)", cs: "var(--amber-soft)" },
    { id: "green", label: "Not fussed", c: "var(--green)", cs: "var(--green-soft)" },
  ];
  const RANK = { red: 0, amber: 1, green: 2 };
  const pri = (id) => PRIORITY.find(p => p.id === id);
  const STATUS_ME = [{ id: "open", label: "Want it" }, { id: "bought", label: "Got it" }];
  const STATUS_GIFT = [{ id: "open", label: "Idea" }, { id: "bought", label: "Bought" }, { id: "given", label: "Given" }];

  let people = [], items = [], current = "me", editing = null, doneOpen = false, draft = {};
  try { current = localStorage.getItem("wish.tab") || "me"; } catch { /* private mode */ }

  function toast(msg, err = false) {
    const t = document.createElement("div");
    t.className = `toast${err ? " err" : ""}`; t.textContent = msg; t.setAttribute("role", "status");
    document.body.append(t);
    setTimeout(() => t.remove(), err ? 6000 : 2200);
  }
  const missing = (error) => /relation .* does not exist|PGRST205|Could not find the table/i.test(`${error?.code} ${error?.message}`);

  async function load() {
    const [p, i] = await Promise.all([
      supabase.from("wish_people").select("*").order("created_at"),
      supabase.from("wish_items").select("*").order("created_at", { ascending: false }),
    ]);
    const error = p.error || i.error;
    if (error) {
      $("notice").innerHTML = `<p class="note">${missing(error) ? "wish. isn’t set up yet: run <b>lifeos/wish/setup.sql</b> in the Supabase SQL editor, then reload." : `Couldn’t load your lists: ${esc(error.message)}`}</p>`;
      $("add").hidden = true;
      return;
    }
    people = p.data; items = i.data;
    if (current !== "me" && !people.some(x => x.id === current)) current = "me";
    // Opened from search. (#<item id>): that item's list, with it open.
    const linked = items.find(x => x.id === ctx.url.hash.slice(1));
    if (linked) current = linked.person_id || "me";
    render();
    if (linked) { if (ctx.standalone) history.replaceState(null, "", location.pathname); openItem(linked); }
  }

  const inList = (it) => current === "me" ? it.person_id === null : it.person_id === current;
  const isMe = () => current === "me";

  function render() {
    try { localStorage.setItem("wish.tab", current); } catch { /* private mode */ }
    $("tabs").innerHTML = [`<button type="button" class="tab" data-tab="me" aria-pressed="${isMe()}">Me</button>`,
      ...people.map(p => `<button type="button" class="tab" data-tab="${p.id}" aria-pressed="${current === p.id}">${esc(p.name)}</button>`),
      `<button type="button" class="tab add" id="add-person">+ Person</button>`].join("");

    const mine = items.filter(inList);
    const open = mine.filter(i => i.status === "open")
      .sort((a, b) => (RANK[a.priority] ?? 3) - (RANK[b.priority] ?? 3) || new Date(b.created_at) - new Date(a.created_at));
    const done = mine.filter(i => i.status !== "open").sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));

    const sum = (list) => list.reduce((t, i) => t + (Number(i.price) || 0), 0);
    const person = people.find(p => p.id === current);
    if (isMe()) {
      $("summary").innerHTML = PRIORITY.map(p => {
        const list = open.filter(i => i.priority === p.id);
        return list.length ? `<span><span class="dot-c" style="background:${p.c}"></span>${p.label} <b>${money(sum(list)) || "£0"}</b></span>` : "";
      }).join("") || `<span>${open.length ? `<b>${money(sum(open))}</b> wanted` : ""}</span>`;
    } else {
      const bought = mine.filter(i => i.status !== "open");
      $("summary").innerHTML = `<span><b>${open.length}</b> idea${open.length === 1 ? "" : "s"}${sum(open) ? ` · <b>${money(sum(open))}</b>` : ""}</span>`
        + (bought.length ? `<span>Bought <b>${money(sum(bought)) || bought.length}</b></span>` : "")
        + `<span class="person-acts"><button type="button" class="linkish" id="rename-person">Rename</button><button type="button" class="linkish" id="remove-person">Remove ${esc(person?.name || "")}</button></span>`;
    }

    $("open").innerHTML = open.length ? open.map(row).join("")
      : `<p class="empty">${isMe() ? "Nothing on your wishlist yet. Tap + to add something." : `No ideas for ${esc(person?.name)} yet. Tap + to add one.`}</p>`;
    $("done-wrap").hidden = !done.length;
    $("done-toggle").textContent = `${doneOpen ? "▾" : "▸"} ${isMe() ? "Got it" : "Bought & given"} · ${done.length}`;
    $("done-toggle").setAttribute("aria-expanded", String(doneOpen));
    $("done").hidden = !doneOpen;
    $("done").innerHTML = done.map(row).join("");
  }

  function row(it) {
    const p = pri(it.priority);
    const status = isMe() ? "" : it.status === "given" ? "Given" : it.status === "bought" ? "Bought" : "";
    let host = "";
    try { host = it.url ? new URL(it.url).hostname.replace(/^www\./, "") : ""; } catch { /* not a URL */ }
    return `<article class="item${it.status !== "open" ? " done" : ""}" style="--p:${p ? p.c : "var(--line)"}" data-id="${it.id}">
      ${it.image_url ? `<img class="thumb" src="${esc(it.image_url)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.visibility='hidden'">`
        : `<div class="thumb none">${esc((it.name || "?")[0])}</div>`}
      <div class="body" data-edit="${it.id}">
        <div class="name">${esc(it.name)}</div>
        <div class="meta">${it.price != null ? `<span class="price">${money(it.price)}</span>` : ""}${p ? `<span style="color:${p.c};font-weight:600">${p.label}</span>` : ""}${status ? `<span>${status}</span>` : ""}${host ? `<a href="${esc(it.url)}" target="_blank" rel="noopener" data-link>${esc(host)} ↗</a>` : ""}</div>
        ${it.notes ? `<div class="meta">${esc(it.notes.split("\n")[0])}</div>` : ""}
      </div>
      <button type="button" class="tick" data-tick="${it.id}" aria-label="${it.status === "open" ? (isMe() ? "Mark as got" : "Mark as bought") : "Move back to the list"}">✓</button>
    </article>`;
  }

  // ── Tabs and people ──
  $("tabs").addEventListener("click", (e) => {
    if (e.target.closest("#add-person")) return openPerson(null);
    const b = e.target.closest("[data-tab]"); if (!b) return;
    current = b.dataset.tab; doneOpen = false; render();
  });
  $("summary").addEventListener("click", async (e) => {
    const person = people.find(p => p.id === current);
    if (e.target.closest("#rename-person")) openPerson(person);
    if (e.target.closest("#remove-person")) {
      const n = items.filter(i => i.person_id === person.id).length;
      if (!confirm(`Remove ${person.name}${n ? ` and their ${n} item${n === 1 ? "" : "s"}` : ""}?`)) return;
      const { error } = await supabase.from("wish_people").delete().eq("id", person.id);
      if (error) return toast(`Not removed: ${error.message}`, true);
      people = people.filter(p => p.id !== person.id); items = items.filter(i => i.person_id !== person.id);
      current = "me"; render(); toast(`Removed ${person.name}`);
    }
  });
  let personEditing = null;
  function openPerson(person) {
    personEditing = person;
    $("person-title").textContent = person ? `Rename ${person.name}` : "Add someone";
    $("p-name").value = person?.name || "";
    $("person-dlg").showModal(); setTimeout(() => $("p-name").focus(), 50);
  }
  $("p-cancel").addEventListener("click", () => $("person-dlg").close());
  $("person-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("p-name").value.trim(); if (!name) return;
    if (personEditing) {
      const { error } = await supabase.from("wish_people").update({ name }).eq("id", personEditing.id);
      if (error) return toast(`Not saved: ${error.message}`, true);
      personEditing.name = name;
    } else {
      const { data, error } = await supabase.from("wish_people").insert({ user_id: session.user.id, name }).select().single();
      if (error) return toast(`Not added: ${error.message}`, true);
      people.push(data); current = data.id;
    }
    $("person-dlg").close(); render();
  });

  // ── Ticking off ──
  $("open").addEventListener("click", onListClick);
  $("done").addEventListener("click", onListClick);
  $("done-toggle").addEventListener("click", () => { doneOpen = !doneOpen; render(); });
  async function onListClick(e) {
    if (e.target.closest("[data-link]")) return;
    const t = e.target.closest("[data-tick]");
    if (t) {
      const it = items.find(i => i.id === t.dataset.tick);
      const before = it.status;
      it.status = before === "open" ? "bought" : "open";
      it.updated_at = new Date().toISOString();
      render();
      const { error } = await supabase.from("wish_items").update({ status: it.status, updated_at: it.updated_at }).eq("id", it.id);
      if (error) { it.status = before; render(); toast(`Not saved: ${error.message}`, true); }
      return;
    }
    const b = e.target.closest("[data-edit]");
    if (b) openItem(items.find(i => i.id === b.dataset.edit));
  }

  // ── Adding and editing ──
  function chips(box, list, value, onPick, coloured) {
    box.innerHTML = list.map(o => `<button type="button" class="chip" data-v="${o.id}" aria-pressed="${o.id === value}"${coloured ? ` style="--c:${o.c};--cs:${o.cs}"` : ""}>${coloured ? `<span class="dot-c" style="background:${o.c}"></span>` : ""}${o.label}</button>`).join("");
    box.onclick = (e) => { const b = e.target.closest("[data-v]"); if (!b) return; onPick(b.dataset.v === value ? null : b.dataset.v); };
  }
  function paintDraft() {
    chips($("f-priority"), PRIORITY, draft.priority, (v) => { draft.priority = v; paintDraft(); }, true);
    chips($("f-status"), isMe() ? STATUS_ME : STATUS_GIFT, draft.status, (v) => { draft.status = v || "open"; paintDraft(); });
    $("f-preview").hidden = !draft.image_url && !draft.site;
    if (draft.image_url) $("f-img").src = draft.image_url; else $("f-img").removeAttribute("src");
    $("f-img").hidden = !draft.image_url;
    $("f-site").textContent = draft.site || "";
  }
  function openItem(it) {
    editing = it;
    draft = { priority: it?.priority ?? null, status: it?.status ?? "open", image_url: it?.image_url || "", site: "" };
    $("item-title").textContent = it ? "Edit" : isMe() ? "Add to my wishlist" : `Add an idea for ${people.find(p => p.id === current)?.name}`;
    $("f-url").value = it?.url || ""; $("f-name").value = it?.name || "";
    $("f-price").value = it?.price ?? ""; $("f-notes").value = it?.notes || "";
    $("f-hint").textContent = ""; $("f-hint").className = "hint";
    $("f-delete").hidden = !it;
    paintDraft();
    $("item-dlg").showModal();
    if (!it) setTimeout(() => $("f-url").focus(), 50);
  }
  $("add").addEventListener("click", () => openItem(null));
  $("f-cancel").addEventListener("click", () => $("item-dlg").close());
  document.addEventListener("keydown", (e) => {
    if (e.key === "n" && !e.target.closest("input, textarea, dialog[open]") && !$("add").hidden) { e.preventDefault(); openItem(null); }
  });

  // Paste a link: the shop's name, price and picture, read by the link-preview function.
  let lastFetched = "";
  async function fetchLink() {
    const url = $("f-url").value.trim();
    if (!/^https?:\/\//i.test(url) || url === lastFetched) return;
    lastFetched = url;
    $("f-hint").className = "hint"; $("f-hint").textContent = "Reading the link…";
    try {
      const { data: s } = await supabase.auth.getSession();
      const res = await fetch("https://tvpmeysctvlhjyhotfyk.supabase.co/functions/v1/link-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${s.session?.access_token}`, apikey: supabase.supabaseKey },
        body: JSON.stringify({ url }),
      });
      const r = await res.json().catch(() => ({}));
      if (!r.success) throw new Error(r.error || r.message || `link reader answered ${res.status}`);
      // Generic page titles from shops that block readers aren't worth filling in.
      const generic = !r.name || /^(access denied|just a moment|attention required|robot check|something went wrong|amazon\.[a-z.]+)(\b|$)/i.test(r.name);
      if (!generic && !$("f-name").value.trim()) $("f-name").value = r.name;
      if (r.price != null && !$("f-price").value.trim()) $("f-price").value = Number(r.price).toFixed(2).replace(/\.00$/, "");
      if (r.image) draft.image_url = r.image;
      draft.site = r.site || "";
      paintDraft();
      const got = [!generic && "name", r.price != null && "price", r.image && "picture"].filter(Boolean);
      $("f-hint").textContent = got.length ? `Filled in the ${got.join(", ").replace(/, ([^,]*)$/, " and $1")} from ${r.site || "the page"}.` : `${r.site || "That shop"} didn’t share its details. Fill them in below.`;
      if (r.currency && r.currency !== "GBP" && r.price != null) $("f-hint").textContent += ` (Price is in ${r.currency}.)`;
    } catch (err) {
      $("f-hint").className = "hint err";
      $("f-hint").textContent = `Couldn’t read that link: ${err.message}. Fill in the details below.`;
    }
  }
  $("f-url").addEventListener("paste", () => setTimeout(fetchLink, 0));
  $("f-url").addEventListener("change", fetchLink);
  $("f-url").addEventListener("blur", fetchLink);

  $("item-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("f-name").value.trim();
    if (!name) { $("f-name").focus(); return; }
    const priceRaw = $("f-price").value.replace(/[£,\s]/g, "");
    const price = priceRaw === "" ? null : Number(priceRaw);
    if (price !== null && !Number.isFinite(price)) { toast("The price needs to be a number, like 24.99", true); $("f-price").focus(); return; }
    const row = {
      name, url: $("f-url").value.trim(), price, priority: draft.priority, status: draft.status || "open",
      notes: $("f-notes").value.trim(), image_url: draft.image_url || "", updated_at: new Date().toISOString(),
    };
    $("f-save").disabled = true;
    try {
      if (editing) {
        const { error } = await supabase.from("wish_items").update(row).eq("id", editing.id);
        if (error) return toast(`Not saved: ${error.message}`, true);
        Object.assign(editing, row);
      } else {
        const { data, error } = await supabase.from("wish_items")
          .insert({ ...row, user_id: session.user.id, person_id: isMe() ? null : current }).select().single();
        if (error) return toast(`Not added: ${error.message}`, true);
        items.unshift(data);
      }
      lastFetched = "";
      $("item-dlg").close(); render(); toast(editing ? "Saved" : "Added");
    } finally { $("f-save").disabled = false; }
  });
  $("f-delete").addEventListener("click", async () => {
    if (!editing || !confirm(`Delete “${editing.name}”?`)) return;
    const { error } = await supabase.from("wish_items").delete().eq("id", editing.id);
    if (error) return toast(`Not deleted: ${error.message}`, true);
    items = items.filter(i => i.id !== editing.id);
    $("item-dlg").close(); render(); toast("Deleted");
  });
  $("item-dlg").addEventListener("close", () => { lastFetched = ""; });

  load();

  return { unmount: () => document.off() };
}
