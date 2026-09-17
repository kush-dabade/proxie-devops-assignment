"""Local WebSocket server bridging the hosted robot app and this Python
process. Two directions, both over the same connection:

  browser -> Python: robot-state messages, printed live (Phase 2).
  Python -> browser: robot-command messages, typed at this terminal
                      and sent to the connected extension (Phase 3).
"""

import asyncio
import json
import sys
import time

import websockets

HOST = "127.0.0.1"  # loopback only, never 0.0.0.0 for this bridge
PORT = 8765

STATS_EVERY = 60  # print an interval summary every N accepted state messages

# Each entry is a full robot-command payload -- the supplied page expects
# every message to state the complete set of held keys, not a delta, so
# these are complete states rather than toggles. "run" is expressed as
# "run forward" since running in place has no visible effect in the app
# (speed only matters while the robot is actually moving).
COMMANDS = {
    "forward": {"forward": True,  "back": False, "left": False, "right": False, "run": False},
    "back":    {"forward": False, "back": True,  "left": False, "right": False, "run": False},
    "left":    {"forward": False, "back": False, "left": True,  "right": False, "run": False},
    "right":   {"forward": False, "back": False, "left": False, "right": True,  "run": False},
    "run":     {"forward": True,  "back": False, "left": False, "right": False, "run": True},
    "stop":    {"forward": False, "back": False, "left": False, "right": False, "run": False},
}

CONNECTED_CLIENTS = set()  # currently open extension WebSocket connections


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
    CONNECTED_CLIENTS.add(websocket)
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
        CONNECTED_CLIENTS.discard(websocket)
        print(f"Disconnected (received {count}, rejected {rejected})")


async def send_command(name):
    """Look up `name` in COMMANDS and send it to every connected
    extension. Unknown names and a missing connection are both reported
    and simply not sent -- never raised, so a bad command typed at the
    terminal can't take down the server or the socket."""
    fields = COMMANDS.get(name)
    if fields is None:
        print(f"[warn] unknown command {name!r} -- choices: {', '.join(sorted(COMMANDS))}")
        return
    if not CONNECTED_CLIENTS:
        print("[warn] no browser connected -- command not sent")
        return

    message = json.dumps({"type": "robot-command", **fields})
    await asyncio.gather(*(client.send(message) for client in CONNECTED_CLIENTS))
    print(f"sent: {name} -> {fields}")


async def command_input_loop():
    """Reads command names typed at this terminal and sends them to the
    browser. Runs for the lifetime of the process alongside the
    WebSocket server."""
    loop = asyncio.get_running_loop()
    print(f"Commands: {', '.join(sorted(COMMANDS))} (type one and press Enter, Ctrl+C to quit)")
    while True:
        line = await loop.run_in_executor(None, sys.stdin.readline)
        if not line:  # stdin closed (e.g. piped input ran out)
            break
        name = line.strip().lower()
        if name:
            await send_command(name)


async def main():
    print(f"Listening on ws://{HOST}:{PORT} (Ctrl+C to stop)")
    async with websockets.serve(handle_connection, HOST, PORT):
        await command_input_loop()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nStopped")
