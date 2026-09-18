# Proxie Robot Bridge

Bridges the publicly hosted [`index.html`](index.html) Three.js robot app to a local Python
process, live and in both directions, without turning the hosted app into a client/server
backend. Built for the Proxie Studio DevOps Evaluation (Round 1).

## 1. Overview

`index.html` is a self-contained, purely static Three.js app: a robot you drive around a
field with WASD/arrow keys. It's hosted as-is on GitHub Pages — no server, no build step.

A Chrome extension bridges that hosted page to a local Python script over a WebSocket:

- **Browser → Python**: the robot's live position/rotation streams to Python continuously
  (once per animation frame, ~60/sec).
- **Python → Browser**: typing a command at the Python terminal (`forward`, `back`,
  `left`, `right`, `run`, `stop`) drives the robot in the browser — no keyboard involved.

## 2. Architecture / data flow

```
index.html (hosted, static, unmodified)
   |  window.postMessage({type:"robot-state", ...})      every animation frame
   |  window.postMessage({type:"robot-command", ...})     <- listened for
   v
content_script.js  (Chrome extension, isolated world, shares the page's window)
   |  chrome.runtime.sendMessage / onMessage
   v
background.js  (MV3 service worker — the only part that touches the network)
   |  WebSocket  ws://127.0.0.1:8765
   v
bridge/server.py  (local Python, ordinary script, loopback-only)
```

The hosted page never opens a socket and is never modified. The content script only
relays `postMessage` traffic to/from the service worker. The service worker is the sole
network boundary, holding the one WebSocket connection to Python.

## 3. Prerequisites

- Google Chrome (or another Chromium-based browser with Manifest V3 extension support)
- Python 3.9+
- `pip`

## 4. Python environment setup

```bash
cd bridge
python3 -m venv .venv
source .venv/bin/activate    # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

The only dependency is `websockets`.

## 5. Start the Python bridge

```bash
cd bridge
source .venv/bin/activate
python3 server.py
```

You should see:
```
Listening on ws://127.0.0.1:8765 (Ctrl+C to stop)
Commands: back, forward, left, right, run, stop (type one and press Enter, Ctrl+C to quit)
```

**Start this before opening the hosted page** — see Troubleshooting if you don't.

## 6. Install the Chrome extension (unpacked)

1. Go to `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked**, and select this repo's `extension/` folder.
4. Confirm "Proxie Robot Bridge" appears and is enabled.

## 7. Public hosted URL

**https://kush-dabade.github.io/proxie-devops-assignment/**

This is a real public GitHub Pages URL (HTTPS, not `localhost`, not `file://`). The
extension is scoped to this exact URL (`content_scripts.matches` in `extension/manifest.json`)
— it will not run on any other site.

Open this URL in Chrome after the extension is loaded and the Python server is running.

## 8. Verify Browser → Python

1. With the page open and the Python server running, drive the robot with **WASD** /
   arrow keys.
2. Watch the Python terminal: `robot-state x=... z=... rotationY=...` lines should
   stream continuously as you move.
3. (Optional) Open the page's DevTools console — `[proxie-bridge] robot-state ...` logs
   confirm the content script is receiving the broadcasts.

## 9. Verify Python → Browser

1. With the page open and connected, click into the **Python terminal**.
2. Type each of the following, pressing Enter after each, **without touching the
   keyboard in the browser**:
   ```
   forward
   stop
   left
   right
   run
   stop
   ```
3. The robot should visibly move/turn/run/stop in the browser in response to each line,
   confirming the command path works independently of WASD.

## 10. Why this mechanism

A Chrome extension content script can observe the hosted page's `window.postMessage`
traffic and relay it to an extension service worker, allowing the supplied `index.html`
to remain completely unchanged. The service worker maintains a WebSocket to the local
Python process, providing an event-driven bidirectional bridge without requiring a
server-side component for the hosted site. Compared with CDP/browser automation or
WebRTC, this approach keeps the implementation lightweight and directly fits the
supplied page's existing messaging interface.

## 11. Trade-offs (honest, not hand-waved)

- **Latency**: state messages are emitted once per animation frame (~16ms / 60fps) and
  forwarded unthrottled through `chrome.runtime` messaging and the WebSocket. This is
  real-time and event-driven, not polling — but total end-to-end latency (page → content
  script → service worker → WebSocket → Python) was not independently instrumented with
  timestamps on both ends; what's confirmed is that the *rate* is frame-paced and
  commands visibly take effect immediately, not that a specific millisecond figure holds.
- **Chrome extension permissions**: the extension requests `"tabs"` (required for the
  service worker to find and message the correct tab by URL — this API is unavailable to
  a service worker without it) and a `content_scripts.matches` host permission scoped to
  the exact public URL only. No `<all_urls>`, no broader host access.
- **Local unauthenticated WebSocket**: `ws://127.0.0.1:8765` has no auth token and no TLS.
  It's bound to loopback only (`127.0.0.1`, never `0.0.0.0`), so it's not reachable from
  the network — but any other local process or browser tab on the same machine could, in
  principle, connect to it. Acceptable for a local dev bridge; would need auth for
  anything beyond that.
- **MV3 service-worker lifecycle**: non-persistent service workers are torn down by
  Chrome after ~30s of inactivity. This bridge relies on the continuous stream of
  `robot-state` events (while a matching tab is open) to keep the worker alive and to
  re-trigger reconnection on every fresh wake. If the tab is closed or backgrounded long
  enough for the worker to fully idle out, the Python connection drops until the next
  event wakes it — there's no artificial keepalive added to mask this.
- **`postMessage(..., "*")` / no `event.origin` check**: `index.html`'s own
  `robot-state`/`robot-command` messaging uses a wildcard target origin and checks only
  `event.source === window`, never `event.origin`. This is pre-existing in the supplied
  app and was not modified. In practice it means any script sharing that tab's `window`
  (which is exactly what the content script relies on) can post or read these messages —
  moving the page to a public URL doesn't by itself widen this, since browsers isolate
  `window` objects across tabs/origins.
- **Multiple matching tabs**: if more than one tab has the hosted URL open, a Python
  command is broadcast to all of them (not just one). This assignment assumes one active
  tab; a "last active tab" selection strategy was deliberately not built for this scope.

## 12. Testing/verification summary

- **Automated**: JSON/JS/Python syntax validation; a real Node `vm`-sandboxed test suite
  against `background.js`'s reconnect/backoff logic and `parseCommand` (no duplicate
  sockets or timers, correct exponential backoff and reset, malformed-input rejection);
  a real subprocess + WebSocket integration test suite against `server.py` (malformed
  JSON, invalid `robot-state` fields, unknown commands, commands with no browser
  connected, and a client disconnecting mid-broadcast — reproduced as an actual crash
  against the original code, then confirmed fixed).
- **Manual (by the repo owner, in real Chrome, against the real public URL)**: extension
  loads and injects on the hosted page; `robot-state` streams to the Python terminal
  while driving with WASD; typing `forward`/`stop`/`left`/`right`/`run`/`stop` at the
  Python terminal visibly drives the robot with no keyboard input.
- Not independently re-verified per change: exact end-to-end latency in milliseconds,
  and MV3 service-worker idle/wake timing (see Trade-offs above) — both require live
  Chrome instrumentation beyond what a terminal-only environment can check.

## 13. Troubleshooting

- **Changed `extension/manifest.json` or `background.js`'s match pattern?** Reload the
  extension in `chrome://extensions` (toggle off/on, or the reload icon). Chrome caches
  the manifest's `matches` at load time — refreshing the page tab alone is not enough.
- **Just reloaded the extension?** Refresh (or reopen) any already-open tab on the hosted
  URL. A tab opened before an extension reload has an orphaned content script that can no
  longer reach the new service worker instance; you'll see repeated
  `chrome.runtime.sendMessage failing` warnings in that tab's console until it's
  refreshed.
- **No `robot-state` lines / commands don't move the robot?** Make sure `python3
  server.py` is already running *before* you expect data to flow — the extension
  reconnects automatically with backoff if it wasn't, but there's a delay before the
  first successful connection.
- **`OSError: address already in use` on startup?** Something else is already bound to
  `127.0.0.1:8765` — find and stop it (e.g. `lsof -i :8765` / `ss -ltnp | grep 8765`) or
  wait for a prior instance of `server.py` to exit first.
- **Extension doesn't inject at all?** Confirm you're on the exact URL in section 7
  (`content_scripts.matches` is scoped to it precisely, not a wildcard) and that
  Developer mode is enabled with the extension showing no errors on
  `chrome://extensions`.
