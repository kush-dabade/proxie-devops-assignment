// Phase 1 + Phase 2: this content script bridges page <-> extension.
// It never touches the network itself — background.js (the service
// worker) owns the WebSocket to Python. This file's only jobs are:
// (a) receive robot-state from the page and hand it to the service
// worker, and (b) receive commands from the extension and post them
// into the page (Phase 3 will use (b); Phase 1's test of it stays below).

console.log("[proxie-bridge] content script loaded on", location.href);

// --- Test 1 (Phase 1) + Phase 2 forwarding ------------------------------
// index.html calls window.postMessage({ type: "robot-state", ... }, "*")
// every animation frame (~60/sec). Content scripts execute in an
// "isolated world" (a separate JS heap from the page's own scripts) but
// they share the same window/browsing-context object as the page, so a
// plain addEventListener("message", ...) here does receive the page's
// broadcasts without any extra plumbing.
let lastLog = 0;
let sendFailures = 0;
let lastSendFailureLog = 0;

window.addEventListener("message", (event) => {
  if (event.source !== window || event.data?.type !== "robot-state") return;

  const { x, z, rotationY } = event.data;

  // Human-readable console output stays throttled to ~4/sec — this is
  // for a person watching DevTools, it does not gate the bridge itself.
  const now = performance.now();
  if (now - lastLog >= 250) {
    lastLog = now;
    console.log(`[proxie-bridge] robot-state x=${x.toFixed(2)} z=${z.toFixed(2)} rotationY=${rotationY.toFixed(3)}`);
  }

  // The actual bridge forward is NOT throttled. index.html emits state
  // once per animation frame, and Phase 2's whole point is preserving
  // that full-rate stream end to end, not a sampled/throttled version.
  chrome.runtime.sendMessage({ type: "robot-state", x, z, rotationY }).catch(() => {
    // The service worker can be briefly unreachable right after an
    // extension reload/wake (or if it was discarded and is restarting).
    // Don't spam the console per dropped frame — surface it as a
    // periodic count instead.
    sendFailures += 1;
    const t = performance.now();
    if (t - lastSendFailureLog >= 2000) {
      console.warn(`[proxie-bridge] chrome.runtime.sendMessage failing (${sendFailures} since last log)`);
      sendFailures = 0;
      lastSendFailureLog = t;
    }
  });
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
