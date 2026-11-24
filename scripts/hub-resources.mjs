// Non-code files the hub reads at run time from <HUB_DIR>/resources/ (spec toki-local-first-gamedev, I4).
//
//   resources/blender/toki_blender_server.py   BlenderHost.blenderServerScript() (-P for `blender -b`)
//   resources/blender/requirements.txt         GameTools.requirements (uv pip install --require-hashes)
//
// Where they land:
//   - desktop app: build-hub.mjs copies packages/hub/resources/ to packages/hub/build/resources/, Tauri ships
//     build/ as <install>/hub/ (tauri.conf.json "resources"), and HUB_DIR is that folder because hub.mjs sits
//     beside node_modules.
//   - dev and the VPS: HUB_DIR is packages/hub itself (tsx src/, or dist/hub.mjs one level down), and
//     scripts/deploy.sh ships the source tree with resources/ in it.
//   - anywhere: POCKETROCKET_BLENDER_SERVER (absolute) overrides the script path; requirements.txt is read
//     from beside it.
import fs from 'node:fs';
import path from 'node:path';

export const HUB_RESOURCES = ['resources/blender/toki_blender_server.py', 'resources/blender/requirements.txt'];

/** Copy `<hubDir>/resources/` into `<buildDir>/resources/` and check every file in HUB_RESOURCES arrived intact. */
export function copyHubResources(hubDir, buildDir) {
  const missing = HUB_RESOURCES.filter((rel) => !fs.existsSync(path.join(hubDir, rel)));
  if (missing.length) throw new Error(`hub resources missing from ${hubDir}: ${missing.join(', ')}`);
  const out = path.join(buildDir, 'resources');
  fs.rmSync(out, { recursive: true, force: true });
  fs.cpSync(path.join(hubDir, 'resources'), out, {
    recursive: true,
    filter: (src) => path.basename(src) !== '__pycache__',
  });
  for (const rel of HUB_RESOURCES) {
    const a = fs.readFileSync(path.join(hubDir, rel));
    const b = fs.existsSync(path.join(buildDir, rel)) ? fs.readFileSync(path.join(buildDir, rel)) : null;
    if (!b || !a.equals(b)) throw new Error(`hub resource did not copy intact: ${rel}`);
  }
  return HUB_RESOURCES.map((rel) => path.join(buildDir, rel));
}
