// ─── Tasks kept in lifeOS itself ─────────────────────────────────────
//
// For anyone not using Craft or Todoist: tasks live in Supabase (table
// hub_tasks, see sql/tasks.sql), so they follow the sign-in to every device.
// A space with a Craft connection (my space., work.) or a Todoist token
// (joint.) saved on this device still sends new tasks there; every other
// space keeps them here. Tasks already here always show, whatever is set up.
//
// joint. tasks are shared with the food. household: everyone who has joined
// it sees them. Without a household they stay private.
//
// Task objects have the same shape the apps use for Craft and Todoist ones:
// { id, text, date, recurring, spaceId, where }, plus builtin: true.

import { supabase } from "/lifeos/auth.js";
import { nextDue, describe, withAnchor } from "./repeat.js?v=1";

const TABLE = "hub_tasks";
const COLUMNS = "id,space,text,date,priority,repeat,household_id,created_at";
// The apps call the joint. space "todoist" (parse.js), from when only Todoist had it.
const toDb = (spaceId) => (spaceId === "todoist" ? "joint" : spaceId);
const fromDb = (space) => (space === "joint" ? "todoist" : space);

// ─── Trying lifeOS tasks in place of Craft or Todoist ────────────────
// A space can be switched to lifeOS while its Craft or Todoist connection
// stays saved (connections., shared/tasktrial.js). The switch is kept with
// the account (app_state "tasks": { lifeos: [space ids], copies }) so every
// device agrees, and a copy on this device ("tasks.lifeos") lets the apps
// read it without waiting. While on, the apps treat that space as having no
// connection: nothing is read from or sent to Craft or Todoist for it.
const MODE_KEY = "tasks.lifeos";
export function lifeosSpaces() {
  try { const v = JSON.parse(localStorage.getItem(MODE_KEY) || "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
}
export const inLifeosMode = (spaceId) => lifeosSpaces().includes(spaceId);
const keepMode = (ids) => { try { localStorage.setItem(MODE_KEY, JSON.stringify(ids)); } catch { /* private mode */ } };

// The task settings as the apps should use them: a space trying lifeOS
// loses its connection here (the saved one is untouched).
export function effective(settings) {
  const on = lifeosSpaces();
  if (!on.length) return settings || {};
  const s = { ...(settings || {}), spaces: { ...(settings?.spaces || {}) } };
  for (const id of on) { if (id === "todoist") s.todoist = {}; else delete s.spaces[id]; }
  return s;
}

export async function trialState() {
  const { data, error } = await supabase.from("app_state").select("data").eq("app", "tasks").maybeSingle();
  if (error) throw new Error(error.message);
  return { lifeos: [], copies: {}, ...(data?.data || {}) };
}
export async function saveTrialState(state) {
  check(await supabase.from("app_state").upsert({ app: "tasks", data: state, updated_at: new Date().toISOString() }, { onConflict: "user_id,app" }));
  keepMode(state.lifeos);
}
// Brings this device's copy of the switch up to date. True if it changed.
export async function syncMode() {
  try {
    const { lifeos } = await trialState();
    const before = JSON.stringify(lifeosSpaces());
    keepMode(lifeos);
    return before !== JSON.stringify(lifeos);
  } catch (err) { console.warn("Task trial setting:", err.message); return false; }
}
// Copies made when a space switched over, deleted again if it switches back.
export async function deleteOpen(ids) {
  if (ids.length) check(await supabase.from(TABLE).delete().in("id", ids).is("done_at", null));
}

// Where a space's new tasks go on this device: "craft", "todoist" or "lifeos".
export function sourceOf(settings, spaceId) {
  if (inLifeosMode(spaceId)) return "lifeos";
  if (spaceId === "todoist") return String(settings?.todoist?.token || "").trim() ? "todoist" : "lifeos";
  return settings?.spaces?.[spaceId]?.url ? "craft" : "lifeos";
}

const toTask = (r) => ({
  id: r.id,
  text: r.text,
  date: r.date,
  recurring: Boolean(r.repeat),
  repeat: r.repeat || null,
  repeatText: describe(r.repeat),
  priority: r.priority || 0,
  spaceId: fromDb(r.space),
  builtin: true,
  shared: Boolean(r.household_id),
  where: { key: "lifeos", label: r.household_id ? "shared" : "lifeOS", rank: 0 },
});

// Supabase answers with a plain object; the apps expect an Error with a message.
const check = ({ data, error }) => {
  if (error) throw Object.assign(new Error(error.message || "Couldn’t reach lifeOS"), { status: error.code });
  return data;
};

// The food. household joint. tasks are shared with, or null. Looked up once.
let household = null;
export function householdId() {
  household ||= (async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return null;
    const row = check(await supabase.from("profiles").select("household_id").eq("id", session.user.id).maybeSingle());
    return row?.household_id ? String(row.household_id) : null;
  })().catch((err) => { household = null; throw err; });
  return household;
}

// Every open task: your own, and joint. ones shared with your household.
export async function loadTasks() {
  return check(await supabase.from(TABLE).select(COLUMNS).is("done_at", null).order("created_at")).map(toTask);
}

// [{ text, date, spaceId, priority?, repeat? }] → the new tasks, in the same order.
export async function addTasks(list) {
  if (!list.length) return [];
  const shareWith = list.some(t => t.spaceId === "todoist") ? await householdId() : null;
  const rows = list.map(t => ({
    text: t.text.trim(),
    date: t.date || null,
    space: toDb(t.spaceId),
    priority: t.priority || 0,
    repeat: t.repeat || null,
    household_id: t.spaceId === "todoist" ? shareWith : null,
  }));
  return check(await supabase.from(TABLE).insert(rows).select(COLUMNS)).map(toTask);
}

// Row-level security hides a task that isn't yours instead of refusing, so
// changing nothing counts as a failure.
async function update(ids, values) {
  const rows = check(await supabase.from(TABLE).update(values).in("id", [].concat(ids)).select("id"));
  if (!rows.length) throw new Error("That task isn’t there any more. Refresh to see the latest.");
  return rows;
}

export const closeTask = (id) => update(id, { done_at: new Date().toISOString() });

// Ticking off: a repeating task moves to its next date and stays open; any
// other closes. Every tick is logged (hub_task_done) for week.'s count.
// Resolves { next, logId }: next is the new date, or null when it closed.
export async function completeTask(task) {
  const next = task.repeat ? nextDue(task.repeat, task.date) : null;
  if (next) await update(task.id, { date: next });
  else await update(task.id, { done_at: new Date().toISOString() });
  const { data: { session } } = await supabase.auth.getSession();
  const { data, error } = await supabase.from("hub_task_done")
    .insert({ task_id: task.id, user_id: session?.user?.id, household_id: task.shared ? await householdId() : null })
    .select("id").single();
  if (error) console.error("Logging the tick failed:", error.message);
  return { next, logId: data?.id || null };
}

// Undo for completeTask: back to the date it had (a repeating one) or open
// again, and the tick taken out of the log.
export async function undoComplete(task, { prevDate, next, logId }) {
  if (next) await update(task.id, { date: prevDate });
  else await update(task.id, { done_at: null });
  if (logId) await supabase.from("hub_task_done").delete().eq("id", logId);
}

// The signed-in person's ID, for keeping a copy of their list on this device.
export async function userId() {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.user?.id || null;
}

// A repeat set or changed on a task (null stops it). Its anchor is the task's
// date, or the first day it lands on from today; resolves the task's date then.
export async function setRepeat(task, rule) {
  if (!rule) { await update(task.id, { repeat: null }); return { date: task.date, repeat: null }; }
  const { rule: anchored, date } = withAnchor(rule, task.date);
  await update(task.id, { repeat: anchored, date });
  return { date, repeat: anchored };
}

// Into another space: my space., work. or joint. (shared with the household).
export async function moveSpace(task, spaceId) {
  const household = spaceId === "todoist" ? await householdId() : null;
  await update(task.id, { space: toDb(spaceId), household_id: household });
  return { shared: Boolean(household) };
}
export const reopenTask = (id) => update(id, { done_at: null });
// Takes one ID or a list, so "move all to tomorrow" is one request.
export const rescheduleTask = (ids, date) => update(ids, { date });
export const renameTask = (id, text) => update(id, { text });
export const setPriority = (id, priority) => update(id, { priority });
export const deleteTask = async (id) => check(await supabase.from(TABLE).delete().eq("id", id));

// ─── Priority for Craft tasks ────────────────────────────────────────
// Priority is the traffic light: 0 none, 1 low (green), 2 medium (amber),
// 3 high (red). Tasks here carry it themselves and Todoist has its own, but
// Craft has none, so a Craft task's light is kept in lifeOS (task_priorities,
// sql/task-priority.sql), private to whoever set it.
export const craftKey = (spaceId, id) => `craft:${spaceId}:${id}`;

// Map of craftKey → priority, for every Craft task given one.
export async function loadCraftPriorities() {
  const rows = check(await supabase.from("task_priorities").select("task_key,priority"));
  return new Map(rows.map(r => [r.task_key, r.priority]));
}

export async function setCraftPriority(spaceId, id, priority) {
  const key = craftKey(spaceId, id);
  if (!priority) return check(await supabase.from("task_priorities").delete().eq("task_key", key));
  const { data: { session } } = await supabase.auth.getSession();
  return check(await supabase.from("task_priorities")
    .upsert({ user_id: session?.user?.id, task_key: key, priority, updated_at: new Date().toISOString() }, { onConflict: "user_id,task_key" }));
}

// How many ticks between two Dates (for week.), repeating tasks included.
export async function countDone(from, to) {
  const { count, error } = await supabase.from("hub_task_done").select("id", { count: "exact", head: true })
    .gte("done_at", from.toISOString()).lt("done_at", to.toISOString());
  if (error) throw new Error(error.message);
  return count || 0;
}
