import { z } from 'zod';

/** Every string is bot text shown as plain text, never as Markdown, HTML or a link. */
export const MAP_FILE = 'map.json';
export const MAX_MAP_BYTES = 64 * 1024;
export const MAX_MAP_NODES = 60;
export const MAX_MAP_EDGES = 120;
export const MAP_GROUPS = ['client', 'core', 'data', 'ai', 'infra'] as const;

const text = (max: number) => z.string().trim().min(1).max(max);

export const ProjectMapNodeSchema = z.object({
  id: text(40),
  label: text(40),
  tech: z.string().trim().max(60).optional(),
  group: z.string().trim().max(20).optional(),
  state: z.enum(['done', 'now', 'next']).optional(),
});

export const ProjectMapEdgeSchema = z.union([
  z.tuple([z.string().max(40), z.string().max(40)]),
  z.tuple([z.string().max(40), z.string().max(40), z.enum(['active', 'off'])]),
]);

export const ProjectMapSchema = z
  .object({
    version: z.literal(1),
    kind: z.enum(['architecture', 'roadmap']),
    generatedBy: text(40),
    generatedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date like 2026-11-20'),
    nodes: z.array(ProjectMapNodeSchema).max(MAX_MAP_NODES),
    edges: z.array(ProjectMapEdgeSchema).max(MAX_MAP_EDGES),
  })
  .superRefine((m, ctx) => {
    const seen = new Set<string>();
    m.nodes.forEach((n, i) => {
      if (seen.has(n.id)) ctx.addIssue({ code: 'custom', path: ['nodes', i, 'id'], message: 'duplicate node id "' + n.id + '"' });
      seen.add(n.id);
    });
  });

export type ProjectMapNode = z.output<typeof ProjectMapNodeSchema>;
export type ProjectMapEdge = z.output<typeof ProjectMapEdgeSchema>;
export type ProjectMap = z.output<typeof ProjectMapSchema>;

export interface ProjectMapReply {
  map: ProjectMap | null;
  error: string | null;
  mtime: number | null;
  droppedEdges: number;
}

export function checkProjectMap(input: unknown): { map: ProjectMap; droppedEdges: number } | { error: string } {
  const r = ProjectMapSchema.safeParse(input);
  if (!r.success) {
    const i = r.error.issues[0];
    return { error: (i.path.length ? i.path.join('.') + ': ' : '') + i.message };
  }
  const ids = new Set(r.data.nodes.map((n) => n.id));
  const edges = r.data.edges.filter((e) => ids.has(e[0]) && ids.has(e[1]));
  return { map: { ...r.data, edges }, droppedEdges: r.data.edges.length - edges.length };
}

export interface ProjectOverview {
  updated: string | null;
  plan: { done: number; total: number; stage: string | null } | null;
  next: string | null;
  done: string[];
  waiting: string[];
}
