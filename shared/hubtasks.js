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

const TABLE = "hub_tasks";
const COLUMNS = "id,space,text,date,household_id,created_at";
// The apps call the joint. space "todoist" (parse.js), from when only Todoist had it.
const toDb = (spaceId) => (spaceId === "todoist" ? "joint" : spaceId);
const fromDb = (space) => (space === "joint" ? "todoist" : space);

// Where a space's new tasks go on this device: "craft", "todoist" or "lifeos".
export function sourceOf(settings, spaceId) {
  if (spaceId === "todoist") return String(settings?.todoist?.token || "").trim() ? "todoist" : "lifeos";
  return settings?.spaces?.[spaceId]?.url ? "craft" : "lifeos";
}

const toTask = (r) => ({
  id: r.id,
  text: r.text,
  date: r.date,
  recurring: false,
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

// [{ text, date, spaceId }] → the new tasks, in the same order.
export async function addTasks(list) {
  if (!list.length) return [];
  const shareWith = list.some(t => t.spaceId === "todoist") ? await householdId() : null;
  const rows = list.map(t => ({
    text: t.text.trim(),
    date: t.date || null,
    space: toDb(t.spaceId),
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
export const reopenTask = (id) => update(id, { done_at: null });
// Takes one ID or a list, so "move all to tomorrow" is one request.
export const rescheduleTask = (ids, date) => update(ids, { date });
export const renameTask = (id, text) => update(id, { text });
export const deleteTask = async (id) => check(await supabase.from(TABLE).delete().eq("id", id));

// How many were ticked off between two Dates (for week.).
export async function countDone(from, to) {
  const { count, error } = await supabase.from(TABLE).select("id", { count: "exact", head: true })
    .gte("done_at", from.toISOString()).lt("done_at", to.toISOString());
  if (error) throw new Error(error.message);
  return count || 0;
}
