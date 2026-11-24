# (f2) Persistent headless MCP socket: run the blender-mcp add-on's command server inside `blender -b`.
# The add-on's start() refuses background mode (its queue is drained by a bpy.app.timers callback, and timers
# never fire while a -b script runs). This script binds the socket itself and pumps the queue on the main thread.
# Run: blender.exe -b --factory-startup -P f2_server.py -- <port> <max_seconds>
import socket
import sys
import threading
import time

import addon_utils
import bpy

port = int(sys.argv[sys.argv.index("--") + 1])
max_s = float(sys.argv[sys.argv.index("--") + 2])
t0 = time.time()

mod = addon_utils.enable("blender_mcp_addon", default_set=False, persistent=False)
print("SPIKE addon enabled:", bool(mod), "background:", bpy.app.background)

srv = mod.BlenderMCPServer(host="127.0.0.1", port=port)
srv.start()  # expected to refuse in -b; printed for the record
print("SPIKE start() left running =", srv.running)

# Same steps as start(), minus the background refusal and the timer.
srv.running = True
srv.socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
srv.socket.bind(("127.0.0.1", port))
srv.socket.listen(5)
srv.server_thread = threading.Thread(target=srv._server_loop, daemon=True)
srv.server_thread.start()
print("SPIKE listening 127.0.0.1:%d after %.2fs" % (port, time.time() - t0), flush=True)

handled = 0
while time.time() - t0 < max_s and srv.running:
    before = srv.command_queue.qsize()
    srv._drain_command_queue()
    handled += before
    time.sleep(0.02)
print("SPIKE pump exiting after %.1fs, ~%d commands" % (time.time() - t0, handled), flush=True)
srv.running = False
try:
    srv.socket.close()
except OSError:
    pass
