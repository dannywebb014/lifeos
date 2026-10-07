// ─── Repeating tasks ─────────────────────────────────────────────────
//
// A repeat is a small rule kept with a task kept in lifeOS (hub_tasks.repeat):
//   { every, unit, days?, monthDay?, nth?, weekday?, anchor, text }
//   - every: how many units between (1 = every, 2 = every other …)
//   - unit: "day" | "week" | "month" | "year"
//   - days: ISO weekdays for a weekly repeat (1 Monday … 7 Sunday)
//   - monthDay: day of the month (−1 = the last day)
//   - nth + weekday: "the first Monday" (nth 1–4, or −1 for the last)
//   - anchor: the first date, YYYY-MM-DD; "every 2 weeks" counts from it
//   - text: the words it was made from, for Todoist and for showing
//
// parseRepeat() reads one from what was said or typed; nextDate() gives the
// date after a given one; describe() puts a rule back into words. Nothing here
// touches the network, so it can be tested in Node.

const DAY_NAMES = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const DAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// "mon", "monday", "mondays", "tues", "thurs" …
const DAY = "(?:mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)s?";
const DAY_LIST = `${DAY}(?:\\s*(?:,|and|&|\\+)\\s*${DAY})*`;
const NUM = { other: 2, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12 };
const NTH = { first: 1, "1st": 1, second: 2, "2nd": 2, third: 3, "3rd": 3, fourth: 4, "4th": 4, last: -1 };
const UNIT = { day: "day", days: "day", week: "week", weeks: "week", month: "month", months: "month", year: "year", years: "year" };

const pad = (n) => String(n).padStart(2, "0");
export const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromIso = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const isoDay = (d) => ((d.getDay() + 6) % 7) + 1;   // 1 Monday … 7 Sunday
const dayOf = (word) => DAY_NAMES.findIndex(n => n.startsWith(word.toLowerCase().slice(0, 3))) + 1;
const daysIn = (list) => [...new Set(list.split(/\s*(?:,|and|&|\+)\s*/i).map(dayOf).filter(Boolean))].sort();
const count = (w) => (/^\d+$/.test(w) ? Number(w) : NUM[w.toLowerCase()] || 1);
const lastOfMonth = (y, m) => new Date(y, m + 1, 0).getDate();

// Each pattern turns a phrase into the parts of a rule. Longer phrases come
// first, so "every 2 weeks on Tue and Thu" isn't read as "every … Tue".
const PATTERNS = [
  // the first Monday of the month, every last Friday, last Friday of every month
  [new RegExp(`\\b(?:(?:every|each|on)\\s+(?:the\\s+)?)?(first|1st|second|2nd|third|3rd|fourth|4th|last)\\s+(${DAY})(?:\\s+(?:of|in)\\s+(?:the|every|each)\\s+month)?\\b`, "i"),
    (m, all) => (/^(?:every|each|on)\b/i.test(all) || /month/i.test(all)) && { every: 1, unit: "month", nth: NTH[m[1].toLowerCase()], weekday: dayOf(m[2]) }],
  // the last day of the month
  [/\b(?:(?:on|every)\s+)?(?:the\s+)?last\s+day\s+of\s+(?:the|every|each)\s+month\b/i, () => ({ every: 1, unit: "month", monthDay: -1 })],
  // every 2 weeks on Tue and Thu, every other week on Monday
  [new RegExp(`\\bevery\\s+(\\d+|other|two|three|four)\\s+weeks?\\s+on\\s+(${DAY_LIST})\\b`, "i"),
    (m) => ({ every: count(m[1]), unit: "week", days: daysIn(m[2]) })],
  // every 3 days, every other month, every 2 years
  [/\bevery\s+(\d+|other|two|three|four|five|six|seven|eight|nine|ten|twelve)\s+(days?|weeks?|months?|years?)\b/i,
    (m) => ({ every: count(m[1]), unit: UNIT[m[2].toLowerCase()] })],
  // every weekday, on weekdays
  [/\b(?:every\s+week\s*day|every\s+weekdays?|on\s+weekdays)\b/i, () => ({ every: 1, unit: "week", days: [1, 2, 3, 4, 5] })],
  [/\b(?:every\s+weekend|on\s+weekends)\b/i, () => ({ every: 1, unit: "week", days: [6, 7] })],
  // every Monday, each Tue and Thu, on Mondays (plural only: "on Tues" is one day)
  [new RegExp(`\\b(?:every|each)\\s+(${DAY_LIST})\\b`, "i"), (m) => ({ every: 1, unit: "week", days: daysIn(m[1]) })],
  [new RegExp(`\\bon\\s+(${DAY_LIST})\\b`, "i"), (m) => /days\b/i.test(m[1]) && { every: 1, unit: "week", days: daysIn(m[1]) }],
  // monthly on the 15th, every month on the 1st, the 15th of every month
  [/\b(?:monthly|every\s+month)\s+on\s+the\s+(\d{1,2})(?:st|nd|rd|th)?\b/i, (m) => ({ every: 1, unit: "month", monthDay: Math.min(31, Number(m[1])) })],
  [/\b(?:on\s+)?the\s+(\d{1,2})(?:st|nd|rd|th)?\s+of\s+(?:every|each)\s+month\b/i, (m) => ({ every: 1, unit: "month", monthDay: Math.min(31, Number(m[1])) })],
  [/\b(?:every\s*day|daily|each\s+day)\b/i, () => ({ every: 1, unit: "day" })],
  [/\b(?:every\s+fortnight|fortnightly)\b/i, () => ({ every: 2, unit: "week" })],
  [/\b(?:every\s+week|weekly)\b/i, () => ({ every: 1, unit: "week" })],
  [/\b(?:every\s+month|monthly)\b/i, () => ({ every: 1, unit: "month" })],
  [/\b(?:every\s+year|yearly|annually)\b/i, () => ({ every: 1, unit: "year" })],
];

// Takes a repeat out of a task's words. { text, repeat } where repeat is null
// when none was said; its anchor is filled in by withAnchor() once the
// task's first date is known.
export function parseRepeat(input) {
  const text = String(input ?? "");
  for (const [re, build] of PATTERNS) {
    const m = text.match(re);
    if (!m) continue;
    const rule = build(m, m[0]);
    if (!rule) continue;
    const said = m[0].trim();
    const rest = (text.slice(0, m.index) + " " + text.slice(m.index + m[0].length)).replace(/\s{2,}/g, " ").trim();
    return { text: rest, repeat: { ...rule, text: said.replace(/^on\s+(?=\w+s\b)/i, "every ").toLowerCase() } };
  }
  return { text, repeat: null };
}

// Does this date fit the rule's pattern (ignoring how many units apart)?
function fits(rule, d) {
  if (rule.unit === "day") return true;
  if (rule.unit === "week") return (rule.days?.length ? rule.days : [isoDay(fromIso(rule.anchor))]).includes(isoDay(d));
  if (rule.unit === "month") return monthFits(rule, d);
  const a = fromIso(rule.anchor);
  return d.getMonth() === a.getMonth() && d.getDate() === Math.min(a.getDate(), lastOfMonth(d.getFullYear(), d.getMonth()));
}
function monthFits(rule, d) {
  const y = d.getFullYear(), m = d.getMonth(), last = lastOfMonth(y, m);
  if (rule.nth) {
    if (isoDay(d) !== rule.weekday) return false;
    return rule.nth === -1 ? d.getDate() + 7 > last : Math.ceil(d.getDate() / 7) === rule.nth;
  }
  const want = rule.monthDay === -1 ? last : Math.min(rule.monthDay || fromIso(rule.anchor).getDate(), last);
  return d.getDate() === want;
}
// Is this date the right number of units from the anchor?
function inStep(rule, d) {
  const n = rule.every || 1;
  if (n === 1) return true;
  const a = fromIso(rule.anchor);
  if (rule.unit === "day") return Math.round((d - a) / 86400000) % n === 0;
  if (rule.unit === "week") {
    const monday = (x) => addDays(x, 1 - isoDay(x));
    return Math.round((monday(d) - monday(a)) / (7 * 86400000)) % n === 0;
  }
  const months = (d.getFullYear() - a.getFullYear()) * 12 + d.getMonth() - a.getMonth();
  return rule.unit === "month" ? ((months % n) + n) % n === 0 : (((d.getFullYear() - a.getFullYear()) % n) + n) % n === 0;
}
const matches = (rule, d) => fits(rule, d) && inStep(rule, d) && iso(d) >= rule.anchor;

// The first date on or after `from` (YYYY-MM-DD) that the rule lands on.
export function firstOnOrAfter(rule, from) {
  let d = fromIso(from);
  // Two years covers every rule here, even "every 12 months on the 31st".
  for (let i = 0; i < 800; i++, d = addDays(d, 1)) if (matches(rule, d)) return iso(d);
  return null;
}
// The rule's next date after `after`.
export const nextAfter = (rule, after) => firstOnOrAfter(rule, iso(addDays(fromIso(after), 1)));

// A rule with its anchor set: the task's date if it fits, otherwise the first
// date from then (or from today) that does.
export function withAnchor(rule, date, today = iso(new Date())) {
  const start = date || today;
  const draft = { ...rule, anchor: start };
  const first = firstOnOrAfter(draft, start);
  return { rule: { ...rule, anchor: first || start }, date: first || start };
}

// Where a repeating task goes when ticked off: its next date after the one it
// had, and never today or earlier, so an overdue one catches up.
export function nextDue(rule, date, today = iso(new Date())) {
  let next = nextAfter(rule, date || today);
  while (next && next <= today) next = nextAfter(rule, next);
  return next;
}

const ordinal = (n) => `${n}${[, "st", "nd", "rd"][n % 100 > 10 && n % 100 < 14 ? 0 : n % 10] || "th"}`;
const dayList = (days) => days.length > 1 ? `${days.slice(0, -1).map(d => DAY_SHORT[d - 1]).join(", ")} and ${DAY_SHORT[days.at(-1) - 1]}` : DAY_NAMES[days[0] - 1].replace(/^./, c => c.toUpperCase());

// "Every Monday", "Weekdays", "Every 2 weeks on Tue and Thu", "First Monday of the month" …
export function describe(rule) {
  if (!rule) return "";
  const n = rule.every || 1;
  const every = n === 1 ? "Every" : n === 2 ? "Every other" : `Every ${n}`;
  const plural = (u) => (n > 2 ? `${u}s` : u);
  if (rule.unit === "day") return n === 1 ? "Every day" : `${every} ${plural("day")}`;
  if (rule.unit === "week") {
    const days = rule.days?.length ? rule.days : rule.anchor ? [isoDay(fromIso(rule.anchor))] : [];
    if (n === 1 && days.join() === "1,2,3,4,5") return "Weekdays";
    if (n === 1 && days.join() === "6,7") return "Weekends";
    if (!days.length) return n === 1 ? "Every week" : n === 2 ? "Every fortnight" : `${every} weeks`;
    return n === 1 ? `Every ${dayList(days)}` : `${every} ${plural("week")} on ${dayList(days)}`;
  }
  if (rule.unit === "month") {
    const which = rule.nth ? `the ${rule.nth === -1 ? "last" : ["first", "second", "third", "fourth"][rule.nth - 1]} ${DAY_NAMES[rule.weekday - 1].replace(/^./, c => c.toUpperCase())}`
      : rule.monthDay === -1 ? "the last day" : `the ${ordinal(rule.monthDay || (rule.anchor ? fromIso(rule.anchor).getDate() : 1))}`;
    return n === 1 ? `Monthly on ${which}` : `${every} ${plural("month")} on ${which}`;
  }
  const a = rule.anchor ? fromIso(rule.anchor) : null;
  const on = a ? ` on ${a.getDate()} ${MONTHS[a.getMonth()]}` : "";
  return n === 1 ? `Yearly${on}` : `${every} ${plural("year")}${on}`;
}
