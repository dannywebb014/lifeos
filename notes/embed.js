// notes.: pages, daily notes and tasks written in notes (see the "notes. —
// scope" doc). Runs inside lifeOS or on its own page (index.html), through
// /lifeos/embed.js.
//
// Stage 0, for now: a test of the editor inside lifeOS's shadow root on
// iPhone Safari. The note is kept on this device only (localStorage
// "notes.test"); "Send results" writes the checks to client_errors through
// shared/report.js's console.error, so they can be read back.
import { Editor, StarterKit, TaskList, TaskItem, Placeholder } from "/lifeos/vendor/tiptap-3.31.3.js";
import { fill, docFor } from "/lifeos/embed.js";

const KEY = "notes.test";
const CHECKS = [
  { id: "typing", what: "Type a few sentences quickly", how: "Letters stay in order, nothing goes missing, the cursor stays where you're typing." },
  { id: "autocorrect", what: "Let autocorrect fix a word, and tap a suggestion above the keyboard", how: "The fixed word replaces the old one; no doubled words." },
  { id: "dictation", what: "Dictate a sentence with the microphone on the keyboard", how: "The words land where the cursor is." },
  { id: "checklist", what: "Make a checklist, tick a box, press return for a new line", how: "The box ticks and the keyboard stays up; return gives a new box; return on an empty one ends the list." },
  { id: "select", what: "Select some words, make them bold, then move the cursor by holding the space bar", how: "Selection handles appear and the right words go bold." },
  { id: "paste", what: "Copy something from Notes or Safari and paste it in, then undo", how: "It pastes as text with its lines kept; undo takes it back out." },
];

export async function mount(ctx) {
  const { root, asset } = ctx;
  await fill(root, { css: asset("./app.css"), html: asset("./app.html") });
  const document = docFor(ctx);
  const $ = (id) => document.getElementById(id);

  function toast(msg, err = false) {
    const t = document.createElement("div");
    t.className = `toast${err ? " err" : ""}`; t.textContent = msg; t.setAttribute("role", "status");
    document.body.append(t);
    setTimeout(() => t.remove(), err ? 6000 : 2200);
  }
  const read = () => { try { return JSON.parse(localStorage.getItem(KEY) || "{}") || {}; } catch { return {}; } };
  const keep = (patch) => { try { localStorage.setItem(KEY, JSON.stringify({ ...read(), ...patch })); } catch { /* private mode */ } };

  // ─── The editor ───────────────────────────────────────────────────
  let saveTimer = 0;
  const editor = new Editor({
    element: $("editor"),
    // TipTap would add its stylesheet to the main page, where it can't reach
    // this shadow root; app.css has the rules it needs.
    injectCSS: false,
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] }, link: { openOnClick: false, autolink: true } }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Placeholder.configure({ placeholder: "Write something…" }),
    ],
    content: read().doc || "",
    editorProps: { attributes: { "aria-label": "Note", autocapitalize: "sentences", spellcheck: "true" } },
    onUpdate: () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => keep({ doc: editor.getJSON() }), 500);
    },
    onTransaction: () => paintToolbar(),
  });

  // ─── The formatting bar ───────────────────────────────────────────
  const chain = () => editor.chain().focus();
  const COMMANDS = {
    h1: { run: () => chain().toggleHeading({ level: 1 }).run(), on: () => editor.isActive("heading", { level: 1 }) },
    h2: { run: () => chain().toggleHeading({ level: 2 }).run(), on: () => editor.isActive("heading", { level: 2 }) },
    bold: { run: () => chain().toggleBold().run(), on: () => editor.isActive("bold") },
    italic: { run: () => chain().toggleItalic().run(), on: () => editor.isActive("italic") },
    bullets: { run: () => chain().toggleBulletList().run(), on: () => editor.isActive("bulletList") },
    numbers: { run: () => chain().toggleOrderedList().run(), on: () => editor.isActive("orderedList") },
    checks: { run: () => chain().toggleTaskList().run(), on: () => editor.isActive("taskList") },
    quote: { run: () => chain().toggleBlockquote().run(), on: () => editor.isActive("blockquote") },
    code: { run: () => chain().toggleCodeBlock().run(), on: () => editor.isActive("codeBlock") },
    undo: { run: () => chain().undo().run(), can: () => editor.can().undo() },
    redo: { run: () => chain().redo().run(), can: () => editor.can().redo() },
  };
  function paintToolbar() {
    for (const b of $("toolbar").querySelectorAll("button[data-cmd]")) {
      const c = COMMANDS[b.dataset.cmd];
      if (c.on) b.setAttribute("aria-pressed", String(c.on()));
      if (c.can) b.disabled = !c.can();
    }
  }
  // Pressing a button mustn't take the focus (and the iPhone keyboard) away
  // from the note, so the press is stopped and the command runs on release.
  $("toolbar").addEventListener("pointerdown", (e) => { if (e.target.closest("button")) e.preventDefault(); });
  $("toolbar").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-cmd]");
    if (b) COMMANDS[b.dataset.cmd].run();
  });
  paintToolbar();

  // ─── The checks ───────────────────────────────────────────────────
  const verdicts = read().verdicts || {};
  $("check-list").innerHTML = CHECKS.map(c => `<li data-id="${c.id}"><span class="what">${c.what}</span><span class="how">${c.how}</span>
    <span class="verdict" role="group" aria-label="${c.what}"><button type="button" data-v="ok" aria-pressed="${verdicts[c.id] === "ok"}">Worked</button><button type="button" data-v="bad" aria-pressed="${verdicts[c.id] === "bad"}">Problem</button></span></li>`).join("");
  $("check-list").addEventListener("click", (e) => {
    const b = e.target.closest(".verdict button");
    if (!b) return;
    const id = b.closest("li").dataset.id;
    verdicts[id] = verdicts[id] === b.dataset.v ? undefined : b.dataset.v;
    for (const x of b.parentElement.children) x.setAttribute("aria-pressed", String(verdicts[id] === x.dataset.v));
    keep({ verdicts });
  });
  $("check-note").value = read().note || "";
  $("check-note").addEventListener("input", () => keep({ note: $("check-note").value }));

  $("send").addEventListener("click", () => {
    const line = CHECKS.map(c => `${c.id}=${verdicts[c.id] || "-"}`).join(" ");
    const ua = navigator.userAgent.match(/(iPhone|iPad|Macintosh)[^)]*\)|Version\/[\d.]+/g)?.join(" ") || navigator.userAgent;
    // console.error is what shared/report.js records (client_errors).
    console.error(`notes. stage 0 result: ${line} | ${$("check-note").value.trim() || "no note"} | ${ctx.standalone ? "own page" : "in lifeOS"} | ${ua}`.slice(0, 990));
    toast("Sent. Thank you!");
  });
  $("clear").addEventListener("click", () => {
    editor.commands.clearContent(true);
    keep({ doc: null });
  });

  return {
    unmount() { clearTimeout(saveTimer); keep({ doc: editor.getJSON() }); editor.destroy(); document.off(); },
  };
}
