import { z } from 'zod';

/**
 * Phase 3 of docs/specs/toki-local-first-gamedev.md: one app, two hosts. Nothing is migrated (owner decision 6). The
 * desktop app reads the server hub's project list through its tunnel and hands the PC hub **stubs**: names only.
 * The PC hub is `pc`; `server` is the only other host.
 */
export const REMOTE_HOST_IDS = ['server'] as const;
export type RemoteHostId = (typeof REMOTE_HOST_IDS)[number];
export type HostId = 'pc' | RemoteHostId;

export const MAX_STUBS_PER_HOST = 500;

/** The same rule as a local project: `POST /api/projects` `name`. */
export const ProjectNameSchema = z.string().trim().min(1).max(60);

/** What `slugify()` in the hub can produce: lowercase letters, digits and single dashes, at most 40. */
export const PROJECT_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Remote text is shown in the app: no control or bidi-override characters on top of the project-name rule.
// eslint-disable-next-line no-control-regex -- the point is to find control characters
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/;

export const ProjectStubInputSchema = z.object({
  slug: z.string().min(1).max(40).regex(PROJECT_SLUG_RE, 'not a project slug'),
  name: ProjectNameSchema.refine((n) => !UNSAFE_TEXT.test(n), 'has control characters'),
}).strict();

/**
 * `PUT /api/hosts/:host/projects`. With `projects`, they replace every stub of that host. Without, the stubs stay
 * (the tunnel dropped, so they are the last known list) and only `connected` changes.
 */
export const HostProjectsInputSchema = z.object({
  connected: z.boolean(),
  projects: z.array(ProjectStubInputSchema).max(MAX_STUBS_PER_HOST).optional(),
}).strict().refine(
  (v) => !v.projects || new Set(v.projects.map((p) => p.slug)).size === v.projects.length,
  { message: 'each slug may appear once', path: ['projects'] },
);
export type HostProjectsInput = z.infer<typeof HostProjectsInputSchema>;

/** A project on another host, as `GET /api/projects` lists it. It has no folder, members or room on this hub. */
export interface ProjectStub {
  host: RemoteHostId;
  slug: string;
  name: string;
  /** When the desktop app last saw it in that host's list (ms). */
  seenAt: number;
  /** Whether that host's tunnel is up right now, as the desktop app last said. */
  connected: boolean;
}

/** The reply to `PUT /api/hosts/:host/projects`. */
export interface HostState {
  host: RemoteHostId;
  connected: boolean;
  stubs: number;
  updatedAt: number;
}

/** B11: shown in the usage view once a server host is known. Fixed words, never remote text. */
export const SHARED_SUBSCRIPTION_NOTE =
  'Your PC and your server both spend from the same Claude subscription, so its usage limits cover the bots on both.';
