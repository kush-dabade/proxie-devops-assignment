// Phase 1 + Phase 2 + Phase 3: this content script bridges page <->
// extension. It never touches the network itself — background.js (the
// service worker) owns the WebSocket to Python. This file's only jobs are:
//   (a) receive robot-state from the page and hand it to the service worker
//   (b) receive robot-command from the service worker and post it into the page

console.log("[proxie-bridge] content script loaded on", location.href);

// --- (a) page -> service worker: robot-state ----------------------------
// index.html calls window.postMessage({ type: "robot-state", ... }, "*")
// every animation frame (~60/sec). Content scripts execute in an
// "isolated world" (a separate JS heap from the page's own scripts) but
// they share the same window/browsing-context object as the page, so a
// plain addEventListener("message", ...) here does receive the page's
// broadcasts without any extra plumbing.
let lastLog = 0;
let sendFailures = 0;
let lastSendFailureLog = 0;

// Shared by both the sync-throw and async-rejection failure paths below —
// same throttled reporting either way, just two different ways Chrome can
// signal "the service worker didn't get this."
function reportSendFailure() {
  sendFailures += 1;
  const t = performance.now();
  if (t - lastSendFailureLog >= 2000) {
    console.warn(
      `[proxie-bridge] chrome.runtime.sendMessage failing (${sendFailures} since last log) ` +
      `— if the extension was just reloaded, refresh this page to reconnect it`
    );
    sendFailures = 0;
    lastSendFailureLog = t;
  }
}

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
  try {
    // The service worker can be briefly unreachable right after an
    // extension reload/wake (or if it was discarded and is restarting)
    // — that surfaces as a rejected promise, handled by .catch below.
    //
    // A *reloaded* extension is different: this content script becomes
    // orphaned (its extension context is invalidated), and in that case
    // chrome.runtime.sendMessage throws synchronously instead of
    // returning a rejected promise. Without this try/catch that throw
    // would escape this listener as an uncaught exception on every
    // single animation frame until the page is reloaded. It doesn't
    // crash the page (each message-event listener invocation is
    // isolated by the browser), but it's console spam standing in for
    // what should be the same graceful "can't reach the bridge" report.
    chrome.runtime.sendMessage({ type: "robot-state", x, z, rotationY }).catch(reportSendFailure);
  } catch {
    reportSendFailure();
  }
});

// --- (b) service worker -> page: robot-command ---------------------------
// index.html's own command listener is:
//   if (e.source !== window || e.data?.type !== "robot-command") return;
// It checks e.source, not e.origin. A content script's `window` is the
// same browsing-context window as the page (isolated worlds isolate JS
// state, not window/context identity), so window.postMessage(...) called
// from here satisfies e.source === window on the page's side — this is
// the exact mechanism Phase 1 proved with a hardcoded test command; now
// the command comes from background.js (ultimately from Python) instead.
//
// background.js delivers commands here via chrome.tabs.sendMessage(tabId,
// ...), which a content script receives through the same onMessage API
// used for its own content-script -> background messages.
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "robot-command") return;
  console.log("[proxie-bridge] forwarding robot-command into page:", message);
  window.postMessage(message, "*");
});
