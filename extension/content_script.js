// Phase 1 spike: prove a Manifest V3 content script can exchange
// window.postMessage traffic with the hosted robot app, using only the
// two hooks index.html already exposes. No background worker, no
// network activity — this file is the whole extension for now.

console.log("[proxie-bridge] content script loaded on", location.href);

// --- Test 1: browser -> extension --------------------------------------
// index.html calls window.postMessage({ type: "robot-state", ... }, "*")
// every animation frame (~60/sec). Content scripts execute in an
// "isolated world" (a separate JS heap from the page's own scripts) but
// they share the same window/browsing-context object as the page, so a
// plain addEventListener("message", ...) here does receive the page's
// broadcasts without any extra plumbing.
//
// The log below is throttled to ~4/sec purely to keep the console
// readable — the underlying messages still arrive at full frame rate,
// which is what "continuous" is being verified against here.
let lastLog = 0;
window.addEventListener("message", (event) => {
  if (event.source !== window || event.data?.type !== "robot-state") return;

  const now = performance.now();
  if (now - lastLog < 250) return;
  lastLog = now;

  const { x, z, rotationY } = event.data;
  console.log(
    `[proxie-bridge] robot-state x=${x.toFixed(2)} z=${z.toFixed(2)} rotationY=${rotationY.toFixed(3)}`
  );
});

// --- Test 2 & 3: extension -> browser, and the e.source check ----------
// index.html's own command listener is:
//   if (e.source !== window || e.data?.type !== "robot-command") return;
// It checks e.source, not e.origin. A content script's `window` is the
// same browsing-context window as the page (isolated worlds isolate JS
// state, not window/context identity), so window.postMessage(...) called
// from here is expected to satisfy e.source === window on the page's side.
//
// We can't instrument index.html directly to prove that without modifying
// the supplied file, so the proof here is behavioral: this sends a
// forward command with zero keyboard involvement. If the robot visibly
// moves forward on its own, the e.source check passed. If it were
// failing, this would be a silent no-op with no error either way — so
// "did the robot move" is the whole test.
console.log("[proxie-bridge] sending an automated forward command in 3s — keep hands off the keyboard");

setTimeout(() => {
  console.log("[proxie-bridge] TEST: posting robot-command forward=true");
  window.postMessage(
    { type: "robot-command", forward: true, back: false, left: false, right: false, run: false },
    "*"
  );

  setTimeout(() => {
    console.log("[proxie-bridge] TEST: posting robot-command forward=false (stop)");
    window.postMessage(
      { type: "robot-command", forward: false, back: false, left: false, right: false, run: false },
      "*"
    );
  }, 1500);
}, 3000);
