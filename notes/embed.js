// notes.: pages kept in lifeOS (Supabase table notes, sql/notes.sql), in the
// same three spaces as tasks.: my, work and joint (shared with the food.
// household). Plan: the "notes. — scope" doc. Runs inside lifeOS or on its own
// page (index.html), through /lifeos/embed.js.
//
// Saving: a note saves a second after typing stops. Until a save is
// confirmed, a copy waits on this device ("notes.unsaved"), and is sent the
// next time notes. opens. A save only goes over the version this device
// opened (updated_at); if another device saved in between, theirs stays and
// this one is kept beside it as a "conflict copy". Deleting moves a note to
// the bin for 30 days (deleted_at; a nightly job empties it).
import { Editor, Extension, StarterKit, TaskList, TaskItem, Placeholder, Suggestion } from "/lifeos/vendor/tiptap-3.31.3.js?v=2";
import { fill, docFor } from "/lifeos/embed.js";
import { householdId } from "/lifeos/shared/hubtasks.js?v=5";
import * as speech from "/lifeos/shared/speech.js?v=15";

const SPACES = [{ id: "my", label: "my space" }, { id: "work", label: "work" }, { id: "joint", label: "joint" }];
const LIST_COLUMNS = "id,space,title,body_text,household_id,deleted_at,updated_at";
const SAVE_AFTER = 1000;
const BIN_DAYS = 30;
const UNSAVED = "notes.unsaved";
const SPACE_KEY = "notes.space";

// The / menu: every kind of block, with words it can be found by.
const BLOCKS = [
  { id: "text", label: "Text", ic: "T", words: "paragraph plain normal", run: (c) => c.setParagraph() },
  { id: "h1", label: "Heading", ic: "H1", words: "h1 title big", run: (c) => c.setHeading({ level: 1 }) },
  { id: "h2", label: "Subheading", ic: "H2", words: "h2 heading", run: (c) => c.setHeading({ level: 2 }) },
  { id: "h3", label: "Small heading", ic: "H3", words: "h3 heading", run: (c) => c.setHeading({ level: 3 }) },
  { id: "checks", label: "Checklist", ic: "☐", words: "todo to-do task tick checkbox", run: (c) => c.toggleTaskList() },
  { id: "bullets", label: "Bullet list", ic: "•", words: "list unordered ul", run: (c) => c.toggleBulletList() },
  { id: "numbers", label: "Numbered list", ic: "1.", words: "list ordered ol", run: (c) => c.toggleOrderedList() },
  { id: "quote", label: "Quote", ic: "❝", words: "blockquote", run: (c) => c.toggleBlockquote() },
  { id: "code", label: "Code", ic: "</>", words: "codeblock pre", run: (c) => c.toggleCodeBlock() },
  { id: "divider", label: "Divider", ic: "—", words: "line rule hr separator", run: (c) => c.setHorizontalRule() },
];

export async function mount(ctx) {
  const { root, asset, supabase } = ctx;
  await fill(root, { css: asset("./app.css"), html: asset("./app.html") });
  const document = docFor(ctx);
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const missing = (error) => /relation .* does not exist|PGRST205|Could not find the table/i.test(`${error?.code} ${error?.message}`);
  // The stage 0 test note isn't wanted any more.
  try { localStorage.removeItem("notes.test"); } catch { /* private mode */ }

  function toast(msg, { err = false, action, onAction } = {}) {
    for (const old of document.querySelectorAll(".toast")) old.remove();
    const t = document.createElement("div");
    t.className = `toast${err ? " err" : ""}`; t.setAttribute("role", "status");
    t.append(msg);
    if (action) {
      const b = document.createElement("button");
      b.type = "button"; b.textContent = action;
      b.addEventListener("click", () => { t.remove(); onAction(); });
      t.append(b);
    }
    document.body.append(t);
    setTimeout(() => t.remove(), action ? 8000 : err ? 6000 : 2400);
  }

  // ─── What's on this device ────────────────────────────────────────
  const readJSON = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
  const writeJSON = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full or blocked */ } };
  let space = SPACES.some(s => s.id === readJSON(SPACE_KEY)) ? readJSON(SPACE_KEY) : "my";
  // Notes changed here and not yet confirmed saved: { [id]: entry }, where an
  // entry is { id, isNew, base (updated_at it was opened at), space, title, body, body_text }.
  const unsaved = () => readJSON(UNSAVED, {});
  const keepUnsaved = (entry) => writeJSON(UNSAVED, { ...unsaved(), [entry.id]: entry });
  const dropUnsaved = (id) => { const all = unsaved(); delete all[id]; writeJSON(UNSAVED, all); };

  // ─── Notes in Supabase ────────────────────────────────────────────
  let notes = [];      // every note you can see, bin included (list columns only)
  let ready = false;   // the table exists and loaded

  async function load() {
    const { data, error } = await supabase.from("notes").select(LIST_COLUMNS).order("updated_at", { ascending: false });
    if (error) {
      ready = false;
      $("notice").innerHTML = `<p class="note">${missing(error) ? "notes. isn’t set up yet: run <b>lifeos/sql/notes.sql</b> in the Supabase SQL editor, then reload." : `Couldn’t load your notes: ${esc(error.message)}`}</p>`;
      if (!missing(error)) console.error("notes.: loading failed:", error.message);
      $("add").hidden = true;
      renderList();
      return;
    }
    ready = true;
    $("notice").innerHTML = "";
    $("add").hidden = false;
    notes = data;
    // What this device still holds shows as it stands here.
    for (const e of Object.values(unsaved())) mergeRow({ id: e.id, space: e.space, title: e.title, body_text: e.body_text, updated_at: new Date().toISOString(), deleted_at: null });
    renderList();
    renderBin();
  }
  function mergeRow(row) {
    const i = notes.findIndex(n => n.id === row.id);
    if (i >= 0) notes[i] = { ...notes[i], ...row };
    else notes.unshift(row);
  }

  // Joint notes go to the household; without one they stay private (and say so).
  let warnedNoHousehold = false;
  async function householdFor(spaceId) {
    if (spaceId !== "joint") return null;
    const h = await householdId().catch(() => null);
    if (!h && !warnedNoHousehold) {
      warnedNoHousehold = true;
      toast("Kept for you only: join a household in food. to share joint notes.");
    }
    return h;
  }

  // Sends one entry. Returns the saved row, or { conflict, theirs, copy }
  // when another device saved first.
  async function push(e) {
    if (e.isNew) {
      const { data, error } = await supabase.from("notes")
        .insert({ id: e.id, space: e.space, household_id: await householdFor(e.space), title: e.title, body: e.body, body_text: e.body_text })
        .select(LIST_COLUMNS).single();
      // Already there: an earlier save arrived but its reply didn't.
      if (error?.code === "23505") return push({ ...e, isNew: false, base: null });
      if (error) throw error;
      return data;
    }
    let q = supabase.from("notes").update({ title: e.title, body: e.body, body_text: e.body_text }).eq("id", e.id);
    if (e.base) q = q.eq("updated_at", e.base);
    const { data, error } = await q.select(LIST_COLUMNS);
    if (error) throw error;
    if (data.length) return data[0];
    // Nothing saved: another device saved first, or the note is gone.
    const { data: theirs, error: err2 } = await supabase.from("notes").select("*").eq("id", e.id).maybeSingle();
    if (err2) throw err2;
    if (!theirs) return push({ ...e, isNew: true });
    const copy = await push({ ...e, id: crypto.randomUUID(), isNew: true, space: theirs.space, title: `${e.title || "Untitled"} (conflict copy)` });
    return { conflict: true, theirs, copy };
  }

  // ─── The open note ────────────────────────────────────────────────
  let current = null;   // { id, isNew, base, space }
  let editor = null;
  let dirty = false, saving = null, saveTimer = 0, retryTimer = 0;

  function status(text, warn = false) {
    $("status").textContent = text;
    $("status").classList.toggle("warn", warn);
  }
  function entryNow() {
    return { id: current.id, isNew: current.isNew, base: current.base, space: current.space,
      title: $("title").value.trim(), body: editor.getJSON(), body_text: editor.getText({ blockSeparator: "\n" }).trim() };
  }
  function changed() {
    if (!current) return;
    dirty = true;
    keepUnsaved(entryNow());
    status("Editing");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, SAVE_AFTER);
  }

  // Saves the open note now, if it has changes. One save at a time; edits
  // made during a save go in the next one.
  async function saveNow() {
    clearTimeout(saveTimer);
    if (saving) { await saving; return dirty ? saveNow() : undefined; }
    if (!current || !dirty || !ready) return;
    const note = current;
    const entry = entryNow();
    dirty = false;
    status("Saving…");
    saving = (async () => {
      try {
        const res = await push(entry);
        clearTimeout(retryTimer);
        if (res.conflict) {
          dropUnsaved(entry.id);
          mergeRow(res.copy);
          mergeRow(pick(res.theirs));
          if (current === note) { dirty = false; showNote(res.theirs); }
          toast("This note was changed on another device. Your version is kept as a “conflict copy”.");
        } else {
          note.isNew = false;
          note.base = res.updated_at;
          mergeRow(res);
          // Only forget the device copy if nothing was typed since it was sent.
          if (current === note && dirty) keepUnsaved(entryNow());
          else dropUnsaved(entry.id);
          if (current === note && !dirty) status("Saved");
        }
        renderList();
      } catch (err) {
        if (current === note) dirty = true;
        status(navigator.onLine === false ? "Offline: kept on this device" : "Not saved yet, trying again", true);
        if (navigator.onLine !== false) console.error("notes.: saving failed:", err?.message || err);
        clearTimeout(retryTimer);
        retryTimer = setTimeout(saveNow, 8000);
      }
    })();
    try { await saving; } finally { saving = null; }
    if (dirty && current === note) saveTimer = setTimeout(saveNow, SAVE_AFTER);
  }

  // Anything left on this device from before (a closed app, no signal): sent now.
  async function sendLeftovers() {
    for (const e of Object.values(unsaved())) {
      if (current?.id === e.id) continue;
      try {
        const res = await push(e);
        dropUnsaved(e.id);
        if (res.conflict) { mergeRow(res.copy); mergeRow(pick(res.theirs)); toast("A note changed on another device while this one was offline. Both versions are kept."); }
        else mergeRow(res);
      } catch (err) {
        if (navigator.onLine !== false) console.error("notes.: sending a saved copy failed:", err?.message || err);
        return;
      }
    }
    renderList();
  }
  const pick = (row) => Object.fromEntries(LIST_COLUMNS.split(",").map(k => [k, row[k]]));

  // A fresh editor for each note, so undo can't reach into the last one.
  function makeEditor(content) {
    editor?.destroy();
    editor = new Editor({
      element: $("editor"),
      // TipTap would add its stylesheet to the main page, where it can't reach
      // this shadow root; app.css has the rules it needs.
      injectCSS: false,
      extensions: [
        StarterKit.configure({ heading: { levels: [1, 2, 3] }, link: { openOnClick: false, autolink: true } }),
        TaskList,
        TaskItem.configure({ nested: true }),
        Placeholder.configure({ placeholder: "Write something, or type / for more" }),
        Slash,
      ],
      content: content || "",
      editorProps: { attributes: { "aria-label": "Note", autocapitalize: "sentences", spellcheck: "true" } },
      onUpdate: changed,
      onTransaction: paintToolbar,
    });
    paintToolbar();
  }

  // TipTap moves the focus a frame later; the note takes it at once, so
  // nothing typed straight after lands in the title.
  function focusNote(where) {
    if (!editor) return;
    editor.view.dom.focus({ preventScroll: true });
    editor.commands.focus(where);
  }

  function showNote(row, { focus = false } = {}) {
    current = { id: row.id, isNew: Boolean(row.isNew), base: row.updated_at || null, space: row.space };
    dirty = false;
    $("title").value = row.title || "";
    makeEditor(row.body);
    $("back-label").textContent = SPACES.find(s => s.id === row.space)?.label || "notes";
    $("empty").hidden = true;
    $("note").hidden = false;
    $("shell").dataset.view = "note";
    $("add").classList.add("away");
    sizeTitle();   // once shown: a hidden box measures 0
    status(row.isNew ? "" : row.updated_at ? `Edited ${when(row.updated_at)}` : "");
    renderList();
    if (focus === "title") $("title").focus();
    else if (focus) focusNote("end");
  }

  async function openNote(id) {
    stopMic();
    await saveNow();
    const draft = unsaved()[id];
    const { data, error } = await supabase.from("notes").select("*").eq("id", id).maybeSingle();
    if (error && !draft) { toast(`Couldn’t open that note: ${error.message}`, { err: true }); return; }
    if (!data && !draft) { toast("That note isn’t there any more.", { err: true }); return; }
    // A copy on this device that never got saved is what you last saw.
    if (draft) {
      showNote({ ...(data || {}), ...draft, updated_at: draft.base, isNew: !data });
      changed();
    } else showNote(data);
  }

  async function newNote() {
    if (!ready) return;
    stopMic();
    await saveNow();
    showNote({ id: crypto.randomUUID(), isNew: true, space, title: "", body: null }, { focus: "title" });
  }

  async function closeNote() {
    stopMic();
    await saveNow();
    current = null;
    editor?.destroy(); editor = null;
    $("note").hidden = true;
    $("empty").hidden = false;
    $("shell").dataset.view = "list";
    $("add").classList.remove("away");
    renderList();
  }

  // ─── Bin ──────────────────────────────────────────────────────────
  async function binNote() {
    if (!current) return;
    const note = current;
    // Never saved: nothing to put in the bin, it just goes.
    if (note.isNew) {
      clearTimeout(saveTimer);
      if (saving) await saving;
      if (note.isNew) { dirty = false; dropUnsaved(note.id); await closeNote(); return; }
    }
    await closeNote();
    const at = new Date().toISOString();
    const { error } = await supabase.from("notes").update({ deleted_at: at }).eq("id", note.id);
    if (error) { toast(`Couldn’t move it to the bin: ${error.message}`, { err: true }); console.error("notes.: bin failed:", error.message); return; }
    mergeRow({ id: note.id, deleted_at: at });
    renderList(); renderBin();
    toast("Moved to the bin.", { action: "Undo", onAction: () => restore(note.id) });
  }
  async function restore(id) {
    const { error } = await supabase.from("notes").update({ deleted_at: null }).eq("id", id);
    if (error) { toast(`Couldn’t bring it back: ${error.message}`, { err: true }); return; }
    mergeRow({ id, deleted_at: null });
    renderList(); renderBin();
  }
  async function deleteForGood(id) {
    if (!confirm("Delete this note for good? It can’t be brought back.")) return;
    const { error } = await supabase.from("notes").delete().eq("id", id);
    if (error) { toast(`Couldn’t delete it: ${error.message}`, { err: true }); return; }
    notes = notes.filter(n => n.id !== id);
    renderBin();
  }

  // ─── Lists ────────────────────────────────────────────────────────
  function when(iso) {
    const d = new Date(iso), now = new Date();
    const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate());
    const days = Math.round((day(now) - day(d)) / 864e5);
    if (days === 0) return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    if (days === 1) return "yesterday";
    if (days < 7) return d.toLocaleDateString("en-GB", { weekday: "long" });
    return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) });
  }
  // A note with no title is named by its first line.
  function naming(n) {
    const lines = (n.body_text || "").split("\n").map(s => s.trim()).filter(Boolean);
    return n.title ? { name: n.title, rest: lines.join(" ") } : { name: lines[0] || "", rest: lines.slice(1).join(" ") };
  }

  function renderList() {
    for (const t of $("tabs").querySelectorAll(".tab")) t.setAttribute("aria-pressed", String(t.dataset.space === space));
    if (!ready) { $("list").innerHTML = ""; return; }
    const shown = notes.filter(n => n.space === space && !n.deleted_at);
    const label = SPACES.find(s => s.id === space).label;
    $("list").innerHTML = shown.length ? shown.map(n => {
      const { name, rest } = naming(n);
      const shared = n.space === "joint" && !n.household_id ? " · only you" : "";
      return `<button type="button" class="item${current?.id === n.id ? " sel" : ""}" data-id="${n.id}">
        <span class="name${name ? "" : " untitled"}">${esc(name || "Untitled")}</span>
        <span class="sub"><span class="when">${esc(when(n.updated_at))}${shared}</span>${rest ? ` · ${esc(rest.slice(0, 140))}` : ""}</span></button>`;
    }).join("") : `<p class="empty">Nothing in ${esc(label)} yet. Tap + to start a note.</p>`;
  }

  function renderBin() {
    const binned = notes.filter(n => n.deleted_at).sort((a, b) => b.deleted_at.localeCompare(a.deleted_at));
    $("bin-list").innerHTML = binned.length ? binned.map(n => {
      const left = Math.max(1, BIN_DAYS - Math.floor((Date.now() - Date.parse(n.deleted_at)) / 864e5));
      return `<div class="bin-item" data-id="${n.id}"><div class="what"><div class="name">${esc(naming(n).name || "Untitled")}</div>
        <div class="sub">${esc(SPACES.find(s => s.id === n.space)?.label || "")} · gone for good in ${left} day${left === 1 ? "" : "s"}</div></div>
        <button type="button" class="small-btn" data-act="restore">Restore</button>
        <button type="button" class="small-btn danger" data-act="forget" aria-label="Delete for good">Delete</button></div>`;
    }).join("") : `<p class="empty">The bin is empty.</p>`;
  }
  function showBin(on) {
    $("bin").hidden = !on;
    $("lists").hidden = on;
    if (on) renderBin();
  }

  // ─── The formatting bar ───────────────────────────────────────────
  const chain = () => editor.chain().focus();
  const COMMANDS = {
    h1: { run: () => chain().toggleHeading({ level: 1 }).run(), on: () => editor.isActive("heading", { level: 1 }) },
    h2: { run: () => chain().toggleHeading({ level: 2 }).run(), on: () => editor.isActive("heading", { level: 2 }) },
    bold: { run: () => chain().toggleBold().run(), on: () => editor.isActive("bold") },
    italic: { run: () => chain().toggleItalic().run(), on: () => editor.isActive("italic") },
    checks: { run: () => chain().toggleTaskList().run(), on: () => editor.isActive("taskList") },
    bullets: { run: () => chain().toggleBulletList().run(), on: () => editor.isActive("bulletList") },
    numbers: { run: () => chain().toggleOrderedList().run(), on: () => editor.isActive("orderedList") },
    mic: { run: () => toggleMic() },
    undo: { run: () => chain().undo().run(), can: () => editor.can().undo() },
    redo: { run: () => chain().redo().run(), can: () => editor.can().redo() },
  };
  function paintToolbar() {
    if (!editor) return;
    for (const b of $("toolbar").querySelectorAll("button[data-cmd]")) {
      const c = COMMANDS[b.dataset.cmd];
      if (c.on) b.setAttribute("aria-pressed", String(c.on()));
      if (c.can) b.disabled = !c.can();
    }
  }

  // ─── Speaking ─────────────────────────────────────────────────────
  // What's said goes in at the cursor. The phrase being heard shows above
  // the note; each time the words so far change, the piece put in is
  // replaced with the new one.
  const box = { value: "" };
  let spokenAt = 0, spokenLen = 0, spaceBefore = false;
  const mic = speech.supported ? speech.listener(box, {
    onChange() {
      if (!editor) return;
      const piece = `${spaceBefore ? " " : ""}${box.value.replace(/\s*\n\s*/g, " ").trim()}`;
      const range = { from: spokenAt, to: spokenAt + spokenLen };
      if (piece.trim()) editor.chain().focus().insertContentAt(range, { type: "text", text: piece }).run();
      else if (spokenLen) editor.chain().focus().deleteRange(range).run();
      spokenLen = piece.trim() ? piece.length : 0;
    },
    onInterim(t) { $("interim").textContent = t; $("interim").hidden = !t; },
    onState(on) {
      $("mic").setAttribute("aria-pressed", String(on));
      if (on && editor) {
        box.value = "";
        spokenAt = editor.state.selection.from;
        spokenLen = 0;
        const before = editor.state.doc.textBetween(Math.max(0, spokenAt - 1), spokenAt, "\n");
        spaceBefore = Boolean(before) && !/\s/.test(before);
      }
    },
    onError(msg) { toast(msg, { err: true }); },
  }) : null;
  $("mic").hidden = !mic;
  function toggleMic() { if (mic) mic.listening ? mic.stop() : mic.start(); }
  function stopMic() { if (mic?.listening) mic.stop(); }

  // ─── The / menu ───────────────────────────────────────────────────
  const slash = $("slash");
  let slashItems = [], slashPick = 0, slashRun = null;
  function drawSlash() {
    if (!slashItems.length) { slash.hidden = true; return; }
    slash.innerHTML = slashItems.map((b, i) => `<button type="button" role="option" data-i="${i}" aria-selected="${i === slashPick}"><span class="ic" aria-hidden="true">${esc(b.ic)}</span>${esc(b.label)}</button>`).join("");
    slash.hidden = false;
    slash.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }
  function placeSlash(rect) {
    const r = rect?.();
    if (!r) return;
    // Placed in the app's page, not the window, so it scrolls with the note.
    const page = document.body.getBoundingClientRect();
    const width = 230;
    slash.style.left = `${Math.max(8, Math.min(r.left - page.left, page.width - width - 8))}px`;
    slash.style.top = `${r.bottom - page.top + 6}px`;
  }
  const Slash = Extension.create({
    name: "slashMenu",
    addProseMirrorPlugins() {
      return [Suggestion({
        editor: this.editor,
        char: "/",
        items: ({ query }) => {
          const q = query.toLowerCase().trim();
          return BLOCKS.filter(b => !q || `${b.label} ${b.words}`.toLowerCase().split(/\s+/).some(w => w.startsWith(q)));
        },
        command: ({ editor: ed, range, props }) => props.run(ed.chain().focus().deleteRange(range)).run(),
        render: () => ({
          onStart(p) { slashItems = p.items; slashRun = p.command; slashPick = 0; drawSlash(); placeSlash(p.clientRect); },
          onUpdate(p) { slashItems = p.items; slashRun = p.command; slashPick = 0; drawSlash(); placeSlash(p.clientRect); },
          onKeyDown({ event }) {
            if (slash.hidden) return false;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              slashPick = (slashPick + (event.key === "ArrowDown" ? 1 : -1) + slashItems.length) % slashItems.length;
              drawSlash();
              return true;
            }
            if (event.key === "Enter" || event.key === "Tab") { slashRun(slashItems[slashPick]); return true; }
            // Escape closes the menu, not the app.
            if (event.key === "Escape") { event.preventDefault(); slash.hidden = true; return false; }
            return false;
          },
          onExit() { slash.hidden = true; slashItems = []; },
        }),
      })];
    },
  });
  slash.addEventListener("pointerdown", (e) => e.preventDefault());
  slash.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-i]");
    if (b && slashRun) slashRun(slashItems[Number(b.dataset.i)]);
  });

  // ─── Wiring ───────────────────────────────────────────────────────
  // Pressing a toolbar button mustn't take the focus (and the iPhone
  // keyboard) away from the note, so the press is stopped and it runs on release.
  $("toolbar").addEventListener("pointerdown", (e) => { if (e.target.closest("button")) e.preventDefault(); });
  $("toolbar").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-cmd]");
    if (b && editor) COMMANDS[b.dataset.cmd].run();
  });

  function sizeTitle() { const t = $("title"); t.style.height = "auto"; t.style.height = `${t.scrollHeight}px`; }
  $("title").addEventListener("input", () => { sizeTitle(); changed(); });
  $("title").addEventListener("keydown", (e) => {
    // Return in the title goes on to the note.
    if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); focusNote("start"); }
  });

  $("tabs").addEventListener("click", (e) => {
    const t = e.target.closest(".tab");
    if (!t) return;
    space = t.dataset.space;
    writeJSON(SPACE_KEY, space);
    renderList();
  });
  $("list").addEventListener("click", (e) => {
    const item = e.target.closest(".item");
    if (item) openNote(item.dataset.id);
  });
  $("add").addEventListener("click", newNote);
  $("back").addEventListener("click", closeNote);
  $("delete").addEventListener("click", binNote);
  $("bin-btn").addEventListener("click", () => showBin($("bin").hidden));
  $("bin-back").addEventListener("click", () => showBin(false));
  $("bin-list").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-act]");
    if (!b) return;
    const id = b.closest(".bin-item").dataset.id;
    if (b.dataset.act === "restore") restore(id); else deleteForGood(id);
  });

  const typing = (e) => e.target.closest?.("input, textarea, select, [contenteditable]");
  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
    if ((e.key === "n" || e.key === "N") && !typing(e)) { e.preventDefault(); newNote(); }
    // Escape out of a note goes back to the list on a phone (not lifeOS's wheel).
    if (e.key === "Escape" && current && !typing(e) && $("shell").dataset.view === "note") { e.preventDefault(); closeNote(); }
  });
  // Leaving the app or the page: save what's there.
  const onHide = () => { if (document.visibilityState === "hidden") saveNow(); };
  document.addEventListener("visibilitychange", onHide);
  // The title wraps differently at another width.
  const onResize = () => { if (current) sizeTitle(); };
  window.addEventListener("resize", onResize);

  renderList();
  await load();
  sendLeftovers();
  // Opened at a note (#<id>, from search later on).
  const linked = ctx.url.hash.slice(1);
  if (/^[0-9a-f-]{36}$/i.test(linked)) {
    if (ctx.standalone) history.replaceState(null, "", location.pathname);
    openNote(linked);
  }

  return {
    // Back on screen: anything changed elsewhere shows (not while typing here).
    shown() { if (!dirty && !saving) load(); },
    unmount() {
      clearTimeout(saveTimer); clearTimeout(retryTimer);
      stopMic();
      if (current && dirty) keepUnsaved(entryNow());
      saveNow();
      editor?.destroy();
      window.removeEventListener("resize", onResize);
      document.off();
    },
  };
}
