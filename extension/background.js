// Phase 2 + Phase 3: service worker owns the WebSocket to the local Python
// bridge. The hosted page never opens a socket, and the content script
// never touches the network — only this file does.
//
// Phase 2 direction: content script --chrome.runtime--> here --WebSocket--> Python
// Phase 3 direction: Python --WebSocket--> here --chrome.tabs--> content script

const WS_URL = "ws://127.0.0.1:8765";
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 10000;

// Must match manifest.json's content_scripts.matches — used to find which
// open tab(s) a command arriving from Python should be delivered to.
const TAB_MATCH_PATTERN = "http://localhost:5500/*";

const COMMAND_KEYS = ["forward", "back", "left", "right", "run"];

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

  socket.addEventListener("message", (event) => {
    handleIncomingCommand(event.data);
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

// Validates and normalizes a raw WebSocket text frame from Python into a
// well-formed robot-command object, or reports why it can't. Deliberately
// has no chrome.* dependency so it stays a small, independently testable
// pure function.
function parseCommand(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "not valid JSON" };
  }
  if (typeof data !== "object" || data === null || data.type !== "robot-command") {
    return { ok: false, reason: `unexpected type ${data?.type}` };
  }

  const command = { type: "robot-command" };
  for (const key of COMMAND_KEYS) {
    const value = data[key] ?? false; // an omitted field means "not held", same as the page's own default
    if (typeof value !== "boolean") {
      return { ok: false, reason: `${key} is not boolean (${JSON.stringify(value)})` };
    }
    command[key] = value;
  }
  return { ok: true, command };
}

function handleIncomingCommand(raw) {
  const result = parseCommand(raw);
  if (!result.ok) {
    console.warn(`[proxie-bridge/sw] rejected command from Python: ${result.reason}`);
    return;
  }
  broadcastCommand(result.command);
}

// Delivers the command to every open tab matching the hosted app's URL.
// This assignment assumes at most one relevant tab is open at a time; if
// more than one matches, all of them get the same command rather than
// building tab-selection logic (e.g. "last active tab") that a four-day
// demo doesn't need.
async function broadcastCommand(command) {
  const tabs = await chrome.tabs.query({ url: TAB_MATCH_PATTERN });
  if (tabs.length === 0) {
    console.log("[proxie-bridge/sw] no matching tab open — command dropped");
    return;
  }
  for (const tab of tabs) {
    chrome.tabs.sendMessage(tab.id, command).catch(() => {
      // Tab matched the URL pattern but has no content script listening
      // yet (e.g. mid-navigation) — safe to ignore for this demo.
    });
  }
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
