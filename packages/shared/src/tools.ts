import type { IntegrationProvider } from './integrations.js';

/**
 * Every hub tool and how the permission broker treats it; the broker's sets derive from this. A name missing here
 * fails closed in `PermissionBroker.decide()`. Each class is also in every looser class's set:
 *   silent        no card.
 *   gated         the tool handler raises the card.
 *   askEveryTime  gated, answered per card; no session or rule pre-approves it.
 *   signInOnly    askEveryTime, and only a browser signed in with the owner's password may allow it.
 *   unlisted      in no broker set; `decide()` cards it like an unknown tool.
 */
export type HubToolClass = 'silent' | 'gated' | 'askEveryTime' | 'signInOnly' | 'unlisted';

export const INTEGRATION_TOOLS: Record<IntegrationProvider, { read: readonly string[]; write: readonly string[] }> = {
  github: {
    read: ['github_search_issues', 'github_list_issues', 'github_read_issue', 'github_notifications'],
    write: ['github_create_issue', 'github_comment'],
  },
  google: {
    read: ['gmail_search', 'gmail_read', 'calendar_list_events', 'drive_search', 'drive_read'],
    write: ['gmail_send', 'calendar_create_event'],
  },
  slack: {
    read: ['slack_list_channels', 'slack_read_history'],
    write: ['slack_post_message'],
  },
  clickup: {
    read: ['clickup_list_lists', 'clickup_list_tasks', 'clickup_search_tasks', 'clickup_read_task'],
    write: ['clickup_create_task', 'clickup_comment'],
  },
  teams: {
    read: ['teams_list_chats', 'teams_read_chat'],
    write: ['teams_send_chat'],
  },
};

export const INTEGRATION_READ_TOOLS: readonly string[] = Object.values(INTEGRATION_TOOLS).flatMap((t) => t.read);
export const INTEGRATION_WRITE_TOOLS: readonly string[] = Object.values(INTEGRATION_TOOLS).flatMap((t) => t.write);
export const GOOGLE_WRITE_TOOLS: readonly string[] = INTEGRATION_TOOLS.google.write;

export const DESKTOP_TOOL_NAMES: readonly string[] = [
  'desktop_screenshot', 'desktop_click', 'desktop_type', 'desktop_key', 'desktop_scroll', 'desktop_launch',
];

const silent = (names: readonly string[]): [string, HubToolClass][] => names.map((n) => [n, 'silent']);
const gated = (names: readonly string[]): [string, HubToolClass][] => names.map((n) => [n, 'gated']);

export const HUB_TOOLS: Readonly<Record<string, HubToolClass>> = Object.freeze(Object.fromEntries<HubToolClass>([
  ...silent([
    'send_message', 'handoff', 'update_memory', 'read_memory', 'save_skill', 'list_bots', 'read_room',
    'list_rooms', 'request_approval', 'use_stronger_model',
    'list_routines', 'list_workflows',
    'where_to_run',
    'list_machines',
    'escalate',
    'search_notes', 'write_note',
    'read_skill',
    'create_task', 'update_task', 'list_tasks', 'search_history', 'recall_memory', 'report_blocked', 'send_feedback',
    // Carries no secret: secret-looking labels and answers are refused.
    'request_form',
    'log_decision', 'file_history',
    'list_repos',
  ]),
  ...silent(DESKTOP_TOOL_NAMES),
  // Untrusted output is labelled as such.
  ...silent(INTEGRATION_READ_TOOLS),
  ...gated([
    'create_bot', 'update_bot', 'delete_bot', 'create_room', 'delete_room', 'add_to_room', 'remove_from_room',
    'create_routine', 'update_routine', 'delete_routine',
    'create_workflow', 'update_workflow',
    'dispatch',
  ]),
  ...gated(INTEGRATION_WRITE_TOOLS.filter((n) => !GOOGLE_WRITE_TOOLS.includes(n))),
  // Sends go out as the owner and bots read untrusted mail, so only a signed-in browser may allow one: the hub token,
  // which a bot under bypass can read, cannot.
  ...GOOGLE_WRITE_TOOLS.map((n): [string, HubToolClass] => [n, 'signInOnly']),
  ['propose_routing_change', 'askEveryTime'],
  // A card under bypass too.
  ['propose_rule', 'askEveryTime'],
  // Asks even under bypass.
  ['run_on_pc', 'signInOnly'],
  // Only a password-signed-in browser may allow it, and the PC asks again before running anything.
  ['propose_move', 'signInOnly'],
  // Asked on every call, under bypass too; only a signed-in browser may allow it.
  ['fill_credential', 'signInOnly'],
  ['read_owner_messages', 'unlisted'],
  ['read_any_room', 'unlisted'],
  ['list_pc_sessions', 'unlisted'],
  ['read_pc_session', 'unlisted'],
  ['search_project_context', 'unlisted'],
  ['view_screen', 'unlisted'],
  ['request_takeover', 'unlisted'],
]));

const where = (pred: (c: HubToolClass) => boolean): ReadonlySet<string> =>
  new Set(Object.entries(HUB_TOOLS).filter(([, c]) => pred(c)).map(([n]) => n));

export const SILENT_TOOLS: ReadonlySet<string> = where((c) => c === 'silent');
export const GATED_TOOLS: ReadonlySet<string> = where((c) => c === 'gated' || c === 'askEveryTime' || c === 'signInOnly');
export const ASK_EVERY_TIME_TOOLS: ReadonlySet<string> = where((c) => c === 'askEveryTime' || c === 'signInOnly');
/** Cards only a browser signed in with the owner's password may allow. */
export const SIGN_IN_TOOLS: ReadonlySet<string> = where((c) => c === 'signInOnly');
