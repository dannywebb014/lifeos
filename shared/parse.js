// ─── Turning dictated text into tasks ────────────────────────────────
//
// Input is whatever iOS dictation produced, e.g.
//   "Work. Send Sam the invoice on Friday. Chase the quote. My space, book
//    the dentist tomorrow."
// Output is one task per sentence, each with a workspace and an optional
// schedule date. Nothing here talks to Craft, so it can be tested in Node.
//
// Rules, in order:
//   - Each sentence (or line) is one task.
//   - Each sentence (or line) is one task. "My space" in the middle of a
//     sentence also starts a new task, since dictation often runs tasks
//     together without a full stop.
//   - A sentence that starts with a workspace name ("Work check emails",
//     "My space, book the dentist", "Work.") switches workspace for it and
//     every task after it, until another one is named. Dictation rarely
//     puts a comma after it, so none is needed.
//   - "Work on / out / through ..." still switches to Work, but keeps the
//     words as the task, since there "work" is part of what to do.
//   - A task ending in "for work" / "in my space" goes there on its own,
//     without changing the workspace of the tasks after it.
//   - The first date phrase in a task becomes its schedule date and is
//     removed from the text.
//   - A time in it ("tomorrow at 3pm", "3pm") becomes the task's time, which
//     blocks it out on the calendar. A time alone means today, or tomorrow
//     once it has passed. "For 30 minutes" / "for an hour" after a time sets
//     how long; without a time it is left in the task.
//   - "High priority" (or "urgent", "red priority", "priority 1") makes it
//     red; "medium" / "amber" amber; "low" / "green" green. The words go.

export const SPACES = [
  { id: "my", label: "my space.", pattern: "my\\s*space|personal" },
  { id: "work", label: "work.", pattern: "work" },
  // Shared lists in Todoist, for people who don't use Craft.
  { id: "todoist", label: "joint.", pattern: "joint|shared" },
];

const spaceFor = (word) => {
  const w = word.toLowerCase();
  return SPACES.find(s => new RegExp(`^(?:${s.pattern})$`, "i").test(w))?.id;
};

const ANY_SPACE = SPACES.map(s => s.pattern).join("|");
const PREP = "(?:in|for|to|into|on)\\s+";
// "Work check emails", "Work, ...", "In my space: ...", "Work task ...", "Work."
const LEAD = new RegExp(`^(?:${PREP})?(${ANY_SPACE})\\b(?:\\s+(?:tasks?|space)\\b)?[\\s,:;.\\-–—]*`, "i");
// After a leading "work", these mean "work" is the task's own verb.
const WORK_AS_VERB = /^(?:on|out|through)\b/i;
// "... my space buy milk": a new task starts at "my space" unless it is the
// end of "for my space" / "in my space".
const MID_SPLIT = /(?<!\b(?:in|for|to|into|on))\s+(?=my\s*space\b)/i;
// "... for work", "... in my space"
const TRAIL = new RegExp(`[\\s,]*\\b${PREP}(${ANY_SPACE})\\s*$`, "i");

const isoDate = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const tidy = (s) => {
  const t = s
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s,;:.\-–—]+|[\s,;:.\-–—]+$/g, "")
    .trim();
  return t ? t[0].toUpperCase() + t.slice(1) : "";
};

// Pull the first date phrase out of a task. Words that only make sense
// attached to the date ("on", "by", "for") go with it.
// "for 45 mins", "for an hour", "for 1.5 hours", "for half an hour"
const LENGTH = /[\s,]*\bfor\s+(half\s+an?|an?|\d+(?:\.\d+)?)\s*(minutes?|mins?|hours?|hrs?|h)\b/i;

function takeLength(text) {
  const m = text.match(LENGTH);
  if (!m) return { text, minutes: null };
  const n = /^half/i.test(m[1]) ? 0.5 : /^an?$/i.test(m[1]) ? 1 : Number(m[1]);
  const minutes = Math.round(/^h/i.test(m[2]) ? n * 60 : n);
  if (!minutes || minutes > 24 * 60) return { text, minutes: null };
  return { text: text.slice(0, m.index) + text.slice(m.index + m[0].length), minutes };
}

const hhmm = (d) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

// The traffic light: 3 high (red), 2 medium (amber), 1 low (green), 0 none.
const PRIORITY_WORDS = [
  [3, "high|top|urgent|red", "high|one|1"],
  [2, "medium|med|mid|normal|amber|yellow|orange", "medium|two|2"],
  [1, "low|green", "low|three|3"],
];
const LINK = "(?:[\\s,\\-–—]*(?:as|with|at|is)\\s+(?:a\\s+)?)?";
export function takePriority(text) {
  for (const [level, before, after] of PRIORITY_WORDS) {
    const re = new RegExp(`${LINK}[\\s,\\-–—]*\\b(?:(?:${before})\\s+priority|priority\\s*(?:${after}))\\b`, "i");
    const m = text.match(re);
    if (m) return { text: text.slice(0, m.index) + text.slice(m.index + m[0].length), priority: level };
  }
  // "Urgent" on its own, at the start or the end.
  const m = text.match(/^\s*urgent(?:ly)?\b[\s,:\-–—]*|[\s,\-–—]+urgent(?:ly)?\s*$/i);
  if (m) return { text: text.slice(0, m.index) + text.slice(m.index + m[0].length), priority: 3 };
  return { text, priority: 0 };
}

// chrono reads "for 30 mins" as "30 minutes from now", so a length is taken
// out before it looks, and only kept as a length when a time was said.
function takeDate(full, chrono, now) {
  const { text, minutes: length } = takeLength(full);
  const [hit] = chrono.en.GB.parse(text, now, { forwardDate: true });
  if (!hit) return { text: full, date: null, time: null, minutes: null };
  const when = hit.start.date();
  const date = isoDate(when);
  // Only a time actually said counts: "tomorrow" alone also carries an hour.
  const time = hit.start.isCertain("hour") ? hhmm(when) : null;
  const after = text.slice(hit.index + hit.text.length);
  // "Thursday's meeting" — the date is part of the wording, so keep it.
  if (/^['’]s\b/.test(after)) return { text: full, date, time: null, minutes: null };
  const before = text.slice(0, hit.index).replace(/\b(?:on|by|for|from|due|this|at)\s*$/i, "");
  const rest = `${before} ${after}`;
  if (time) return { text: rest, date, time, minutes: length };
  return { text: length ? `${rest} ${full.match(LENGTH)[0].trim()}` : rest, date, time, minutes: null };
}

export function parseTasks(input, chrono, { now = new Date(), defaultSpace = SPACES[0].id } = {}) {
  const sentences = String(input ?? "")
    .split(/\n+|(?<=[.!?])\s+/)
    .flatMap(s => s.split(MID_SPLIT))
    .map(s => s.trim())
    .filter(Boolean);

  let current = defaultSpace;
  const tasks = [];
  for (let s of sentences) {
    s = s.replace(/[.!?]+$/, "");
    const lead = s.match(LEAD);
    if (lead) {
      current = spaceFor(lead[1]);
      const rest = s.slice(lead[0].length);
      const bare = !/[,:;.\-–—]/.test(lead[0]) && !/\btasks?\b/i.test(lead[0]);
      if (!(current === "work" && bare && WORK_AS_VERB.test(rest))) s = rest;
    }
    let space = current;
    const trail = s.match(TRAIL);
    if (trail && trail.index > 0) {
      space = spaceFor(trail[1]);
      s = s.slice(0, trail.index);
    }
    const { text: plain, priority } = takePriority(s);
    const { text, date, time, minutes } = takeDate(plain, chrono, now);
    const clean = tidy(text);
    if (clean) tasks.push({ text: clean, space, date, time, minutes, priority });
  }
  return tasks;
}
