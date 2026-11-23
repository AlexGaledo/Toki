import { MAP_GROUPS, type ProjectMap } from '@pocketrocket/shared';

export const NODE_W = 168;
export const NODE_H = 56;
const COL_W = 216;
const ROW_H = 92;
const STEP_X = 200;
const ZIG = 46;

export interface PlacedNode {
  id: string;
  label: string;
  tech: string;
  group: string | null;
  state: 'done' | 'now' | 'next' | null;
  x: number;
  y: number;
}
export type EdgeTone = 'plain' | 'active' | 'off';
export interface PlacedEdge { from: string; to: string; tone: EdgeTone }
export interface GroupLabel { name: string; x: number; y: number }
export interface MapLayout {
  nodes: PlacedNode[];
  edges: PlacedEdge[];
  groups: GroupLabel[];
  bounds: { x0: number; y0: number; x1: number; y1: number };
}

const OTHER = 'other';

export function layoutMap(map: ProjectMap): MapLayout {
  const nodes: PlacedNode[] = [];
  const groups: GroupLabel[] = [];
  const base = (n: ProjectMap['nodes'][number]) => ({ id: n.id, label: n.label, tech: n.tech ?? '', group: n.group?.trim() || null, state: n.state ?? null });

  if (map.kind === 'roadmap') {
    map.nodes.forEach((n, i) => nodes.push({ ...base(n), x: i * STEP_X, y: i % 2 ? ZIG : -ZIG }));
  } else {
    const deg = new Map<string, number>();
    for (const [a, b] of map.edges) {
      deg.set(a, (deg.get(a) ?? 0) + 1);
      deg.set(b, (deg.get(b) ?? 0) + 1);
    }
    const key = (n: ProjectMap['nodes'][number]) => n.group?.trim().toLowerCase() || OTHER;
    const present = [...new Set(map.nodes.map(key))];
    const known = MAP_GROUPS.filter((g) => present.includes(g));
    const order = [...known, ...present.filter((g) => !(MAP_GROUPS as readonly string[]).includes(g) && g !== OTHER), ...(present.includes(OTHER) ? [OTHER] : [])];
    order.forEach((g, col) => {
      const inCol = map.nodes.filter((n) => key(n) === g).map((n, i) => ({ n, i })).sort((a, b) => (deg.get(b.n.id) ?? 0) - (deg.get(a.n.id) ?? 0) || a.i - b.i);
      const lift = col % 2 ? ROW_H / 3 : 0;
      inCol.forEach(({ n }, k) => {
        const slot = k === 0 ? 0 : (k % 2 ? -1 : 1) * Math.ceil(k / 2);
        nodes.push({ ...base(n), x: col * COL_W, y: slot * ROW_H + lift });
      });
      const ys = nodes.filter((p) => p.x === col * COL_W).map((p) => p.y);
      if (!(g === OTHER && order.length === 1)) groups.push({ name: g, x: col * COL_W, y: Math.min(...ys) - NODE_H / 2 - 22 });
    });
  }

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges: PlacedEdge[] = map.edges
    .filter(([a, b]) => byId.has(a) && byId.has(b))
    .map(([a, b, st]) => {
      if (st) return { from: a, to: b, tone: st };
      if (map.kind === 'roadmap') {
        const s = byId.get(b)?.state;
        return { from: a, to: b, tone: s === 'now' ? 'active' : s === 'next' ? 'off' : 'plain' };
      }
      return { from: a, to: b, tone: 'plain' };
    });

  const xs = nodes.map((n) => n.x), ys = nodes.map((n) => n.y), gy = groups.map((g) => g.y - 10);
  const bounds = nodes.length
    ? { x0: Math.min(...xs) - NODE_W / 2, x1: Math.max(...xs) + NODE_W / 2, y0: Math.min(...ys, ...gy) - NODE_H / 2, y1: Math.max(...ys) + NODE_H / 2 }
    : { x0: 0, x1: 0, y0: 0, y1: 0 };
  return { nodes, edges, groups, bounds };
}

export function edgePath(a: { x: number; y: number }, b: { x: number; y: number }): string {
  const hw = NODE_W / 2, hh = NODE_H / 2;
  if (Math.abs(b.x - a.x) > NODE_W * 0.75) {
    const d = b.x > a.x ? 1 : -1, x1 = a.x + d * hw, x2 = b.x - d * hw, k = Math.max(28, Math.abs(x2 - x1) / 2);
    return `M${x1} ${a.y}C${x1 + d * k} ${a.y} ${x2 - d * k} ${b.y} ${x2} ${b.y}`;
  }
  const d = b.y > a.y ? 1 : -1, y1 = a.y + d * hh, y2 = b.y - d * hh, k = Math.max(20, Math.abs(y2 - y1) / 2);
  return `M${a.x} ${y1}C${a.x} ${y1 + d * k} ${b.x} ${y2 - d * k} ${b.x} ${y2}`;
}

export function fitView(bounds: MapLayout['bounds'], w: number, h: number, pad = { top: 72, right: 32, bottom: 104, left: 32 }, minScale = 0.35) {
  const bw = Math.max(1, bounds.x1 - bounds.x0), bh = Math.max(1, bounds.y1 - bounds.y0);
  const aw = Math.max(80, w - pad.left - pad.right), ah = Math.max(80, h - pad.top - pad.bottom);
  const s = Math.max(minScale, Math.min(1, aw / bw, ah / bh));
  const cx = (bounds.x0 + bounds.x1) / 2, cy = (bounds.y0 + bounds.y1) / 2;
  return { s, tx: pad.left + aw / 2 - cx * s, ty: pad.top + ah / 2 - cy * s };
}

export type MapKind = ProjectMap['kind'];
export const MAP_KIND_LABEL: Record<MapKind, string> = { architecture: 'System map', roadmap: 'Roadmap' };

export function generateMessage(handle: string, kind: MapKind, regenerate = false): string {
  const what = kind === 'architecture' ? 'system map' : 'roadmap';
  return '@' + handle + ' Please ' + (regenerate ? 'redraw' : 'draw') + " this project's " + what + ' (map.json) with the project-map skill.';
}

export function promptMessage(handle: string, text: string, picked: string[]): string {
  const t = text.trim();
  return '@' + handle + ' ' + t + (picked.length ? ' (map: ' + picked.join(', ') + ')' : '');
}
