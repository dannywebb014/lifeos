// ─── Pull down to refresh ────────────────────────────────────────────
//
// For touch screens: pulling down from the top of a list shows a small pill
// ("Pull to refresh", then "Release to refresh") and, past the mark, runs
// refresh(). Used by tasks. and calendar.
//
//   pullToRefresh({ refresh: () => load(), scroller: (target) => element, enabled: () => true });
//
// `scroller(target)` gives the scrolling box the touch started in (or null to
// ignore it); a pull only counts when that box is already at its top.

const CSS = `
  .ptr-pill { position:fixed; left:50%; top:calc(8px + env(safe-area-inset-top)); z-index:60; pointer-events:none;
    transform:translate(-50%, calc(var(--ptr, 0px) - 60px)); opacity:0; transition:opacity .15s;
    padding:7px 14px; border-radius:16px; font:600 13px/1.2 var(--hub-body, system-ui, sans-serif);
    background:var(--card, #fff); color:var(--muted, #6b6055); border:1px solid var(--line, var(--border, #ddd8cc));
    box-shadow:0 4px 14px rgba(0,0,0,.12); white-space:nowrap; }
  .ptr-pill.on { opacity:1; }
  .ptr-pill.ready { color:var(--accent-text, var(--accent, #2f8a84)); }
`;

const MARK = 80;   // how far (in px of finger travel) counts as a pull

export function pullToRefresh({ refresh, scroller = () => document.scrollingElement, enabled = () => true }) {
  if (!("ontouchstart" in window)) return;
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.append(style);
  const pill = document.createElement("div");
  pill.className = "ptr-pill";
  pill.setAttribute("aria-hidden", "true");
  document.body.append(pill);

  let start = null, box = null, pulling = false, dy = 0, busy = false;
  const reset = () => {
    start = null; pulling = false; dy = 0;
    if (!busy) { pill.classList.remove("on", "ready"); pill.style.setProperty("--ptr", "0px"); }
  };

  addEventListener("touchstart", (e) => {
    if (busy || e.touches.length !== 1 || !enabled()) return;
    // The element really touched, even inside an app's shadow root.
    box = scroller(e.composedPath()[0] || e.target);
    if (!box || box.scrollTop > 0) return;
    start = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  }, { passive: true });

  addEventListener("touchmove", (e) => {
    if (!start) return;
    // Something else took the touch over meanwhile (a drag that started after a hold).
    if (!enabled()) { reset(); return; }
    const t = e.touches[0];
    dy = t.clientY - start.y;
    const dx = Math.abs(t.clientX - start.x);
    if (!pulling) {
      // Only a mostly-downward drag from the very top; anything else is
      // scrolling or a swipe, and is left alone.
      if (dy > 12 && dy > dx * 1.5 && box.scrollTop <= 0) pulling = true;
      else if (dy < -4 || dx > 12) { reset(); return; }
      else return;
    }
    pill.style.setProperty("--ptr", `${Math.min(dy * 0.6, 70)}px`);
    pill.classList.add("on");
    pill.classList.toggle("ready", dy > MARK);
    pill.textContent = dy > MARK ? "Release to refresh" : "Pull to refresh";
  }, { passive: true });

  addEventListener("touchend", async () => {
    if (!pulling || dy <= MARK) { reset(); return; }
    busy = true;
    pill.textContent = "Refreshing…";
    pill.style.setProperty("--ptr", "50px");
    try { await refresh(); } catch (err) { console.error("Refresh failed:", err); }
    busy = false;
    reset();
  });
  addEventListener("touchcancel", reset);
}
