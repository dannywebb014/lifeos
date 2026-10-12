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
//
// Folders (sql/notes-folders.sql) are rows with kind "folder", their name as
// the title; anything sits in one through parent_id, folders in folders too.
// A folder goes to the bin with everything in it, all stamped with the same
// deleted_at, so restoring it brings the lot back.
//
// Order in the sidebar: folders then notes, A to Z, until something is
// dragged into place; then that folder keeps the order given (position, a
// number kept as text; a drop between two takes the number halfway). Pinned
// notes and folders also show at the top. Daily notes (day set, one per
// person per day) live outside the folders, reached from "Today" and the
// day arrows, and from today.'s notes. card (#day=YYYY-MM-DD).
//
// Tasks (sql/notes-tasks.sql): as in Craft, every checklist line is a task,
// a row in hub_tasks in the note's space, so it shows in tasks., today. and
// the calendar. The line keeps the task's id (taskId); a date in the line
// ("call the vet friday") is the task's date, and a daily note's lines fall
// on its day. A tick in either place shows in both: ticks made in tasks. are
// brought in when the note opens. Text goes from the note to the task only
// when the line changes, so a rename in tasks. stays. Deleting a line
// deletes its open task; a line whose task was deleted in tasks. is let go
// (taskId "off") rather than made again.
import { Editor, Extension, StarterKit, TaskList, TaskItem, Placeholder, Suggestion } from "/lifeos/vendor/tiptap-3.31.3.js?v=2";
import { fill, docFor } from "/lifeos/embed.js";
import { householdId } from "/lifeos/shared/hubtasks.js?v=5";
import * as speech from "/lifeos/shared/speech.js?v=15";
import { parseTasks } from "/lifeos/shared/parse.js?v=26";

const CHRONO = "https://cdn.jsdelivr.net/npm/chrono-node@2.10.1/+esm";
let chrono = null;
const loadChrono = () => chrono ? Promise.resolve(chrono) : import(CHRONO).then(m => (chrono = m));
const PENDING_TASKS = "notes.pendingTasks";   // task ids made here, not yet confirmed saved
// A checklist line remembers its task. A new line split off one starts with none.
const NoteTaskItem = TaskItem.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      taskId: { default: null, keepOnSplit: false, parseHTML: (el) => el.getAttribute("data-task-id"), renderHTML: (a) => (a.taskId ? { "data-task-id": a.taskId } : {}) },
    };
  },
});

// The spaces: my, work and joint (shared with the household) are always
// there and can be renamed; more can be added (Spaces, the gear), private to
// whoever adds them (sql/notes-spaces.sql). Kept per person in app_state
// (app "notes", data.spaces), with a copy on the device.
const BUILT_IN = [{ id: "my", label: "my space" }, { id: "work", label: "work" }, { id: "joint", label: "joint", shared: true }];
let SPACES = BUILT_IN;
const SPACES_KEY = "notes.spaces";   // also read by search (spotlight.js)
// Everything kept per person (app_state "notes", copy on the device): spaces,
// favourite colours, and each space's look for light and dark mode.
const STATE_KEY = "notes.state";
const TASK_SPACES = ["my", "work", "joint"];   // the spaces tasks. has; a note in another space makes my space tasks
const BASE_COLUMNS = "id,space,title,body_text,household_id,deleted_at,updated_at,parent_id,position,pinned,day";
const SAVE_AFTER = 1000;
const BIN_DAYS = 30;
const UNSAVED = "notes.unsaved";
const SPACE_KEY = "notes.space";
const FOLDER_KEY = "notes.folder";   // the folder last chosen in each space
const OPEN_KEY = "notes.open";       // folders shown open in the sidebar
const SIDE_KEY = "notes.sideWidth";  // the sidebar's width, dragged by its edge
const SIDE_OFF_KEY = "notes.sideOff"; // the sidebar folded away (⌘S)
const SIDE_WIDTH = 272;
const LONG_PRESS = 350;              // ms held on a touch screen before dragging starts
const CHEV = `<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>`;
const PAGE_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3h7l5 5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v5h5M9 13h6M9 17h6"/></svg>`;
const DAY_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>`;
const PIN_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4h6l-1 6 4 4H6l4-4-1-6zM12 14v6"/></svg>`;
// Page styles (Style on a note; sql/notes-style.sql): the page colour of the
// box the note is written in, and the backdrop behind it. Each has an ink, the
// text colour that reads on it. Saved by name, so a preset can be retuned here.
const STYLES = {
  card: {
    paper: { label: "Paper", bg: "#fffdf8", ink: "#2c2218" },
    white: { label: "White", bg: "#ffffff", ink: "#22201c" },
    sand: { label: "Sand", bg: "#f3e9d6", ink: "#3a2e1e" },
    butter: { label: "Butter", bg: "#faf0c8", ink: "#3b3216" },
    sage: { label: "Sage", bg: "#e2ebdf", ink: "#22311f" },
    sky: { label: "Sky", bg: "#e0ebf5", ink: "#1e2e3d" },
    lavender: { label: "Lavender", bg: "#ebe5f5", ink: "#2b2440" },
    rose: { label: "Rose", bg: "#f6e2e2", ink: "#3d2222" },
    charcoal: { label: "Charcoal", bg: "#2a2c30", ink: "#ececea" },
    midnight: { label: "Midnight", bg: "#1c2434", ink: "#e5eaf4" },
    forest: { label: "Forest", bg: "#1e2b23", ink: "#e2ede5" },
  },
  backdrop: {
    lake: { label: "Lake", css: "linear-gradient(180deg, #23406e 0%, #3a6a9f 55%, #5b9cc4 100%)", ink: "#f4f8fc" },
    ocean: { label: "Ocean", css: "linear-gradient(160deg, #1d3a6e 0%, #2b5aa0 50%, #79b0de 100%)", ink: "#f4f8fc" },
    aurora: { label: "Aurora", css: "linear-gradient(160deg, #0f2a3a 0%, #16575a 45%, #6fcfa6 100%)", ink: "#f0faf5" },
    forest: { label: "Forest", css: "linear-gradient(160deg, #1d3a2b 0%, #3c6a4e 60%, #9cc4a0 100%)", ink: "#f2f8f3" },
    dusk: { label: "Dusk", css: "linear-gradient(160deg, #2a1c49 0%, #6a3c79 55%, #e3898a 100%)", ink: "#fbf3f6" },
    night: { label: "Night", css: "linear-gradient(180deg, #11141c 0%, #1f2638 60%, #2f3a55 100%)", ink: "#eef1f7" },
    sunset: { label: "Sunset", css: "linear-gradient(160deg, #ff9b76 0%, #fbcf7d 60%, #fbe8c3 100%)", ink: "#3a2416" },
    dawn: { label: "Dawn", css: "linear-gradient(160deg, #f9cfc0 0%, #f5e5c6 55%, #d6e2f1 100%)", ink: "#33281f" },
    meadow: { label: "Meadow", css: "linear-gradient(160deg, #d9ebc9 0%, #eef3d8 55%, #cfe6e0 100%)", ink: "#25321f" },
    mist: { label: "Mist", css: "linear-gradient(160deg, #dde5eb 0%, #eef1f4 50%, #e3dfec 100%)", ink: "#2a2e36" },
    stone: { label: "Stone", css: "#d8d2c6", ink: "#2c2720" },
  },
};
const pad2 = (n) => String(n).padStart(2, "0");
const isoDay = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const today = () => isoDay(new Date());
const shiftDay = (iso, n) => { const [y, m, d] = iso.split("-").map(Number); return isoDay(new Date(y, m - 1, d + n)); };
const dayLabel = (iso) => { const [y, m, d] = iso.split("-").map(Number); const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", ...(y !== new Date().getFullYear() ? { year: "numeric" } : {}) }); };
const DOTS = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>`;
const FOLDER_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`;

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
  // Built-ins first (named as you've named them), then the ones you added.
  function useSpaces(saved) {
    const list = Array.isArray(saved) ? saved.filter(x => x && /^[a-z][a-z0-9_]{0,39}$/.test(x.id) && String(x.label || "").trim()) : [];
    SPACES = [...BUILT_IN.map(b => ({ ...b, label: list.find(x => x.id === b.id)?.label || b.label })),
      ...list.filter(x => !BUILT_IN.some(b => b.id === x.id)).map(x => ({ id: x.id, label: String(x.label).trim() }))];
  }
  let notesState = readJSON(STATE_KEY, null) || { spaces: readJSON(SPACES_KEY, null) || undefined };
  useSpaces(notesState.spaces);
  // Saves a change to it, here and with the account.
  async function saveState(change) {
    notesState = { ...notesState, ...change };
    writeJSON(STATE_KEY, notesState);
    if (change.spaces) writeJSON(SPACES_KEY, change.spaces);
    const { data: { session } } = await supabase.auth.getSession();
    const { error } = await supabase.from("app_state").upsert(
      { user_id: session?.user?.id, app: "notes", data: notesState, updated_at: new Date().toISOString() }, { onConflict: "user_id,app" });
    if (error) { toast(`Saved on this device only: ${error.message}`, { err: true }); console.error("notes.: saving settings failed:", error.message); }
  }
  let space = SPACES.some(s => s.id === readJSON(SPACE_KEY)) ? readJSON(SPACE_KEY) : "my";
  let folder = readJSON(FOLDER_KEY, {})[space] || null;   // the folder shown, or null for the top of the space
  const opened = new Set(readJSON(OPEN_KEY, []));
  function setOpen(id, on) {
    if (!id) return;
    if (on) opened.add(id); else opened.delete(id);
    writeJSON(OPEN_KEY, [...opened]);
  }
  function goTo(spaceId, folderId) {
    space = spaceId; folder = folderId || null;
    writeJSON(SPACE_KEY, space);
    writeJSON(FOLDER_KEY, { ...readJSON(FOLDER_KEY, {}), [space]: folder });
  }
  // Notes changed here and not yet confirmed saved: { [id]: entry }, where an
  // entry is { id, isNew, base (updated_at it was opened at), space, parent, title, body, body_text }.
  const unsaved = () => readJSON(UNSAVED, {});
  const keepUnsaved = (entry) => writeJSON(UNSAVED, { ...unsaved(), [entry.id]: entry });
  const dropUnsaved = (id) => { const all = unsaved(); delete all[id]; writeJSON(UNSAVED, all); };

  // ─── Notes in Supabase ────────────────────────────────────────────
  let notes = [];      // every note you can see, bin included (list columns only)
  let ready = false;   // the table exists and loaded
  let folders = true;  // false until notes-folders.sql has been run
  let listColumns = `${BASE_COLUMNS},kind`;

  async function load() {
    let { data, error } = await supabase.from("notes").select(listColumns).order("updated_at", { ascending: false });
    if (error?.code === "42703" && /kind/.test(error.message)) {
      folders = false;
      listColumns = BASE_COLUMNS;
      ({ data, error } = await supabase.from("notes").select(listColumns).order("updated_at", { ascending: false }));
    }
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
    for (const e of Object.values(unsaved())) mergeRow({ id: e.id, space: e.space, parent_id: e.parent ?? null, title: e.title, body_text: e.body_text, updated_at: new Date().toISOString(), deleted_at: null });
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
        .insert({ id: e.id, space: e.space, parent_id: e.parent ?? null, household_id: e.day ? null : await householdFor(e.space), title: e.title, body: e.body, body_text: e.body_text, ...(e.day ? { day: e.day } : {}), ...(e.style ? { style: e.style } : {}) })
        .select(listColumns).single();
      // Page styles not set up yet (notes-style.sql): saved without its style.
      if (error?.code === "42703" && /style/.test(error.message)) { styleMissing(); return push({ ...e, style: null }); }
      if (error?.code === "23514" && /space/.test(error.message)) toast("Spaces you add aren’t set up yet: run lifeos/sql/notes-spaces.sql in Supabase.", { err: true });
      // That day's note was started on another device: theirs stays, this
      // one is kept beside it as an ordinary note.
      if (error?.code === "23505" && /per_day/.test(error.message)) {
        const { data: theirs, error: err2 } = await supabase.from("notes").select("*").eq("day", e.day).is("deleted_at", null).maybeSingle();
        if (err2) throw err2;
        const copy = await push({ ...e, id: crypto.randomUUID(), day: null, title: `${dayLabel(e.day)} (from another device)` });
        return { conflict: true, theirs, copy };
      }
      // Already there: an earlier save arrived but its reply didn't.
      if (error?.code === "23505") return push({ ...e, isNew: false, base: null });
      if (error) throw error;
      return data;
    }
    let q = supabase.from("notes").update({ title: e.title, body: e.body, body_text: e.body_text }).eq("id", e.id);
    if (e.base) q = q.eq("updated_at", e.base);
    const { data, error } = await q.select(listColumns);
    if (error) throw error;
    if (data.length) return data[0];
    // Nothing saved: another device saved first, or the note is gone.
    const { data: theirs, error: err2 } = await supabase.from("notes").select("*").eq("id", e.id).maybeSingle();
    if (err2) throw err2;
    if (!theirs) return push({ ...e, isNew: true });
    const copy = await push({ ...e, id: crypto.randomUUID(), isNew: true, day: null, space: theirs.space, parent: theirs.parent_id,
      title: `${e.day ? dayLabel(e.day) : e.title || "Untitled"} (conflict copy)` });
    return { conflict: true, theirs, copy };
  }

  // ─── The open note ────────────────────────────────────────────────
  let current = null;   // { id, isNew, base, space, parent, day, style }
  let editor = null;
  let dirty = false, saving = null, saveTimer = 0, retryTimer = 0;

  function status(text, warn = false) {
    $("status").textContent = text;
    $("status").classList.toggle("warn", warn);
  }
  function entryNow() {
    return { id: current.id, isNew: current.isNew, base: current.base, space: current.space, parent: current.parent, day: current.day || null, style: current.style || null,
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
          if (current === note) await syncTasks(note);
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

  // Saves until nothing is left: tying lines to tasks changes the note again.
  async function flush() {
    for (let i = 0; i < 4 && (dirty || saving); i++) await saveNow();
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
  const pick = (row) => Object.fromEntries(listColumns.split(",").map(k => [k, row[k]]));

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
        NoteTaskItem.configure({ nested: true }),
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
    const parent = liveFolder(row.parent_id ?? row.parent)?.id ?? null;
    current = { id: row.id, isNew: Boolean(row.isNew), base: row.updated_at || null, space: row.space, parent, day: row.day || null, style: row.style || null };
    showLook();
    savedStyle = current.style;
    dirty = false;
    // The sidebar shows where the note lives, its folders open.
    if (!current.day) { goTo(row.space, parent); for (const f of pathTo(parent)) setOpen(f.id, true); }
    // A daily note's name is its date, with arrows to the days either side.
    $("day-bar").hidden = !current.day;
    $("title").hidden = Boolean(current.day);
    $("pin").hidden = $("move").hidden = Boolean(current.day);
    if (current.day) { $("day-title").textContent = dayLabel(current.day); $("day-input").value = current.day; }
    paintPin();
    $("title").value = row.title || "";
    makeEditor(row.body);
    labelBack();
    $("empty").hidden = true;
    $("note").hidden = false;
    $("shell").dataset.view = "note";
    $("add").classList.add("away");
    sizeTitle();   // once shown: a hidden box measures 0
    status(row.isNew ? "" : row.updated_at ? `Edited ${when(row.updated_at)}` : "");
    renderList();
    if (focus === "title" && !current.day) $("title").focus();
    else if (focus) focusNote("end");
  }

  async function openNote(id) {
    stopMic();
    await flush();
    const draft = unsaved()[id];
    const { data, error } = await supabase.from("notes").select("*").eq("id", id).maybeSingle();
    if (error && !draft) { toast(`Couldn’t open that note: ${error.message}`, { err: true }); return; }
    if (!data && !draft) { toast("That note isn’t there any more.", { err: true }); return; }
    // A copy on this device that never got saved is what you last saw.
    if (draft) {
      showNote({ ...(data || {}), ...draft, updated_at: draft.base, isNew: !data });
      changed();
    } else showNote(data);
    if (data) loadNoteTasks(current);
  }

  // A day's note: the one there is, or a new one started when you write.
  async function openDay(iso) {
    if (!ready) return;
    stopMic();
    await flush();
    const draft = Object.values(unsaved()).find(e => e.day === iso);
    const there = notes.find(n => n.day === iso && !n.deleted_at) || (draft && { id: draft.id });
    if (there) return openNote(there.id);
    showNote({ id: crypto.randomUUID(), isNew: true, space: "my", day: iso, title: "", body: null }, { focus: "end" });
  }

  async function newNote() {
    if (!ready) return;
    stopMic();
    await flush();
    showNote({ id: crypto.randomUUID(), isNew: true, space, parent_id: folder, title: "", body: null }, { focus: "title" });
  }

  async function closeNote() {
    stopMic();
    await flush();
    current = null;
    showLook();
    closeStyle();
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
  // What went in the bin together: a note, or a folder and all it held.
  const group = (n) => [n.id, ...descendants(n.id, (m) => m.deleted_at === n.deleted_at)];
  async function restore(id) {
    const n = byId(id);
    if (!n) return;
    const ids = group(n);
    const { error } = await supabase.from("notes").update({ deleted_at: null }).in("id", ids);
    if (error) { toast(`Couldn’t bring it back: ${error.message}`, { err: true }); return; }
    for (const i of ids) mergeRow({ id: i, deleted_at: null });
    // Its folder is still in the bin (or gone): back at the top of the space.
    if (n.parent_id && !liveFolder(n.parent_id)) {
      await supabase.from("notes").update({ parent_id: null }).eq("id", id);
      mergeRow({ id, parent_id: null });
    }
    renderList(); renderBin();
  }
  async function deleteForGood(id) {
    const n = byId(id);
    const ids = group(n);
    if (!confirm(`Delete ${isFolder(n) ? "this folder and everything in it" : "this note"} for good? It can’t be brought back.`)) return;
    const { error } = await supabase.from("notes").delete().in("id", ids);
    if (error) { toast(`Couldn’t delete it: ${error.message}`, { err: true }); return; }
    notes = notes.filter(m => !ids.includes(m.id));
    renderBin();
  }

  // ─── Folders ──────────────────────────────────────────────────────
  const byId = (id) => id ? notes.find(n => n.id === id) : undefined;
  const isFolder = (n) => n?.kind === "folder";
  const liveFolder = (id) => { const f = byId(id); return isFolder(f) && !f.deleted_at ? f : null; };
  // Where something shows: in its folder if that's still there, else the top of its space.
  const placeOf = (n) => { const f = liveFolder(n.parent_id); return f && f.space === n.space ? f.id : null; };
  // What sits in a folder (or the top of a space), in sidebar order.
  function childrenOf(parent, spaceId = space) {
    const here = notes.filter(n => n.space === spaceId && !n.deleted_at && !n.day && placeOf(n) === parent);
    const plain = [...here.filter(isFolder).sort(byName), ...here.filter(n => !isFolder(n)).sort(byName)];
    if (!here.some(n => n.position != null)) return plain;
    // Placed by hand: those in order, anything new after them as before.
    const pos = (n) => n.position == null ? Infinity : Number(n.position);
    return plain.map((n, i) => [n, i]).sort((a, b) => pos(a[0]) - pos(b[0]) || a[1] - b[1]).map(x => x[0]);
  }

  // Changes some rows. The open note's version moves on with it, so its next
  // save isn't mistaken for another device's.
  async function patch(ids, fields) {
    const { data, error } = await supabase.from("notes").update(fields).in("id", ids).select("id,updated_at");
    if (error) throw error;
    for (const r of data) {
      mergeRow({ id: r.id, ...fields, updated_at: r.updated_at });
      if (current?.id === r.id) current.base = r.updated_at;
    }
    return data;
  }

  // ─── Tasks in notes ───────────────────────────────────────────────
  let tasksOn = true;                 // false until notes-tasks.sql has been run
  const baseline = new Map();         // taskId → { text, done } as last in step with the task
  const pending = () => new Set(readJSON(PENDING_TASKS, []));
  const keepPending = (set) => writeJSON(PENDING_TASKS, [...set].slice(-500));
  function lines(doc) {
    const out = [];
    doc.descendants((node, pos) => {
      if (node.type.name === "taskItem") out.push({ node, pos, taskId: node.attrs.taskId, checked: Boolean(node.attrs.checked), text: (node.firstChild?.textContent || "").trim() });
    });
    return out;
  }
  // A line as a task: its date, priority and repeat taken out of the words;
  // a daily note's lines fall on its day.
  async function asTask(text, day) {
    await loadChrono();
    const found = parseTasks(text, chrono, { defaultSpace: "my" });
    const one = found.length === 1 ? found[0] : null;
    return { text: one?.text || text, date: (one || found[0])?.date || day || null, priority: one?.priority || 0, repeat: one?.repeat || null };
  }
  let warnedTasks = false;
  function tasksMissing(err) {
    if (err?.code !== "42703" || !/note_id/.test(err.message)) return false;
    tasksOn = false;
    if (!warnedTasks) { warnedTasks = true; toast("Checklists can’t become tasks yet: run lifeos/sql/notes-tasks.sql in Supabase.", { err: true }); }
    return true;
  }
  // Changes lines without an undo step (ids and ticks aren't edits).
  function setLines(changes) {
    if (!changes.length || !editor) return;
    const tr = editor.state.tr;
    for (const { pos, attrs } of changes) tr.setNodeMarkup(pos, undefined, { ...editor.state.doc.nodeAt(pos).attrs, ...attrs });
    tr.setMeta("addToHistory", false);
    editor.view.dispatch(tr);
  }

  // When a note opens: ticks made in tasks. come in, lines whose task has
  // gone are let go, and the rest are in step from here.
  async function loadNoteTasks(note) {
    baseline.clear();
    if (!tasksOn || !note || note.isNew) return;
    const ids = lines(editor.state.doc).map(l => l.taskId).filter(id => id && id !== "off");
    if (!ids.length) return syncTasks(note);
    const { data, error } = await supabase.from("hub_tasks").select("id,text,done_at").eq("note_id", note.id);
    if (error) { if (!tasksMissing(error)) console.error("notes.: loading the note's tasks failed:", error.message); return; }
    if (current !== note || !editor) return;
    const rows = new Map(data.map(r => [r.id, r]));
    const waiting = pending();
    const changes = [];
    for (const l of lines(editor.state.doc)) {
      if (!l.taskId || l.taskId === "off") continue;
      const row = rows.get(l.taskId);
      if (!row) { if (!waiting.has(l.taskId)) changes.push({ pos: l.pos, attrs: { taskId: "off" } }); continue; }
      const done = Boolean(row.done_at);
      if (done !== l.checked) changes.push({ pos: l.pos, attrs: { checked: done } });
      baseline.set(l.taskId, { text: l.text, done });
    }
    setLines(changes);
    await syncTasks(note);
  }

  // After a save: new lines become tasks, changed ones change theirs, and
  // a deleted line's open task goes.
  let syncing = null;
  async function syncTasks(note) {
    if (!tasksOn || !editor || current !== note || note.isNew) return;
    if (syncing) return syncing;
    syncing = (async () => {
      const all = lines(editor.state.doc);
      // New lines (and a pasted copy of a line) get a task id now.
      const seen = new Set(), assign = [];
      for (const l of all) {
        if (l.taskId === "off") continue;
        if ((!l.taskId && l.text) || (l.taskId && seen.has(l.taskId))) assign.push({ ...l, taskId: crypto.randomUUID() });
        else if (l.taskId) seen.add(l.taskId);
      }
      setLines(assign.map(a => ({ pos: a.pos, attrs: { taskId: a.taskId } })));
      const waiting = pending();
      const toMake = [...assign, ...all.filter(l => l.taskId && l.taskId !== "off" && !baseline.has(l.taskId) && waiting.has(l.taskId) && l.text)];
      if (toMake.length) {
        for (const l of toMake) waiting.add(l.taskId);
        keepPending(waiting);
        const household_id = note.space === "joint" ? await householdFor("joint") : null;
        const rows = await Promise.all(toMake.map(async (l) => {
          const t = await asTask(l.text, note.day);
          return { id: l.taskId, text: t.text, date: t.date, priority: t.priority, repeat: t.repeat, space: TASK_SPACES.includes(note.space) ? note.space : "my", household_id, note_id: note.id, done_at: l.checked ? new Date().toISOString() : null };
        }));
        const { error } = await supabase.from("hub_tasks").upsert(rows, { onConflict: "id", ignoreDuplicates: true });
        if (error) { if (!tasksMissing(error)) console.error("notes.: making tasks failed:", error.message); return; }
        const left = pending();
        for (const l of toMake) { left.delete(l.taskId); baseline.set(l.taskId, { text: l.text, done: l.checked }); }
        keepPending(left);
      }
      // Changed lines: their words (only when the line changed) and their tick.
      const made = new Set(toMake.map(l => l.taskId));
      for (const l of all) {
        const b = l.taskId && !made.has(l.taskId) && baseline.get(l.taskId);
        if (!b) continue;
        const fields = {};
        if (l.text && l.text !== b.text) {
          const t = await asTask(l.text, null);
          fields.text = t.text;
          if (t.date) fields.date = t.date;
        }
        if (l.checked !== b.done) fields.done_at = l.checked ? new Date().toISOString() : null;
        if (!Object.keys(fields).length) continue;
        const { error } = await supabase.from("hub_tasks").update(fields).eq("id", l.taskId);
        if (error) { console.error("notes.: updating a task failed:", error.message); continue; }
        baseline.set(l.taskId, { text: l.text || b.text, done: l.checked });
      }
      // Deleted lines: their tasks go, unless already ticked off.
      const here = new Set(lines(editor.state.doc).map(l => l.taskId));
      const gone = [...baseline.keys()].filter(id => !here.has(id));
      if (gone.length) {
        const { error } = await supabase.from("hub_tasks").delete().in("id", gone).is("done_at", null);
        if (error) console.error("notes.: removing tasks failed:", error.message);
        else for (const id of gone) baseline.delete(id);
      }
    })();
    try { await syncing; } finally { syncing = null; }
  }

  // ─── Page styles ──────────────────────────────────────────────────
  // A style is { card, backdrop } by preset name, or "custom" with hex
  // colours: cardHex; bdA (+ bdB for a gradient, bdAngle 180/135/90/radial);
  // and ink, the text colour (none: dark or light to suit the page).
  const hex = (h) => {
    const m = String(h || "").trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (!m) return null;
    const v = m[1].length === 3 ? m[1].split("").map(c => c + c).join("") : m[1];
    return `#${v.toLowerCase()}`;
  };
  const luminance = (h) => {
    const [r, g, b] = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  // Dark text on a light colour, light text on a dark one.
  const inkOn = (colours) => (colours.reduce((t, c) => t + luminance(c), 0) / colours.length > 0.36 ? "#22201c" : "#f4f3ef");
  const isLight = (h) => luminance(h) > 0.36;
  function resolve(style) {
    let card = STYLES.card[style?.card] || null;
    if (style?.card === "custom" && hex(style.cardHex)) card = { bg: hex(style.cardHex), ink: inkOn([hex(style.cardHex)]) };
    let bd = STYLES.backdrop[style?.backdrop] || null;
    if (style?.backdrop === "custom" && hex(style.bdA)) {
      const A = hex(style.bdA), B = hex(style.bdB);
      bd = !B ? { css: A, ink: inkOn([A]) }
        : { css: style.bdAngle === "radial" ? `radial-gradient(circle at 50% 30%, ${A}, ${B})` : `linear-gradient(${Number(style.bdAngle) || 180}deg, ${A}, ${B})`, ink: inkOn([A, B]) };
    }
    return { card, bd, ink: hex(style?.ink) };
  }
  function applyStyle(style) {
    const { card, bd, ink } = resolve(style);
    const box = $("editor").closest(".card");
    box.classList.toggle("styled", Boolean(card));
    box.classList.toggle("inked", !card && Boolean(ink));
    box.style.setProperty("--card-bg", card?.bg || "");
    box.style.setProperty("--card-ink", ink || card?.ink || "");
    const page = document.body;
    page.classList.toggle("backdrop", Boolean(bd));
    page.style.setProperty("--bd", bd?.css || "");
    page.style.setProperty("--bd-ink", bd?.ink || "");
    // The sidebar wears the backdrop, or the page colour when there's none.
    const side = bd ? { paint: bd.css, ink: bd.ink } : card ? { paint: card.bg, ink: card.ink } : null;
    page.classList.toggle("tinted", Boolean(side));
    page.style.setProperty("--side-paint", side?.paint || "");
    page.style.setProperty("--side-ink", side?.ink || "");
    page.style.setProperty("--side-on", side ? (isLight(side.ink) ? "#1a1e1a" : "#ffffff") : "");
  }
  // A space's look for light or dark mode (whichever the device is in now),
  // worn by its notes that have none of their own, and by the sidebar.
  const darkMode = matchMedia("(prefers-color-scheme: dark)");
  const modeName = () => (darkMode.matches ? "dark" : "light");
  const spaceOf = (c) => (c?.day ? "my" : c?.space || space);
  const lookFor = (sp) => notesState.looks?.[sp]?.[modeName()] || null;
  const lookNow = () => (current ? current.style || lookFor(spaceOf(current)) : lookFor(space));
  function showLook() { applyStyle(lookNow()); }
  darkMode.addEventListener("change", () => { showLook(); if (!$("style-pop").hidden) paintStyle(); });

  let warnedStyle = false;
  function styleMissing() {
    if (warnedStyle) return;
    warnedStyle = true;
    toast("Page styles aren’t set up yet: run lifeos/sql/notes-style.sql in Supabase.", { err: true });
  }
  // Shown at once; saved a moment after the last change (a colour picker
  // sends a stream of them while it's dragged).
  let savedStyle = null, styleTimer = 0;
  function setStyle(change, { soon = false } = {}) {
    if (!current) return;
    // A note following its space's look starts its own from that look.
    const next = { ...(current.style || lookFor(spaceOf(current)) || {}), ...change };
    for (const k of Object.keys(next)) if (next[k] == null || next[k] === "") delete next[k];
    commitStyle(Object.keys(next).length ? next : null, { soon });
  }
  function commitStyle(next, { soon = false } = {}) {
    current.style = next;
    showLook();
    paintStyle();
    // Not saved yet: it goes in with the note's first save.
    if (current.isNew && !byId(current.id)) { if (dirty) keepUnsaved(entryNow()); return; }
    clearTimeout(styleTimer);
    const note = current;
    styleTimer = setTimeout(async () => {
      if (current !== note) return;
      await saveNow();
      try { await patch([note.id], { style: note.style }); savedStyle = note.style; }
      catch (err) {
        if (err.code === "42703") styleMissing();
        else toast(`Couldn’t change the style: ${err.message}`, { err: true });
        note.style = savedStyle;
        if (current === note) { showLook(); paintStyle(); }
      }
    }, soon ? 600 : 0);
  }
  function paintStyle() {
    const on = current?.style || lookFor(spaceOf(current)) || {};
    const { card } = resolve(on);
    const sw = (kind, key, p) => `<button type="button" class="swatch${key ? "" : " none"}" data-kind="${kind}" data-key="${key || ""}" aria-pressed="${(on[kind] || "") === (key || "")}"
      title="${p ? p.label : "None"}" aria-label="${p ? p.label : "None"}"${p ? ` style="background:${kind === "card" ? p.bg : p.css}"` : ""}></button>`;
    const custom = (kind) => `<button type="button" class="swatch custom" data-kind="${kind}" data-key="custom" aria-pressed="${on[kind] === "custom"}" title="Your own colour" aria-label="Your own colour"></button>`;
    $("card-swatches").innerHTML = sw("card", null) + Object.entries(STYLES.card).map(([k, p]) => sw("card", k, p)).join("") + custom("card");
    $("backdrop-swatches").innerHTML = sw("backdrop", null) + Object.entries(STYLES.backdrop).map(([k, p]) => sw("backdrop", k, p)).join("") + custom("backdrop");
    // The boxes show what's in use; one being typed in is left alone.
    const fillHex = (id, value) => { const el = $(id); if (el && document.activeElement !== el) { el.value = value ? value.toUpperCase() : ""; el.classList.remove("bad"); } };
    const fillPick = (id, value) => { if (value) $(id).value = value; };
    $("card-custom").hidden = on.card !== "custom";
    fillHex("card-hex", hex(on.cardHex)); fillPick("card-pick", hex(on.cardHex));
    $("ink-auto").setAttribute("aria-pressed", String(!hex(on.ink)));
    const shownInk = hex(on.ink) || card?.ink || "#2c2218";
    fillHex("ink-hex", hex(on.ink)); fillPick("ink-pick", shownInk);
    $("bd-custom").hidden = on.backdrop !== "custom";
    const gradient = Boolean(hex(on.bdB));
    for (const b of $("bd-custom").querySelectorAll("[data-bd-kind]")) b.setAttribute("aria-pressed", String((b.dataset.bdKind === "gradient") === gradient));
    for (const id of ["bd-to", "bd-pick-b", "bd-hex-b"]) $(id).hidden = !gradient;
    $("bd-dir").hidden = !gradient;
    for (const b of $("bd-dir").querySelectorAll("[data-angle]")) b.setAttribute("aria-pressed", String(b.dataset.angle === String(on.bdAngle || "180")));
    fillHex("bd-hex-a", hex(on.bdA)); fillPick("bd-pick-a", hex(on.bdA));
    fillHex("bd-hex-b", hex(on.bdB)); fillPick("bd-pick-b", hex(on.bdB));
    paintFavs(on);
    // The space's look, for the mode the device is in.
    const sp = spaceOf(current), label = SPACES.find(x => x.id === sp)?.label || "this space", mode = modeName();
    const own = Boolean(current?.style), has = Boolean(lookFor(sp));
    $("style-foot").innerHTML = `<p>${own ? "This note has its own look." : has ? `Following ${esc(label)}’s ${mode}-mode look.` : `Pick colours, then you can make them ${esc(label)}’s ${mode}-mode look.`}</p>
      <div class="row">${own ? `<button type="button" class="chip-btn" data-look="set">Make this ${esc(label)}’s ${mode} look</button>` : ""}
      ${own && has ? `<button type="button" class="chip-btn" data-look="follow">Use ${esc(label)}’s look</button>` : ""}
      ${has ? `<button type="button" class="chip-btn" data-look="clear">Clear ${esc(label)}’s ${mode} look</button>` : ""}</div>`;
  }
  // ─── Favourite colours ────────────────────────────────────────────
  // Kept as hex. One tapped fills the colour box last used.
  const FIELD_LABEL = { cardHex: "page colour", ink: "text colour", bdA: "backdrop", bdB: "backdrop’s second colour" };
  let favField = "cardHex", favEditing = false;
  const favourites = () => notesState.favourites || [];
  function paintFavs(on) {
    const list = favourites();
    $("favs").classList.toggle("editing", favEditing);
    $("favs").innerHTML = list.length ? list.map(h => `<button type="button" class="fav" data-hex="${h}" style="background:${h}" title="${h.toUpperCase()}" aria-label="${favEditing ? "Remove" : "Use"} ${h.toUpperCase()}"><span class="x" aria-hidden="true">×</span></button>`).join("")
      : `<p class="empty-hint">Tap ☆ beside a colour to keep it here.</p>`;
    $("fav-edit").hidden = !list.length;
    $("fav-edit").textContent = favEditing ? "Done" : "Edit";
    $("fav-for").textContent = list.length && !favEditing ? `for the ${FIELD_LABEL[favField]}` : "";
    for (const b of $("style-pop").querySelectorAll(".star")) {
      const v = hex(on[b.dataset.fav]);
      b.classList.toggle("on", Boolean(v && list.includes(v)));
      b.textContent = v && list.includes(v) ? "★" : "☆";
    }
  }
  function useFavourite(h) {
    const on = current?.style || lookFor(spaceOf(current)) || {};
    if (favField === "cardHex") setStyle({ card: "custom", cardHex: h });
    else if (favField === "ink") setStyle({ ink: h });
    else if (favField === "bdA") setStyle({ backdrop: "custom", bdA: h, bdB: on.backdrop === "custom" ? on.bdB : null, bdAngle: on.bdAngle || "180" });
    else setStyle({ backdrop: "custom", bdA: hex(on.bdA) || h, bdB: h, bdAngle: on.bdAngle || "180" });
  }
  $("favs").addEventListener("click", (e) => {
    const f = e.target.closest(".fav");
    if (!f) return;
    if (favEditing) { saveState({ favourites: favourites().filter(x => x !== f.dataset.hex) }); paintStyle(); }
    else useFavourite(f.dataset.hex);
  });
  $("fav-edit").addEventListener("click", () => { favEditing = !favEditing; paintStyle(); });
  for (const [pick, text, key] of [["card-pick", "card-hex", "cardHex"], ["ink-pick", "ink-hex", "ink"], ["bd-pick-a", "bd-hex-a", "bdA"], ["bd-pick-b", "bd-hex-b", "bdB"]]) {
    for (const id of [pick, text]) for (const ev of ["focus", "pointerdown"]) $(id).addEventListener(ev, () => { favField = key; if (!favEditing) $("fav-for").textContent = favourites().length ? `for the ${FIELD_LABEL[key]}` : ""; });
  }
  $("style-pop").addEventListener("click", async (e) => {
    const star = e.target.closest(".star");
    if (star) {
      const on = current?.style || lookFor(spaceOf(current)) || {};
      const v = hex(on[star.dataset.fav]) || hex($({ cardHex: "card-hex", ink: "ink-hex", bdA: "bd-hex-a", bdB: "bd-hex-b" }[star.dataset.fav]).value);
      if (!v) { toast("Choose a colour first, then ☆ keeps it."); return; }
      const list = favourites();
      await saveState({ favourites: list.includes(v) ? list.filter(x => x !== v) : [...list, v].slice(-24) });
      favField = star.dataset.fav;
      paintStyle();
      return;
    }
    const look = e.target.closest("[data-look]")?.dataset.look;
    if (!look || !current) return;
    const sp = spaceOf(current), mode = modeName(), label = SPACES.find(x => x.id === sp)?.label || "this space";
    const looks = { ...(notesState.looks || {}) };
    if (look === "set") {
      looks[sp] = { ...(looks[sp] || {}), [mode]: current.style };
      await saveState({ looks });
      commitStyle(null);   // this note now follows the space's look
      toast(`${label}’s ${mode}-mode look is set.`);
    } else if (look === "follow") commitStyle(null);
    else {
      const left = { ...(looks[sp] || {}) };
      delete left[mode];
      looks[sp] = left;
      await saveState({ looks });
      showLook(); paintStyle();
    }
  });

  function openStyle() {
    const pop = $("style-pop"), btn = $("style-btn");
    paintStyle();
    pop.hidden = false;
    const r = btn.getBoundingClientRect(), page = document.body.getBoundingClientRect();
    pop.style.left = `${Math.max(8, Math.min(r.right - page.left - pop.offsetWidth, page.width - pop.offsetWidth - 8))}px`;
    pop.style.top = `${r.bottom - page.top + 6}px`;
    pop.querySelector('[aria-pressed="true"]')?.focus();
  }
  function closeStyle() { $("style-pop").hidden = true; }
  $("style-btn").addEventListener("click", () => ($("style-pop").hidden ? openStyle() : closeStyle()));
  $("style-pop").addEventListener("click", (e) => {
    const sw = e.target.closest(".swatch");
    const on = current?.style || {};
    if (sw?.dataset.key === "custom") favField = sw.dataset.kind === "card" ? "cardHex" : "bdA";
    if (sw?.dataset.key === "custom" && sw.dataset.kind === "card") setStyle({ card: "custom", cardHex: hex(on.cardHex) || resolve(on).card?.bg || "#f4e9d8" });
    else if (sw?.dataset.key === "custom") setStyle({ backdrop: "custom", bdA: hex(on.bdA) || "#23406e", bdB: on.bdA ? on.bdB : "#5b9cc4", bdAngle: on.bdAngle || "180" });
    else if (sw) setStyle({ [sw.dataset.kind]: sw.dataset.key || null });
    const kind = e.target.closest("[data-bd-kind]")?.dataset.bdKind;
    if (kind) setStyle({ bdB: kind === "gradient" ? hex(on.bdB) || "#5b9cc4" : null });
    const angle = e.target.closest("[data-angle]")?.dataset.angle;
    if (angle) setStyle({ bdAngle: angle });
    if (e.target.closest("#ink-auto")) setStyle({ ink: null });
  });
  // A colour from the picker or typed as hex: the two boxes keep each other up to date.
  for (const [pick, text, key] of [["card-pick", "card-hex", "cardHex"], ["ink-pick", "ink-hex", "ink"], ["bd-pick-a", "bd-hex-a", "bdA"], ["bd-pick-b", "bd-hex-b", "bdB"]]) {
    $(pick).addEventListener("input", () => { $(text).value = $(pick).value.toUpperCase(); $(text).classList.remove("bad"); setStyle({ [key]: $(pick).value }, { soon: true }); });
    $(text).addEventListener("input", () => {
      const v = hex($(text).value);
      $(text).classList.toggle("bad", !v && $(text).value.trim().length > 0);
      if (v) { $(pick).value = v; setStyle({ [key]: v }, { soon: true }); }
    });
  }
  document.addEventListener("pointerdown", (e) => {
    if (!$("style-pop").hidden && !e.target.closest("#style-pop, #style-btn")) closeStyle();
  });

  // ─── Pinning ──────────────────────────────────────────────────────
  function paintPin() {
    const on = Boolean(current && byId(current.id)?.pinned);
    $("pin").setAttribute("aria-pressed", String(on));
    $("pin").title = on ? "Unpin" : "Pin to the top";
    $("pin").setAttribute("aria-label", $("pin").title);
  }
  async function togglePin(id, on = !byId(id)?.pinned) {
    if (current?.id === id) {
      if (current.isNew && !byId(id)) { toast("Write something first, then pin it."); return; }
      await saveNow();
    }
    try { await patch([id], { pinned: on }); }
    catch (err) { toast(`Couldn’t ${on ? "pin" : "unpin"} it: ${err.message}`, { err: true }); return; }
    renderList(); paintPin();
  }

  // ─── Placing by hand ──────────────────────────────────────────────
  // Puts a note or folder at `index` among the things in `parent`.
  async function placeAt(id, parent, index) {
    if (current?.id === id) await saveNow();
    const item = byId(id);
    if (!item) return;
    const others = childrenOf(parent, item.space).filter(n => n.id !== id);
    try {
      // The first time a folder is ordered by hand, what's in it is numbered as it stands.
      const unnumbered = others.filter(n => n.position == null);
      if (unnumbered.length) await Promise.all(others.map((n, i) => patch([n.id], { position: String((i + 1) * 1024) })));
      const at = (n) => Number(n.position);
      const before = others[index - 1], after = others[index];
      const pos = before && after ? (at(before) + at(after)) / 2 : before ? at(before) + 1024 : after ? at(after) - 1024 : 1024;
      await patch([id], { position: String(pos), parent_id: parent });
    } catch (err) {
      toast(`Couldn’t put it there: ${err.message}`, { err: true });
      console.error("notes.: reorder failed:", err.message);
      return;
    }
    setOpen(parent, true);
    if (current?.id === id) { current.parent = parent; labelBack(); }
    renderList();
  }
  function descendants(id, keep = () => true) {
    const out = [], queue = [id];
    while (queue.length) {
      const p = queue.shift();
      for (const n of notes) if (n.parent_id === p && keep(n) && !out.includes(n.id)) { out.push(n.id); queue.push(n.id); }
    }
    return out;
  }
  function pathTo(id) {
    const out = [];
    for (let f = liveFolder(id); f && out.length < 30; f = liveFolder(f.parent_id)) out.unshift(f);
    return out;
  }
  const folderName = (f) => f.title || "Untitled folder";
  function labelBack() {
    if (current?.day) { $("back-label").textContent = "notes"; return; }
    const f = current && liveFolder(current.parent);
    $("back-label").textContent = f ? folderName(f) : SPACES.find(x => x.id === current?.space)?.label || "notes";
  }

  // A name, from the little sheet. Resolves to the name, or null if cancelled.
  let nameDone = null;
  function askName({ heading, value = "", ok }) {
    $("name-title").textContent = heading;
    $("name-ok").textContent = ok;
    $("name-input").value = value;
    $("name-dlg").showModal();
    $("name-input").focus();
    $("name-input").select();
    return new Promise((res) => { nameDone = res; });
  }
  function finishName(value) {
    const done = nameDone;
    nameDone = null;
    if ($("name-dlg").open) $("name-dlg").close();
    done?.(value);
  }
  $("name-form").addEventListener("submit", (e) => { e.preventDefault(); finishName($("name-input").value.trim() || null); });
  $("name-cancel").addEventListener("click", () => finishName(null));
  $("name-dlg").addEventListener("close", () => finishName(null));

  async function newFolder(parent = folder) {
    if (!ready || !folders) return;
    const name = await askName({ heading: "New folder", ok: "Make folder" });
    if (!name) return;
    const { data, error } = await supabase.from("notes")
      .insert({ id: crypto.randomUUID(), kind: "folder", title: name, space, parent_id: parent, household_id: await householdFor(space) })
      .select(listColumns).single();
    if (error) { toast(`Couldn’t make the folder: ${error.message}`, { err: true }); console.error("notes.: new folder failed:", error.message); return; }
    mergeRow(data);
    setOpen(parent, true);
    renderList();
  }
  async function renameFolder(id) {
    const f = byId(id);
    const name = await askName({ heading: "Rename folder", value: f.title, ok: "Rename" });
    if (!name || name === f.title) return;
    try { await patch([id], { title: name }); }
    catch (err) { toast(`Couldn’t rename it: ${err.message}`, { err: true }); return; }
    renderList(); labelBack();
  }
  async function deleteFolder(id) {
    const f = byId(id);
    const inside = descendants(id, (n) => !n.deleted_at);
    if (!confirm(`Move “${folderName(f)}”${inside.length ? ` and the ${inside.length} thing${inside.length === 1 ? "" : "s"} in it` : ""} to the bin?`)) return;
    const ids = [id, ...inside];
    if (current && ids.includes(current.id)) await closeNote();
    const at = new Date().toISOString();
    const { error } = await supabase.from("notes").update({ deleted_at: at }).in("id", ids);
    if (error) { toast(`Couldn’t move it to the bin: ${error.message}`, { err: true }); console.error("notes.: folder bin failed:", error.message); return; }
    for (const i of ids) mergeRow({ id: i, deleted_at: at });
    goTo(space, liveFolder(f.parent_id)?.id);
    renderList(); renderBin();
    toast("Folder moved to the bin.", { action: "Undo", onAction: () => restore(id) });
  }

  // Moving a note or folder: to the top of a space, or into a folder.
  function openMove(id) {
    const item = byId(id) || (current?.id === id ? { id, space: current.space, parent_id: current.parent } : null);
    if (!item) return;
    const blocked = new Set(isFolder(item) ? [id, ...descendants(id)] : []);
    const here = `${item.space}|${placeOf(item) || ""}`;
    const button = (sp, parent, label, depth = 0) =>
      `<button type="button" data-space="${sp}" data-parent="${parent || ""}"${`${sp}|${parent || ""}` === here ? ' aria-current="true"' : ""} style="padding-left:${10 + depth * 18}px">${parent ? FOLDER_ICON : ""}${esc(label)}${`${sp}|${parent || ""}` === here ? " (here)" : ""}</button>`;
    const tree = (sp, parent, depth) => notes
      .filter(n => isFolder(n) && !n.deleted_at && n.space === sp && placeOf(n) === parent && !blocked.has(n.id))
      .sort((a, b) => folderName(a).localeCompare(folderName(b)))
      .map(f => button(sp, f.id, folderName(f), depth) + tree(sp, f.id, depth + 1)).join("");
    $("move-title").textContent = `Move “${isFolder(item) ? folderName(item) : naming(item).name || "Untitled"}” to`;
    $("move-list").innerHTML = SPACES.map(sp => `<p class="space-name">${esc(sp.label)}</p>${button(sp.id, null, `Top of ${sp.label}`)}${folders ? tree(sp.id, null, 1) : ""}`).join("");
    $("move-list").dataset.id = id;
    $("move-dlg").showModal();
  }
  $("move-cancel").addEventListener("click", () => $("move-dlg").close());
  $("move-list").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-space]");
    if (!b || b.getAttribute("aria-current") === "true") return;
    $("move-dlg").close();
    moveItem($("move-list").dataset.id, b.dataset.space, b.dataset.parent || null);
  });

  async function moveItem(id, toSpace, toParent) {
    // A new note not saved yet just changes where it will be saved.
    if (current?.id === id && current.isNew && !byId(id)) {
      current.space = toSpace; current.parent = toParent;
      goTo(toSpace, toParent); labelBack(); renderList();
      if (dirty) keepUnsaved(entryNow());
      return;
    }
    if (current?.id === id) await saveNow();
    const item = byId(id);
    if (!item) return;
    // Into another space: everything inside goes too.
    const ids = toSpace !== item.space ? [id, ...descendants(id)] : [id];
    const household_id = await householdFor(toSpace);
    let error = null;
    try {
      await patch([id], { parent_id: toParent, space: toSpace, household_id, position: null });
      if (ids.length > 1) await patch(ids.slice(1), { space: toSpace, household_id });
    } catch (err) { error = err; }
    // Their checklist tasks go with them (a space tasks. doesn't have: my space).
    if (!error && toSpace !== item.space && tasksOn) {
      const r = await supabase.from("hub_tasks").update({ space: TASK_SPACES.includes(toSpace) ? toSpace : "my", household_id: toSpace === "joint" ? household_id : null }).in("note_id", ids);
      if (r.error && !tasksMissing(r.error)) console.error("notes.: moving the note's tasks failed:", r.error.message);
    }
    if (error) {
      toast(error.code === "42501" ? "Only the person who wrote it can take it out of joint." : `Couldn’t move it: ${error.message}`, { err: true });
      if (error.code !== "42501") console.error("notes.: move failed:", error.message);
      return;
    }

    if (current && ids.includes(current.id)) {
      current.space = toSpace;
      if (current.id === id) current.parent = toParent;
      goTo(current.space, current.parent);
      labelBack();
    } else if (isFolder(item)) goTo(toSpace, id);
    else goTo(toSpace, toParent);
    setOpen(toParent, true);
    renderList(); renderBin();
    const f = liveFolder(toParent);
    toast(`Moved to ${f ? folderName(f) : SPACES.find(x => x.id === toSpace).label}.`);
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
    if (n.day) return { name: dayLabel(n.day), rest: lines.join(" ") };
    return n.title ? { name: n.title, rest: lines.join(" ") } : { name: lines[0] || "", rest: lines.slice(1).join(" ") };
  }

  // The sidebar: this space as a tree. Folders first, then notes, each A to Z.
  const nameOf = (n) => isFolder(n) ? folderName(n) : naming(n).name || "Untitled";
  const byName = (a, b) => nameOf(a).localeCompare(nameOf(b), "en-GB", { sensitivity: "base", numeric: true });
  function renderTabs() {
    $("tabs").innerHTML = SPACES.map(x => `<button type="button" class="tab" data-space="${x.id}" aria-pressed="${x.id === space}">${esc(x.label)}</button>`).join("");
  }
  function renderList() {
    if (!SPACES.some(x => x.id === space)) goTo("my", null);
    renderTabs();
    $("new-folder").hidden = !ready || !folders;
    if (!ready) { $("tree").innerHTML = ""; return; }
    if (folder && liveFolder(folder)?.space !== space) folder = null;
    const label = SPACES.find(x => x.id === space).label;
    const rows = [`<div class="node${current?.day === today() ? " sel" : ""}" role="treeitem" tabindex="-1" data-kind="daily" title="Today’s note (D)"><span class="gap"></span><span class="ic" aria-hidden="true">${DAY_ICON}</span><span class="label">today<i>.</i></span></div>`,
      `<div class="tree-line" data-drop="root" title="The top of ${esc(label)}" aria-hidden="true"></div>`];
    const pinned = notes.filter(n => n.pinned && !n.deleted_at && !n.day && n.space === space).sort(byName);
    if (pinned.length) {
      rows.push(`<div class="tree-head" data-drop="pin">Pinned</div>`);
      for (const n of pinned) rows.push(`<div class="node pinned${current?.id === n.id ? " sel" : ""}" role="treeitem" tabindex="-1" data-id="${n.id}" data-kind="${isFolder(n) ? "folder" : "page"}" data-pinned><span class="gap"></span><span class="ic" aria-hidden="true">${isFolder(n) ? FOLDER_ICON : PIN_ICON}</span><span class="label">${esc(nameOf(n))}</span></div>`);
      rows.push(`<div class="tree-line" data-drop="root" title="The top of ${esc(label)}" aria-hidden="true"></div>`);
    }
    const walk = (parent, depth) => {
      const here = childrenOf(parent);
      if (!here.length && parent) rows.push(`<p class="tree-empty" style="--depth:${depth}">Empty</p>`);
      for (const n of here) {
        if (isFolder(n)) {
          const open = opened.has(n.id);
          rows.push(`<div class="node${folder === n.id && !current ? " sel" : ""}" role="treeitem" tabindex="-1" aria-expanded="${open}" data-id="${n.id}" data-kind="folder" style="--depth:${depth}">${CHEV}<span class="ic" aria-hidden="true">${FOLDER_ICON}</span><span class="label">${esc(folderName(n))}</span><button type="button" class="more" data-more aria-label="Options for ${esc(folderName(n))}" tabindex="-1">${DOTS}</button></div>`);
          if (open) walk(n.id, depth + 1);
        } else {
          const { name } = naming(n);
          const only = n.space === "joint" && !n.household_id ? ` title="Only you can see this: you haven’t joined a household"` : "";
          rows.push(`<div class="node${current?.id === n.id ? " sel" : ""}" role="treeitem" tabindex="-1" data-id="${n.id}" data-kind="page" style="--depth:${depth}"${only}><span class="gap"></span><span class="ic" aria-hidden="true">${PAGE_ICON}</span><span class="label${name ? "" : " untitled"}">${esc(name || "Untitled")}</span></div>`);
        }
      }
    };
    walk(null, 0);
    if (!childrenOf(null).length) rows.push(`<p class="tree-empty">Nothing in ${esc(label)} yet. Tap + to start a note.</p>`);
    $("tree").innerHTML = rows.join("");
    // One row takes Tab; the arrow keys move between them.
    const first = $("tree").querySelector(".node.sel") || $("tree").querySelector(".node");
    if (first) first.tabIndex = 0;
    if (drag?.active) markDrag();
    // Browsing a space: it wears its look.
    if (!current && typeof showLook === "function") showLook();
  }

  function renderBin() {
    // A folder binned with what was in it shows once, as the folder.
    const binned = notes.filter(n => n.deleted_at && byId(n.parent_id)?.deleted_at !== n.deleted_at)
      .sort((a, b) => b.deleted_at.localeCompare(a.deleted_at));
    $("bin-list").innerHTML = binned.length ? binned.map(n => {
      const left = Math.max(1, BIN_DAYS - Math.floor((Date.now() - Date.parse(n.deleted_at)) / 864e5));
      const held = isFolder(n) ? group(n).length - 1 : 0;
      const name = isFolder(n) ? folderName(n) : naming(n).name || "Untitled";
      return `<div class="bin-item" data-id="${n.id}"><div class="what"><div class="name">${esc(name)}</div>
        <div class="sub">${isFolder(n) ? `folder${held ? `, ${held} inside` : ""} · ` : ""}${esc(SPACES.find(s => s.id === n.space)?.label || "")} · gone for good in ${left} day${left === 1 ? "" : "s"}</div></div>
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
    goTo(t.dataset.space, readJSON(FOLDER_KEY, {})[t.dataset.space]);
    renderList();
  });
  $("tree").addEventListener("click", (e) => {
    if (suppressClick) return;
    if (e.target.closest(".tree-head")) return;
    const node = e.target.closest(".node");
    // The line under today., or empty space below the notes: new notes go at the top.
    if (!node) { if (e.target.closest(".tree-line") || e.target === $("tree")) { goTo(space, null); renderList(); } return; }
    const id = node.dataset.id;
    if (node.dataset.kind === "daily") { openDay(today()); return; }
    // A pinned folder: shown open where it lives.
    if (node.hasAttribute("data-pinned") && node.dataset.kind === "folder") {
      goTo(space, id); setOpen(id, true); for (const f of pathTo(id)) setOpen(f.id, true);
      renderList(); focusRow(id); return;
    }
    if (e.target.closest("[data-more]")) { openFolderMenu(id, e.target.closest("[data-more]")); return; }
    if (node.dataset.kind === "folder") { setOpen(id, !opened.has(id)); goTo(space, id); renderList(); focusRow(id); }
    else openNote(id);
  });
  $("tree").addEventListener("keydown", (e) => {
    const node = e.target.closest(".node");
    if (!node || e.target.closest("[data-more]")) return;
    const all = [...$("tree").querySelectorAll(".node")];
    const i = all.indexOf(node), id = node.dataset.id, folderRow = node.dataset.kind === "folder";
    const go = (j) => { const n = all[Math.max(0, Math.min(all.length - 1, j))]; if (n) { node.tabIndex = -1; n.tabIndex = 0; n.focus(); } };
    if (e.key === "ArrowDown") go(i + 1);
    else if (e.key === "ArrowUp") go(i - 1);
    else if (e.key === "ArrowRight" && folderRow && !opened.has(id)) { setOpen(id, true); renderList(); focusRow(id); }
    else if (e.key === "ArrowLeft" && folderRow && opened.has(id)) { setOpen(id, false); renderList(); focusRow(id); }
    else if (e.key === "Enter" || e.key === " ") node.click();
    else return;
    e.preventDefault();
  });
  function focusRow(id) {
    const n = $("tree").querySelector(`.node[data-id="${id}"]:not([data-pinned])`);
    if (!n) return;
    for (const x of $("tree").querySelectorAll(".node")) x.tabIndex = -1;
    n.tabIndex = 0;
    n.focus({ preventScroll: true });
  }
  $("new-folder").addEventListener("click", () => newFolder());

  // ─── A folder's menu (its ⋯) ──────────────────────────────────────
  function openFolderMenu(id, from) {
    closeFolderMenu();
    const m = $("folder-menu");
    m.dataset.id = id;
    m.querySelector('[data-act="pin"]').textContent = byId(id)?.pinned ? "Unpin" : "Pin to the top";
    const r = from.getBoundingClientRect(), page = document.body.getBoundingClientRect();
    m.hidden = false;
    m.style.left = `${Math.max(8, Math.min(r.right - page.left - m.offsetWidth, page.width - m.offsetWidth - 8))}px`;
    m.style.top = `${r.bottom - page.top + 4}px`;
    from.closest(".node")?.classList.add("menu-open");
    m.querySelector("button").focus();
  }
  function closeFolderMenu() {
    $("folder-menu").hidden = true;
    for (const n of $("tree").querySelectorAll(".menu-open")) n.classList.remove("menu-open");
  }
  $("folder-menu").addEventListener("click", async (e) => {
    const act = e.target.closest("button[data-act]")?.dataset.act;
    const id = $("folder-menu").dataset.id;
    if (!act) return;
    closeFolderMenu();
    if (act === "note") { goTo(space, id); setOpen(id, true); newNote(); }
    else if (act === "folder") newFolder(id);
    else if (act === "pin") togglePin(id);
    else if (act === "rename") renameFolder(id);
    else if (act === "move") openMove(id);
    else deleteFolder(id);
  });
  document.addEventListener("pointerdown", (e) => {
    if (!$("folder-menu").hidden && !e.target.closest("#folder-menu, [data-more]")) closeFolderMenu();
  });

  // ─── Dragging into folders ────────────────────────────────────────
  // A row dragged onto a folder goes in it; onto the space's name, to its
  // top; onto another space's tab, to that space (held there, the tab opens).
  // With a mouse it starts after a few pixels; on a touch screen after a
  // press held still, so a swipe still scrolls.
  let drag = null, suppressClick = false;
  const tree = $("tree"), ghost = $("ghost");
  const atPoint = (x, y) => (root.elementFromPoint ? root.elementFromPoint(x, y) : null);
  // Where a drop would land: { el, mode }. On a row: its top quarter puts
  // it before, its bottom quarter after (a line shows), the middle of a
  // folder puts it inside. Also the space's name (the top), "Pinned" (pins
  // it) and a space's tab.
  function dropTarget(x, y) {
    const el = atPoint(x, y)?.closest?.(".node, .tree-head, .tree-line, .tab");
    if (!el) return null;
    if (el.classList.contains("tab")) return { el, mode: "space" };
    if (el.classList.contains("tree-line")) return { el, mode: "top" };
    if (el.classList.contains("tree-head")) return { el, mode: el.dataset.drop === "pin" ? "pin" : "top" };
    if (el.hasAttribute("data-pinned") || el.dataset.kind === "daily" || el.dataset.id === drag.id || drag.blocked.has(el.dataset.id)) return null;
    const r = el.getBoundingClientRect(), f = (y - r.top) / r.height;
    const isDir = el.dataset.kind === "folder";
    const mode = isDir ? (f < 0.25 ? "before" : f > 0.75 ? "after" : "into") : f < 0.5 ? "before" : "after";
    return { el, mode };
  }
  function showDrop(t) {
    for (const n of root.querySelectorAll(".drop, .drop-before, .drop-after")) n.classList.remove("drop", "drop-before", "drop-after");
    if (t) t.el.classList.add(t.mode === "before" ? "drop-before" : t.mode === "after" ? "drop-after" : "drop");
  }
  function markDrag() {
    tree.querySelector(`.node[data-id="${drag.id}"]`)?.classList.add("dragging");
    if (drag.over?.el.dataset.id) {
      const el = tree.querySelector(`.node[data-id="${drag.over.el.dataset.id}"]:not([data-pinned])`);
      drag.over = el ? { ...drag.over, el } : null;
    }
    showDrop(drag.over);
  }
  function startDrag() {
    if (!drag) return;
    const item = byId(drag.id);
    if (!item) { drag = null; return; }
    drag.active = true;
    drag.blocked = new Set(isFolder(item) ? [drag.id, ...descendants(drag.id)] : []);
    try { tree.setPointerCapture(drag.pointerId); } catch { /* pointer gone */ }
    ghost.textContent = nameOf(item);
    ghost.hidden = false;
    moveGhost(drag.x, drag.y);
    closeFolderMenu();
    markDrag();
  }
  function moveGhost(x, y) { ghost.style.left = `${x}px`; ghost.style.top = `${y}px`; }
  function endDrag() {
    if (!drag) return;
    clearTimeout(drag.timer); clearTimeout(drag.hold);
    try { tree.releasePointerCapture(drag.pointerId); } catch { /* not held */ }
    for (const n of root.querySelectorAll(".drop, .drop-before, .drop-after, .dragging")) n.classList.remove("drop", "drop-before", "drop-after", "dragging");
    ghost.hidden = true;
    drag = null;
  }
  tree.addEventListener("pointerdown", (e) => {
    const node = e.target.closest(".node");
    if (!node || !ready || e.button !== 0 || e.target.closest("[data-more]") || node.dataset.kind === "daily") return;
    drag = { id: node.dataset.id, x: e.clientX, y: e.clientY, pointerId: e.pointerId, touch: e.pointerType !== "mouse", active: false, over: null };
    if (drag.touch) drag.timer = setTimeout(startDrag, LONG_PRESS);
  });
  tree.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const moved = Math.hypot(e.clientX - drag.x, e.clientY - drag.y);
    if (!drag.active) {
      if (drag.touch) { if (moved > 8) endDrag(); return; }
      if (moved < 5) return;
      startDrag();
      if (!drag) return;
    }
    moveGhost(e.clientX, e.clientY);
    const t = dropTarget(e.clientX, e.clientY);
    if (t?.el === drag.over?.el && t?.mode === drag.over?.mode) return;
    const sameEl = t?.el === drag.over?.el;
    drag.over = t;
    showDrop(t);
    if (sameEl) return;
    clearTimeout(drag.hold);
    if (!t) return;
    // Held over a shut folder, it opens; over another space's tab, that space shows.
    drag.hold = setTimeout(() => {
      if (!drag?.active || drag.over?.el !== t.el) return;
      if (t.mode === "into" && !opened.has(t.el.dataset.id)) { setOpen(t.el.dataset.id, true); renderList(); }
      else if (t.mode === "space" && t.el.dataset.space !== space) { goTo(t.el.dataset.space, null); drag.over = null; renderList(); }
    }, 650);
  });
  tree.addEventListener("pointerup", (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const { active, id } = drag;
    const t = active ? dropTarget(e.clientX, e.clientY) : null;
    endDrag();
    if (!active) return;
    // The release isn't a click on the row it started on.
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 0);
    const item = byId(id);
    if (!t || !item) return;
    if (t.mode === "pin") { togglePin(id, true); return; }
    if (t.mode === "before" || t.mode === "after") {
      const target = byId(t.el.dataset.id);
      const parent = placeOf(target);
      const list = childrenOf(parent).filter(n => n.id !== id);
      const index = list.findIndex(n => n.id === target.id) + (t.mode === "after" ? 1 : 0);
      placeAt(id, parent, index);
      return;
    }
    const toSpace = t.mode === "space" ? t.el.dataset.space : space;
    const toParent = t.mode === "into" ? t.el.dataset.id : null;
    if (item.space !== toSpace || (placeOf(item) || null) !== toParent) moveItem(id, toSpace, toParent);
  });
  tree.addEventListener("pointercancel", endDrag);
  // Once a drag has started, the finger moves the row, not the page.
  tree.addEventListener("touchmove", (e) => { if (drag?.active) e.preventDefault(); }, { passive: false });
  tree.addEventListener("contextmenu", (e) => { if (drag) e.preventDefault(); });

  // ─── Spaces (the gear) ─────────────────────────────────────────────
  let draftSpaces = [];
  function drawSpaces() {
    $("space-rows").innerHTML = draftSpaces.map((x, i) => {
      const builtIn = BUILT_IN.some(b => b.id === x.id);
      const used = notes.some(n => n.space === x.id && !n.deleted_at);
      return `<div class="space-row" data-i="${i}"><input type="text" maxlength="30" value="${esc(x.label)}" aria-label="Name for ${esc(x.label)}">
        <span class="kind">${x.id === "joint" ? "shared" : "just you"}</span>
        ${builtIn ? "" : `<button type="button" class="small-btn danger" data-remove${used ? ` disabled title="Move or delete its notes first"` : ""}>Remove</button>`}</div>`;
    }).join("");
  }
  function openSpaces() {
    draftSpaces = SPACES.map(x => ({ ...x }));
    drawSpaces();
    $("spaces-dlg").showModal();
  }
  $("spaces-btn").addEventListener("click", openSpaces);
  $("spaces-cancel").addEventListener("click", () => $("spaces-dlg").close());
  $("space-rows").addEventListener("input", (e) => {
    const row = e.target.closest(".space-row");
    if (row) draftSpaces[Number(row.dataset.i)].label = e.target.value;
  });
  $("space-rows").addEventListener("click", (e) => {
    const b = e.target.closest("[data-remove]");
    if (!b || b.disabled) return;
    draftSpaces.splice(Number(b.closest(".space-row").dataset.i), 1);
    drawSpaces();
  });
  $("space-add").addEventListener("click", () => {
    draftSpaces.push({ id: `s${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`, label: "" });
    drawSpaces();
    $("space-rows").querySelector(".space-row:last-child input")?.focus();
  });
  $("spaces-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const list = draftSpaces.map(x => ({ id: x.id, label: String(x.label || "").trim() }))
      .filter(x => x.label || BUILT_IN.some(b => b.id === x.id))
      .map(x => ({ ...x, label: x.label || BUILT_IN.find(b => b.id === x.id).label }));
    $("spaces-dlg").close();
    useSpaces(list);
    renderList(); labelBack();
    saveState({ spaces: list });
  });
  // The same on every device: what's saved with the account, when it's there.
  supabase.from("app_state").select("data").eq("app", "notes").maybeSingle().then(({ data, error }) => {
    if (error || !data?.data) return;
    notesState = { ...data.data };
    writeJSON(STATE_KEY, notesState);
    if (notesState.spaces) { writeJSON(SPACES_KEY, notesState.spaces); useSpaces(notesState.spaces); }
    renderList(); labelBack(); showLook();
    if (!$("style-pop").hidden) paintStyle();
  });

  // ─── Folding the sidebar away (⌘S) ────────────────────────────────
  const wideScreen = matchMedia("(min-width: 900px)");
  function setSideOff(off) {
    $("shell").classList.toggle("side-off", off);
    writeJSON(SIDE_OFF_KEY, off);
  }
  setSideOff(Boolean(readJSON(SIDE_OFF_KEY, false)));
  function toggleSide() {
    // On a phone the list and the note take turns: ⌘S goes back to the list.
    if (!wideScreen.matches) { if (current) closeNote(); return; }
    setSideOff(!$("shell").classList.contains("side-off"));
  }
  $("side-hide").addEventListener("click", () => setSideOff(true));
  $("side-show").addEventListener("click", () => setSideOff(false));

  // ─── The sidebar's width ──────────────────────────────────────────
  function sideWidth(w, keep = false) {
    const width = Math.round(Math.max(200, Math.min(560, w)));
    $("shell").style.setProperty("--side-w", `${width}px`);
    if (keep) writeJSON(SIDE_KEY, width);
    return width;
  }
  sideWidth(readJSON(SIDE_KEY, SIDE_WIDTH));
  const resizer = $("resizer");
  resizer.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    resizer.setPointerCapture(e.pointerId);
    resizer.classList.add("on");
  });
  resizer.addEventListener("pointermove", (e) => {
    if (resizer.hasPointerCapture(e.pointerId)) sideWidth(e.clientX - $("shell").getBoundingClientRect().left);
  });
  const doneResizing = (e) => {
    if (!resizer.hasPointerCapture(e.pointerId)) return;
    resizer.releasePointerCapture(e.pointerId);
    resizer.classList.remove("on");
    sideWidth(e.clientX - $("shell").getBoundingClientRect().left, true);
  };
  resizer.addEventListener("pointerup", doneResizing);
  resizer.addEventListener("pointercancel", doneResizing);
  resizer.addEventListener("dblclick", () => sideWidth(SIDE_WIDTH, true));
  resizer.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    sideWidth(readJSON(SIDE_KEY, SIDE_WIDTH) + (e.key === "ArrowRight" ? 16 : -16), true);
  });

  $("move").addEventListener("click", () => { if (current) openMove(current.id); });
  $("pin").addEventListener("click", () => { if (current) togglePin(current.id); });
  $("day-prev").addEventListener("click", () => current?.day && openDay(shiftDay(current.day, -1)));
  $("day-next").addEventListener("click", () => current?.day && openDay(shiftDay(current.day, 1)));
  $("day-today").addEventListener("click", () => openDay(today()));
  $("day-input").addEventListener("change", () => { if (/^\d{4}-\d{2}-\d{2}$/.test($("day-input").value)) openDay($("day-input").value); });
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
    // ⌘N a new note, ⌘S the sidebar (Ctrl on Windows), even while typing.
    const mod = (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey;
    if (mod && (e.key === "n" || e.key === "N")) { e.preventDefault(); newNote(); return; }
    if (mod && (e.key === "s" || e.key === "S")) { e.preventDefault(); toggleSide(); return; }
    if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
    if (e.key === "Escape" && (drag || !$("folder-menu").hidden || !$("style-pop").hidden)) { e.preventDefault(); endDrag(); closeFolderMenu(); closeStyle(); return; }
    if ((e.key === "n" || e.key === "N") && !typing(e)) { e.preventDefault(); newNote(); }
    if ((e.key === "d" || e.key === "D") && !typing(e)) { e.preventDefault(); openDay(today()); }
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
  // …or at a day's note (#day=2026-10-12, or #today), from today.
  const linked = ctx.url.hash.slice(1);
  const day = linked === "today" ? today() : linked.match(/^day=(\d{4}-\d{2}-\d{2})$/)?.[1];
  if (/^[0-9a-f-]{36}$/i.test(linked) || day) {
    if (ctx.standalone) history.replaceState(null, "", location.pathname);
    if (day) openDay(day); else openNote(linked);
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
