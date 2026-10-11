// Planning a meal from the add-anything box (capture.js): "chilli Tuesday
// dinner", "Oscar pancakes tomorrow breakfast", "fajitas tonight",
// "meal: takeaway Friday". A line is a meal when it names a day and a meal
// and the rest is one of food.'s recipes, or when it starts "meal:" or
// "plan:" (then anything else is a note on the plan, as food. allows).
// Who it's for follows food.'s planner tabs: someone named in the line, or
// else the shared tab (everyone without a tab of their own).
import { supabase } from "./auth.js";

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const fold = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
const cap = (s) => s ? s[0].toUpperCase() + s.slice(1) : s;
const EXPLICIT = /^(?:meal|plan)\s*[:\-–]\s*/i;
// Slot words, longest first; "tea" and "supper" are dinner.
const SLOTS = [
  [/\b(?:morning\s+snack)\b/i, "Snack 1"], [/\b(?:afternoon\s+snack)\b/i, "Snack 2"], [/\b(?:evening\s+snack)\b/i, "Snack 3"],
  [/\bbreakfast\b/i, "Breakfast"], [/\blunch\b/i, "Lunch"], [/\b(?:dinner|tea|supper)\b/i, "Dinner"], [/\bsnack\b/i, "Snack 2"],
];
const today = () => DAYS[(new Date().getDay() + 6) % 7];
const STOP = new Set(["for", "on", "at", "the", "a", "an", "with", "have", "having", "make", "making", "cook", "next", "this"]);
// food.'s rule (foodhub/app/page.jsx hasOwnTab): own tab, or the old per-slot setting.
const hasOwnTab = (p) => p.tab ? p.tab === "own" : (p.own || []).length > 0;

export function mealPlanner() {
  const s = { household: null, recipes: [], people: [] };
  s.load = async (household) => {
    s.household = household;
    const [r, p] = await Promise.all([
      supabase.from("recipes").select("id, name, servings").eq("household_id", household),
      supabase.from("household_settings").select("value, id").eq("household_id", household).eq("key", "people").order("id", { ascending: false }).limit(1),
    ]);
    if (r.error) throw r.error;
    if (p.error) throw p.error;
    s.recipes = r.data.map(x => ({ ...x, f: fold(x.name) }));
    s.people = (Array.isArray(p.data?.[0]?.value) ? p.data[0].value : []).filter(x => x?.id && x?.name);
  };

  // The recipe a few words mean: every word in its name, or most of them.
  const has = (r, w) => r.f.includes(w) || (w.length > 3 && r.f.includes(w.replace(/(?:es|s)$/, "")));
  const recipeFor = (words) => {
    if (!words.length) return null;
    const all = s.recipes.filter(r => words.every(w => has(r, w)));
    if (all.length) return all.sort((a, b) => a.name.length - b.name.length)[0];
    let best = null, score = 0;
    for (const r of s.recipes) {
      const n = words.filter(w => has(r, w)).length / words.length;
      if (n > score) { score = n; best = r; }
    }
    return score >= 0.6 ? best : null;
  };

  // What a line means as a meal, or null. `forced`: the line was sent to the
  // meal plan by hand, so take it whatever it says.
  s.read = (raw, forced = false) => {
    let t = String(raw).trim();
    const explicit = EXPLICIT.test(t) || forced;
    t = t.replace(EXPLICIT, "");
    let meal = null, day = null;
    for (const [re, slot] of SLOTS) if (re.test(t)) { meal = slot; t = t.replace(re, " "); break; }
    if (/\btonight\b/i.test(t)) { day = today(); meal ||= "Dinner"; t = t.replace(/\btonight\b/i, " "); }
    const dm = t.match(/\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
    if (dm) {
      const w = dm[1].toLowerCase();
      day = w === "today" ? today() : w === "tomorrow" ? DAYS[(DAYS.indexOf(today()) + 1) % 7] : cap(w);
      t = t.replace(dm[0], " ");
    }
    // People named in the line.
    const who = [];
    for (const p of s.people) {
      const re = new RegExp(`\\b(?:for\\s+)?${p.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:'s)?\\b`, "i");
      if (re.test(t)) { who.push(p.id); t = t.replace(re, " "); }
    }
    const words = fold(t).replace(/[^a-z0-9&' ]/g, " ").split(/\s+/).filter(w => w && !STOP.has(w));
    const recipe = recipeFor(words);
    if (!explicit && !(meal && day && recipe)) return null;
    const text = cap(t.replace(/\s+/g, " ").replace(/^[\s,:\-–]+|[\s,:\-–]+$/g, "").replace(/^(?:for|on)\s+|\s+(?:for|on)$/gi, ""));
    if (!recipe && !text) return null;
    // Nobody named: the shared tab when someone has their own, else everyone.
    const shared = s.people.some(hasOwnTab) ? s.people.filter(p => !hasOwnTab(p)).map(p => p.id) : [];
    const people = who.length ? who : shared;
    return {
      day: day || today(), meal: meal || "Dinner", recipe, note: recipe ? null : text,
      people: people.length && people.length < s.people.length ? people : null,
    };
  };
  s.names = (ids) => ids ? ids.map(id => s.people.find(p => p.id === id)?.name).filter(Boolean).join(", ") : "everyone";

  // Onto the plan; returns { undo } or { already: true }.
  s.add = async (m) => {
    if (m.recipe) {
      const { data: there, error: e1 } = await supabase.from("meal_plan").select("id").eq("household_id", s.household).eq("day", m.day).eq("meal", m.meal).eq("recipe_id", m.recipe.id).limit(1);
      if (e1) throw e1;
      if (there.length) return { already: true };
    }
    const servings = s.people.length ? (m.people ? m.people.length : s.people.length) : (m.recipe?.servings || 1);
    const row = m.recipe
      ? { household_id: s.household, day: m.day, meal: m.meal, recipe_id: m.recipe.id, servings, people: m.people }
      : { id: crypto.randomUUID(), household_id: s.household, day: m.day, meal: m.meal, recipe_id: null, note: m.note, people: m.people };
    const { data, error } = await supabase.from("meal_plan").insert(row).select("id").single();
    if (error) throw error;
    return { undo: async () => { const r = await supabase.from("meal_plan").delete().eq("id", data.id); if (r.error) throw r.error; } };
  };
  return s;
}
