// ─── Switching a space between Craft/Todoist and lifeOS ──────────────
//
// For trying lifeOS's own tasks (shared/hubtasks.js) without giving up
// Craft or Todoist. Used by connections.
//
//   start(spaceId): copies the space's open tasks in (text, date, priority,
//     and a Todoist repeat), moves any calendar time blocks onto the copies,
//     and switches the space to lifeOS on every device.
//   stop(spaceId): switches back. The copies still open are deleted, and
//     their time blocks go back to the originals, which were never touched.
//     Tasks added or ticked during the trial were only in lifeOS: new ones
//     stay there (lifeOS tasks always show), and a ticked one is still open
//     in Craft or Todoist.
//
// The connection stays saved throughout; nothing is changed in Craft or Todoist.

import * as hub from "./hubtasks.js?v=5";
import * as todoist from "./todoist.js?v=19";
import { parseRepeat, withAnchor } from "./repeat.js?v=1";

const read = (k) => { try { return JSON.parse(localStorage.getItem(k) || "{}"); } catch { return {}; } };
const cleanKey = (k) => String(k || "").replace(/[\s ​-‍﻿]/g, "");

function craftCaller(spaceId) {
  const s = read("tasks.settings").spaces?.[spaceId] || {};
  const m = String(s.url || "").match(/connect\.craft\.do\/links\/[^/?#\s]+/i);
  const base = m ? `https://${m[0]}/api/v1` : String(s.url || "").replace(/\/+$/, "");
  const headers = { Accept: "application/json", ...(cleanKey(s.key) ? { Authorization: `Bearer ${cleanKey(s.key)}` } : {}) };
  return async (path) => {
    const res = await fetch(`${base}${path}`, { headers });
    if (!res.ok) throw Object.assign(new Error(`Craft ${res.status}`), { status: res.status });
    return res.json();
  };
}

// The space's open tasks, read the way tasks. and calendar. read them:
// { id, text, date, priority, repeatText, recurring }.
async function openTasks(spaceId) {
  if (spaceId === "todoist") {
    todoist.setToken(read("tasks.settings").todoist?.token);
    return todoist.loadTasks(await todoist.loadProjects());
  }
  const craft = craftCaller(spaceId);
  const [lists, all, trash, templates, lights] = await Promise.all([
    Promise.all(["active", "upcoming", "inbox"].map(scope => craft(`/tasks?scope=${scope}`))),
    craft("/tasks?scope=all").catch(() => ({ items: [] })),
    craft("/documents?location=trash").catch(() => ({ items: [] })),
    craft("/documents?location=templates").catch(() => ({ items: [] })),
    hub.loadCraftPriorities().catch(() => new Map()),
  ]);
  // Undated tasks inside documents only show in "all"; trash and templates are left out.
  const skip = new Set([...(trash.items || []), ...(templates.items || [])].map(d => d.id));
  const undated = (all.items || []).filter(i => i.location?.type === "document" && !skip.has(i.location.documentId));
  const found = new Map();
  for (const item of [...lists.flatMap(l => l.items || []), ...undated]) {
    if (item.taskInfo?.state !== "todo" || found.has(item.id)) continue;
    found.set(item.id, {
      id: item.id,
      text: (item.markdown || "").replace(/^\s*[-*]\s*\[[ x]\]\s*/, "").trim() || "(no text)",
      date: item.taskInfo?.scheduleDate?.slice(0, 10) || null,
      priority: lights.get(hub.craftKey(spaceId, item.id)) || 0,
      recurring: Boolean(item.repeat || item.taskInfo?.repeat),
      repeatText: "",
    });
  }
  return [...found.values()];
}

// Time blocks are calendar events tagged with their task's ID; moving a
// task from one ID to another re-tags them. Skipped without Google.
async function retag(pairs) {
  if (!pairs.length) return;
  try {
    const gcal = await import("/taskhub/calendar.js?v=trial1");
    if (!gcal.isConnected()) return;
    const blocks = await gcal.loadBlocks();
    await Promise.all(pairs.map(([from, to]) => blocks.get(String(from)) && gcal.retagBlock(blocks.get(String(from)), to)));
  } catch (err) { console.error("Moving time blocks:", err); }
}

// Resolves { copied, repeatsLost }: repeatsLost counts Craft repeating
// tasks, whose rule Craft's API doesn't give (they come over as one-offs).
export async function start(spaceId) {
  const state = await hub.trialState();
  if (state.lifeos.includes(spaceId)) return { copied: 0, repeatsLost: 0 };
  const tasks = await openTasks(spaceId);
  const rows = tasks.map(t => {
    const rule = t.repeatText ? parseRepeat(t.repeatText).repeat : null;
    return { text: t.text, date: t.date, spaceId, priority: t.priority || 0, repeat: rule ? withAnchor(rule, t.date).rule : null };
  });
  const made = await hub.addTasks(rows);
  const copies = made.map((m, i) => ({ id: m.id, from: tasks[i].id }));
  await hub.saveTrialState({ ...state, lifeos: [...state.lifeos, spaceId], copies: { ...state.copies, [spaceId]: copies } });
  await retag(copies.map(c => [c.from, c.id]));
  // Craft gives no rule, and a Todoist one in words lifeOS doesn't read comes over as a one-off.
  return { copied: made.length, repeatsLost: rows.filter((r, i) => tasks[i].recurring && !r.repeat).length };
}

export async function stop(spaceId) {
  const state = await hub.trialState();
  const copies = state.copies?.[spaceId] || [];
  await hub.deleteOpen(copies.map(c => c.id));
  const rest = { ...state.copies };
  delete rest[spaceId];
  await hub.saveTrialState({ ...state, lifeos: state.lifeos.filter(x => x !== spaceId), copies: rest });
  await retag(copies.map(c => [c.id, c.from]));
}
