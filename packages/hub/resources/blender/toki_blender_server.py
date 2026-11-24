# Toki's headless Blender server (spec docs/specs/toki-local-first-gamedev.md, B12; owner decision 7).
#
# Started only by the hub's BlenderHost, never by hand:
#   blender.exe -b --factory-startup [art/<slug>.blend] --python-exit-code 1 -P toki_blender_server.py -- \
#     --port N --addon <pinned add-on.py> --blend <art/<slug>.blend> --stop <stop file> --idle S --autosave S
#
# The pinned mcp-for-blender add-on refuses to serve in -b (its command queue drains on a bpy.app.timers callback,
# and timers never fire while a -b script runs). So this script, after the S1 spike's f2_server.py:
#   1. loads the add-on from Toki's pinned environment by file path and calls its register();
#   2. sets every scene to EEVEE, so `look` renders with it;
#   3. binds 127.0.0.1:<port> itself and pumps the add-on's queue on the main thread;
#   4. puts toki_save() in builtins, so code sent through execute_blender_code can save without bpy.ops.wm.*;
#   5. saves on stop and every --autosave seconds while there are changes; stops on the stop file or after --idle
#      seconds with no command.
# It depends on the add-on's private BlenderMCPServer internals (command_queue, _server_loop, _drain_command_queue):
# rerun the B12 live check before changing the mcp-for-blender pin.
#
# Lines starting with TOKI_ go to the hub: READY <port>, RAM <peak working set bytes>, BIND_FAILED <port>, EXIT <why>.
import argparse
import builtins
import importlib.util
import os
import socket
import sys
import threading
import time

import bpy


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser(prog="toki_blender_server")
    p.add_argument("--port", type=int, required=True)
    p.add_argument("--addon", required=True)
    p.add_argument("--blend", required=True)
    p.add_argument("--stop", required=True)
    p.add_argument("--idle", type=float, default=660.0)
    p.add_argument("--autosave", type=float, default=300.0)
    return p.parse_args(argv)


def say(*parts):
    # The real stdout: code run by the add-on has its stdout captured for the bot.
    out = sys.__stdout__
    out.write("TOKI_" + " ".join(str(x) for x in parts) + "\n")
    out.flush()


def peak_working_set():
    try:
        if os.name == "nt":
            import ctypes
            from ctypes import wintypes

            class Counters(ctypes.Structure):
                _fields_ = [
                    ("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD),
                    ("PeakWorkingSetSize", ctypes.c_size_t), ("WorkingSetSize", ctypes.c_size_t),
                    ("QuotaPeakPagedPoolUsage", ctypes.c_size_t), ("QuotaPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t), ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                    ("PagefileUsage", ctypes.c_size_t), ("PeakPagefileUsage", ctypes.c_size_t),
                ]

            k32 = ctypes.WinDLL("kernel32")
            k32.GetCurrentProcess.restype = wintypes.HANDLE
            k32.K32GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(Counters), wintypes.DWORD]
            c = Counters()
            c.cb = ctypes.sizeof(c)
            if k32.K32GetProcessMemoryInfo(k32.GetCurrentProcess(), ctypes.byref(c), c.cb):
                return int(c.PeakWorkingSetSize)
            return 0
        import resource
        rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        return int(rss if sys.platform == "darwin" else rss * 1024)
    except Exception:
        return 0


def load_addon(path):
    # By file path from Toki's pinned environment: not addon_utils, not the owner's add-on folder or preferences.
    spec = importlib.util.spec_from_file_location("toki_blender_mcp_addon", path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    mod.register()
    return mod


# bpy.data collections whose fake-user blocks toki_save() keeps. Not windows, screens or workspaces.
KEPT_TYPES = (
    "actions", "armatures", "brushes", "cache_files", "cameras", "collections", "curves", "fonts", "grease_pencils",
    "hair_curves", "images", "lattices", "lightprobes", "lights", "linestyles", "masks", "materials", "meshes",
    "metaballs", "movieclips", "node_groups", "objects", "paint_curves", "palettes", "particles", "pointclouds",
    "sounds", "speakers", "texts", "textures", "volumes", "worlds",
)


class Saver:
    def __init__(self, blend):
        self.blend = os.path.abspath(blend)
        self.dirty = False
        self.last = time.time()

    def save(self):
        """Writes every scene and what it uses to art/<slug>.blend: a temp file, then a replace on success.

        Like a normal save, it also keeps data the user marked to keep (a fake user), and drops data nothing uses.
        """
        os.makedirs(os.path.dirname(self.blend), exist_ok=True)
        tmp = self.blend + ".toki-tmp"
        blocks = set(bpy.data.scenes)
        for attr in KEPT_TYPES:
            for block in getattr(bpy.data, attr, ()):
                if block.use_fake_user and block.library is None:
                    blocks.add(block)
        try:
            bpy.data.libraries.write(tmp, blocks, fake_user=True, compress=True)
            os.replace(tmp, self.blend)
        finally:
            if os.path.exists(tmp):
                os.remove(tmp)
        self.dirty = False
        self.last = time.time()
        return self.blend


def main():
    a = parse_args()
    saver = Saver(a.blend)

    def toki_save():
        """Save the open scene to this project's art/<slug>.blend. Takes no path: it never writes anywhere else."""
        return saver.save()

    builtins.toki_save = toki_save

    addon = load_addon(a.addon)
    for scene in bpy.data.scenes:
        try:
            scene.render.engine = "BLENDER_EEVEE"
        except Exception as e:
            print("toki: could not set EEVEE on", scene.name, e, flush=True)

    srv = addon.BlenderMCPServer(host="127.0.0.1", port=a.port)
    # start() refuses in -b. These are its steps without that refusal and without the timer.
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.bind(("127.0.0.1", a.port))  # no SO_REUSEADDR: a taken port fails here rather than being shared
        sock.listen(5)
    except OSError as e:
        print("toki: bind failed:", e, flush=True)
        say("BIND_FAILED", a.port)
        sys.exit(3)
    srv.socket = sock
    srv.running = True
    srv.server_thread = threading.Thread(target=srv._server_loop, daemon=True)
    srv.server_thread.start()
    say("READY", a.port)

    last_cmd = time.time()
    last_ram = 0.0
    why = "loop ended"
    while srv.running:
        now = time.time()
        if srv.command_queue.qsize():
            saver.dirty = True  # before the commands run, so one that ends in toki_save() leaves it clean
            srv._drain_command_queue()
            # Save after every batch of commands, so art/<slug>.blend on disk always matches the scene and a checkpoint
            # commit can never miss work the bot forgot to save (the B8 A/B run showed bots skip toki_save()).
            if saver.dirty or bpy.data.is_dirty:
                try:
                    saver.save()
                except Exception as e:
                    print("toki: save after command failed:", e, flush=True)
            last_cmd = now
            last_ram = 0.0  # a render can set a new peak: report it now, not in 30 s
        if os.path.exists(a.stop):
            why = "stop file"
            break
        if now - last_cmd >= a.idle:
            why = "idle"
            break
        if (saver.dirty or bpy.data.is_dirty) and now - saver.last >= a.autosave:
            try:
                saver.save()
                print("toki: autosaved", saver.blend, flush=True)
            except Exception as e:
                print("toki: autosave failed:", e, flush=True)
        if now - last_ram >= 30:
            say("RAM", peak_working_set())
            last_ram = now
        time.sleep(0.02)

    if saver.dirty or bpy.data.is_dirty:
        try:
            saver.save()
            print("toki: saved on stop", saver.blend, flush=True)
        except Exception as e:
            print("toki: save on stop failed:", e, flush=True)
    srv.running = False
    try:
        sock.close()
    except OSError:
        pass
    say("RAM", peak_working_set())
    say("EXIT", why)


main()
