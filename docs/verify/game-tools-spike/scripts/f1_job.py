# (f1) One headless Blender job: build a scene with bpy, save the .blend, render one 512x512 EEVEE frame to PNG.
# Run: blender.exe --background --factory-startup --python f1_job.py -- <out_dir>
import os
import sys
import time

import bpy

t0 = time.time()
out = sys.argv[sys.argv.index("--") + 1]
os.makedirs(out, exist_ok=True)

engines = [e.identifier for e in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items]
print("SPIKE engines:", engines)
eevee = next((e for e in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE") if e in engines), None)
print("SPIKE eevee id:", eevee)

bpy.ops.object.select_all(action="DESELECT")
bpy.ops.mesh.primitive_monkey_add(location=(0, 0, 1))
m = bpy.context.active_object
mat = bpy.data.materials.new("SpikeOrange")
mat.diffuse_color = (1.0, 0.35, 0.05, 1.0)
if mat.node_tree is not None:
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        bsdf.inputs["Base Color"].default_value = (1.0, 0.35, 0.05, 1.0)
m.data.materials.append(mat)

blend = os.path.join(out, "f1_scene.blend")
bpy.ops.wm.save_as_mainfile(filepath=blend)
print("SPIKE saved", blend, os.path.getsize(blend), "bytes")

sc = bpy.context.scene
sc.render.engine = eevee
sc.render.resolution_x = 512
sc.render.resolution_y = 512
sc.render.resolution_percentage = 100
sc.render.image_settings.file_format = "PNG"
png = os.path.join(out, "f1_render.png")
sc.render.filepath = png
t1 = time.time()
bpy.ops.render.render(write_still=True)
print("SPIKE render seconds: %.2f" % (time.time() - t1))
print("SPIKE png", png, os.path.getsize(png) if os.path.exists(png) else "MISSING")
print("SPIKE gpu backend:", getattr(bpy.app, "gpu_backend", "?") if hasattr(bpy.app, "gpu_backend") else "n/a")
try:
    import gpu
    print("SPIKE gpu:", gpu.platform.vendor_get(), "|", gpu.platform.renderer_get(), "|", gpu.platform.backend_type_get())
except Exception as e:  # noqa: BLE001
    print("SPIKE gpu info unavailable:", e)
print("SPIKE script seconds: %.2f" % (time.time() - t0))
