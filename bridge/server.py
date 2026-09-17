"""Phase 2: local WebSocket server that receives robot-state messages
from the Chrome extension's service worker and prints them live.

Bridge direction implemented here: browser -> Python only. Sending
commands back into the browser is Phase 3 and is not implemented yet.
"""

import asyncio
import json
import time

import websockets

HOST = "127.0.0.1"  # loopback only, never 0.0.0.0 for this bridge
PORT = 8765

STATS_EVERY = 60  # print an interval summary every N accepted messages


def validate_robot_state(data):
    """Return (True, None) if `data` is a well-formed robot-state
    message, else (False, reason). Kept as plain explicit checks --
    three numeric fields don't need a schema library."""
    if not isinstance(data, dict):
        return False, "not a JSON object"
    if data.get("type") != "robot-state":
        return False, f"unexpected type {data.get('type')!r}"
    for field in ("x", "z", "rotationY"):
        value = data.get(field)
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            return False, f"{field} is not numeric ({value!r})"
    return True, None


async def handle_connection(websocket):
    print("Connected")
    count = 0
    rejected = 0
    window_start = time.monotonic()

    try:
        async for raw in websocket:
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                rejected += 1
                print(f"[warn] non-JSON message ignored: {raw[:100]!r}")
                continue

            ok, reason = validate_robot_state(data)
            if not ok:
                rejected += 1
                print(f"[warn] rejected message: {reason}")
                continue

            count += 1
            print(
                f"robot-state x={data['x']:.2f} z={data['z']:.2f} "
                f"rotationY={data['rotationY']:.3f}"
            )

            if count % STATS_EVERY == 0:
                elapsed = time.monotonic() - window_start
                avg_interval_ms = (elapsed / STATS_EVERY) * 1000
                print(f"-- messages: {count}  avg interval (last {STATS_EVERY}): {avg_interval_ms:.1f} ms --")
                window_start = time.monotonic()
    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        print(f"Disconnected (received {count}, rejected {rejected})")


async def main():
    print(f"Listening on ws://{HOST}:{PORT} (Ctrl+C to stop)")
    async with websockets.serve(handle_connection, HOST, PORT):
        await asyncio.Future()  # run forever


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nStopped")
