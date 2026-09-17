// Phase 2: service worker owns the WebSocket to the local Python bridge.
// The hosted page never opens a socket, and the content script never
// touches the network — only this file does. It receives robot-state
// from the content script via chrome.runtime messaging and forwards it.

const WS_URL = "ws://127.0.0.1:8765";
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 10000;

let socket = null;
let reconnectAttempt = 0;
let reconnectTimer = null;
let droppedSinceLastLog = 0;
let lastDropLog = 0;

function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return; // already connecting/connected — don't stack sockets
  }

  console.log("[proxie-bridge/sw] connecting to", WS_URL);
  socket = new WebSocket(WS_URL);

  socket.addEventListener("open", () => {
    console.log("[proxie-bridge/sw] connected");
    reconnectAttempt = 0; // reset backoff once a connection actually succeeds
  });

  socket.addEventListener("close", (event) => {
    console.log(`[proxie-bridge/sw] disconnected (code=${event.code})`);
    socket = null;
    scheduleReconnect();
  });

  socket.addEventListener("error", () => {
    // "close" fires right after "error" for a failed/dropped connection,
    // so reconnect scheduling happens there — this is just a log line.
    console.log("[proxie-bridge/sw] socket error");
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return; // a retry is already pending, don't stack timers
  const delay = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempt, RECONNECT_MAX_MS);
  reconnectAttempt += 1;
  console.log(`[proxie-bridge/sw] retrying in ${delay}ms`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function forwardState(payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    // Python isn't connected right now — drop the frame rather than
    // buffering (this is a live telemetry stream, not a queue that
    // needs to catch up later). Log a periodic summary, not per drop,
    // since drops happen at up to 60/sec while disconnected.
    droppedSinceLastLog += 1;
    const now = Date.now();
    if (now - lastDropLog > 2000) {
      console.log(`[proxie-bridge/sw] no connection — dropped ${droppedSinceLastLog} state message(s)`);
      droppedSinceLastLog = 0;
      lastDropLog = now;
    }
    return;
  }
  socket.send(JSON.stringify(payload));
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "robot-state") return;
  forwardState(message);
});

// Runs both on a fresh install/enable and every time the service worker
// is woken up after being fully terminated (MV3 tears down and re-runs
// this whole script on wake, so there is no stale `socket` to reuse here
// — this call is always starting from a clean slate).
connect();
