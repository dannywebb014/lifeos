// ─── Todoist ─────────────────────────────────────────────────────────
//
// The shared lists with people who don't use Craft. Todoist's v1 API
// allows browser requests, so this talks to it directly with a personal
// API token, the same way the Craft connections work.
//
// Active tasks are fetched whole and sorted here rather than asking the
// API to filter, which keeps this working whatever its filter syntax does.

const API = "https://api.todoist.com/api/v1";
export const DEFAULT_PROJECT = "Joint Reminders";

let token = "";
// Copying a token on a phone often brings invisible characters with it — a
// non-breaking space, a zero-width space, a stray newline — and a header
// cannot carry those, so the request fails before it is sent. A token has no
// spaces in it, so everything space-like is simply removed.
export const setToken = (value) => {
  token = String(value || "").replace(/[\s\u00A0\u200B-\u200D\uFEFF]/g, "");
};
export const hasToken = () => Boolean(token);
// Headers are Latin-1 only; anything outside it would throw inside fetch.
const oddCharacter = () => /[^\x20-\x7E]/.test(token);

async function call(path, options = {}) {
  if (oddCharacter()) {
    throw new Error("That token has an unusual character in it. Copy it from Todoist again, or type it by hand.");
  }
  const resp = await fetch(API + path, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...options.headers },
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    const err = new Error(resp.status === 401 || resp.status === 403
      ? "Todoist didn’t accept that API token."
      : `${resp.status} ${body.slice(0, 120)}`);
    err.status = resp.status;
    throw err;
  }
  return resp.status === 204 ? null : resp.json();
}

// v1 pages its lists; older shapes return a plain array, so handle both.
async function all(path) {
  const out = [];
  let cursor = null;
  do {
    const query = `limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const page = await call(`${path}${path.includes("?") ? "&" : "?"}${query}`);
    out.push(...(Array.isArray(page) ? page : page.results || []));
    cursor = Array.isArray(page) ? null : page.next_cursor || null;
  } while (cursor && out.length < 1000);
  return out;
}

export const loadProjects = () => all("/projects");

export async function loadTasks(projects) {
  const names = new Map(projects.map(p => [String(p.id), p.name]));
  const tasks = await all("/tasks");
  return tasks
    .filter(t => !(t.checked ?? t.is_completed))
    .map(t => ({
      id: String(t.id),
      text: t.content || "",
      // A due date can carry a time; only the day matters here.
      date: (t.due?.date || "").slice(0, 10) || null,
      recurring: Boolean(t.due?.is_recurring),
      // Kept whole so a recurring task can be moved without losing its rule.
      due: t.due || null,
      spaceId: "todoist",
      where: { key: `p:${t.project_id}`, label: names.get(String(t.project_id)) || "Todoist", rank: 2, projectId: String(t.project_id) },
    }));
}

export const closeTask = (id) => call(`/tasks/${id}/close`, { method: "POST" });

// A plain due_date replaces the whole due object, which wipes a recurring
// task's rule ("every Monday"). For those, send the full due object through
// /sync instead: the new date plus the original rule string, which moves this
// occurrence and keeps the series. Any time of day is carried over too.
export async function rescheduleTask(task, date) {
  const due = task.due;
  if (!due?.is_recurring) {
    return call(`/tasks/${task.id}`, { method: "POST", body: JSON.stringify({ due_date: date }) });
  }
  const time = String(due.date || "").slice(10); // "" or "T09:00:00" / "T09:00:00Z"
  const next = { ...due, date: date + time };
  const uuid = crypto.randomUUID();
  const result = await call("/sync", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      commands: JSON.stringify([{ type: "item_update", uuid, args: { id: task.id, due: next } }]),
    }),
  });
  const status = result?.sync_status?.[uuid];
  if (status !== "ok") throw new Error(status?.error || "Todoist didn’t accept the new date.");
  task.due = next;
}

// Moving to another project goes through /sync, where item_move is a
// long-standing command; the task keeps its date, repeat and everything else.
export async function moveTask(id, projectId) {
  const uuid = crypto.randomUUID();
  const result = await call("/sync", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      commands: JSON.stringify([{ type: "item_move", uuid, args: { id, project_id: projectId } }]),
    }),
  });
  const status = result?.sync_status?.[uuid];
  if (status !== "ok") throw new Error(status?.error || "Todoist didn’t move it.");
}

export const renameTask = (id, text) =>
  call(`/tasks/${id}`, { method: "POST", body: JSON.stringify({ content: text }) });

export const addTask = ({ text, date, projectId }) =>
  call("/tasks", {
    method: "POST",
    body: JSON.stringify({ content: text, ...(date ? { due_date: date } : {}), ...(projectId ? { project_id: projectId } : {}) }),
  });

// "joint, house fix the gate" → the House project, task "Fix the gate".
// Without a project name it falls back to the shared list.
export function pickProject(text, projects) {
  const cleaned = String(text || "").trim();
  const match = projects
    .filter(p => !p.inbox_project && !p.inboxProject)
    .map(p => ({ project: p, re: new RegExp(`^${p.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b[\\s,:;.\\-–—]*`, "i") }))
    .map(({ project, re }) => ({ project, hit: cleaned.match(re) }))
    .filter(x => x.hit)
    .sort((a, b) => b.hit[0].length - a.hit[0].length)[0];
  const rest = match ? cleaned.slice(match.hit[0].length).trim() : cleaned;
  const project = match?.project || projects.find(p => p.name === DEFAULT_PROJECT) || null;
  const tidied = rest ? rest[0].toUpperCase() + rest.slice(1) : cleaned;
  return { project, text: match ? tidied : cleaned };
}
