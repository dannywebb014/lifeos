// ─── Problem reports ─────────────────────────────────────────────────
//
// Keeps a record of what goes wrong in the apps, in Supabase (client_errors,
// sql/client-errors.sql, kept 30 days), so a problem can be looked into
// afterwards instead of guessed at:
//   - crashes ("error") and promises that fail with nothing catching them
//   - anything an app logs with console.error (Craft unreachable, a save
//     that failed …): the apps already log every failure that way
//   - every trip to the sign-in page, with the reason (auth.js)
//
//   import { install } from "/lifeos/shared/report.js";
//   const report = install({ supabase, app: "food" });   // once per page
//   report.signedOut("why");
//
// Each problem waits in this browser ("hub.errors.queue") until it can be
// sent with a two-factor sign-in, so ones from before signing in arrive after.
// The same problem from the same app is recorded once every 10 minutes, and
// a page sends at most 30, so a loop can't flood the table. Only the page's
// path is kept, never its query or hash (which can hold sign-in tokens).

const QUEUE = "hub.errors.queue";
const SEEN = "hub.errors.seen";
const QUIET_MS = 10 * 60e3;
const PER_PAGE = 30;
const KEEP = 40;

const read = (k, fallback) => { try { return JSON.parse(localStorage.getItem(k)) ?? fallback; } catch { return fallback; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full or blocked */ } };
const appName = () => location.pathname.split("/").filter(Boolean).slice(0, 2).filter(s => !s.includes(".")).join("/") || "site";
const aal = (token) => {
  try { return JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).aal; } catch { return null; }
};
// Not worth recording: browser noise, and a script from another site that
// the browser won't describe.
const NOISE = /ResizeObserver loop|^Script error\.?$|^Load failed$|AbortError/i;

const words = (x) => {
  if (x instanceof Error) return `${x.name !== "Error" ? `${x.name}: ` : ""}${x.message}`;
  if (typeof x === "string") return x;
  try { return JSON.stringify(x); } catch { return String(x); }
};

export function install({ supabase, app = appName() } = {}) {
  if (globalThis.__hubReport) return globalThis.__hubReport;
  let sent = 0, timer = null, flushing = false;

  function add(kind, message, detail = "") {
    message = String(message || "").trim().slice(0, 1000);
    if (!message || NOISE.test(message) || sent >= PER_PAGE) return;
    const key = `${app}|${kind}|${message}`;
    const now = Date.now();
    const seen = Object.fromEntries(Object.entries(read(SEEN, {})).filter(([, t]) => now - t < QUIET_MS));
    if (seen[key]) return;
    seen[key] = now;
    write(SEEN, seen);
    sent++;
    const q = read(QUEUE, []);
    q.push({
      app, kind, message,
      page: location.pathname.slice(0, 300),
      // File positions without their ?query (a page's can hold tokens).
      detail: String(detail || "").replace(/\?[^\s:)#]*(?=:\d)/g, "").slice(0, 4000) || null,
      happened: new Date(now).toISOString(),
      online: navigator.onLine,
      agent: navigator.userAgent.slice(0, 300),
    });
    write(QUEUE, q.slice(-KEEP));
    clearTimeout(timer);
    timer = setTimeout(flush, 3000);
  }

  async function flush() {
    if (flushing || !supabase) return;
    const q = read(QUEUE, []);
    if (!q.length) return;
    flushing = true;
    try {
      const { data: { session } } = await supabase.auth.getSession();
      // Only a two-factor sign-in can write; until then they wait here.
      if (!session || aal(session.access_token) !== "aal2") return;
      const batch = q.slice(0, 20);
      const { error } = await supabase.from("client_errors").insert(batch);
      if (error) return;           // kept for next time; not logged, or it would report itself
      write(QUEUE, read(QUEUE, []).slice(batch.length));
      if (read(QUEUE, []).length) { clearTimeout(timer); timer = setTimeout(flush, 3000); }
    } catch { /* offline: next time */ } finally { flushing = false; }
  }

  addEventListener("error", (e) => {
    add("error", e.message, `${e.filename || ""}:${e.lineno || 0}:${e.colno || 0}\n${e.error?.stack || ""}`);
  });
  addEventListener("unhandledrejection", (e) => {
    add("rejection", words(e.reason), e.reason?.stack || "");
  });
  const original = console.error.bind(console);
  console.error = (...args) => {
    original(...args);
    try { add("logged", args.map(words).join(" "), args.find(a => a instanceof Error)?.stack || ""); } catch { /* never let reporting break the page */ }
  };
  addEventListener("online", () => flush());
  // Anything waiting from before (another page, or before signing in).
  setTimeout(flush, 4000);

  return (globalThis.__hubReport = {
    signedOut: (reason) => add("signed-out", reason || "unknown", `from ${location.pathname}`),
    add, flush,
  });
}
