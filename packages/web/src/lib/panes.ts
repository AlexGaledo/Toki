import { getItem, setItem } from './persist';
export type PaneId = 'sidebar' | 'panel' | 'overview';
export type PaneWidths = Record<PaneId, number>;
export type SlotWidths = { sidebar: number; panel: number };
export type PanelKind = 'screen' | 'files' | 'overview';

export const PANES = {
  sidebar: { def: 260, min: 200, max: 420, key: 'pocketrocket.width.sidebar' },
  panel: { def: 400, min: 320, max: 1200, key: 'pocketrocket.width.panel' },
  overview: { def: 300, min: 260, max: 420, key: 'pocketrocket.width.overview' },
} as const;

export const RAIL_W = 56;
export const OVERVIEW_OPEN_MIN = 1280;

export const CHAT_MIN = 440;
export const CHAT_RAIL_W = 360;
export const SEP_W = 10;
export const REOPEN_W = 40;
export const COLLAPSE_PAST = 48;

export const SIDEBAR_INLINE_MIN = 768;
export const PANEL_INLINE_MIN = PANES.sidebar.min + PANES.panel.min + CHAT_MIN + SEP_W * 2;
export const PANEL_SOLO_MIN = PANES.panel.min + CHAT_MIN + SEP_W * 2 + REOPEN_W;

export const panelSqueezesSidebar = (vw: number, panelOpen: boolean) => panelOpen && vw >= PANEL_SOLO_MIN && vw < PANEL_INLINE_MIN;

export const clampPane = (want: number, min: number, max: number, room: number) => Math.max(min, Math.min(want, max, room));

export interface PaneState {
  paneW: PaneWidths;
  sidebarOpen: boolean;
  panelOpen: boolean;
  panelExpanded: boolean;
  panelKind?: PanelKind;
  overviewRail?: boolean;
}

export const slotPane = (s: Pick<PaneState, 'panelKind'>): 'panel' | 'overview' => (s.panelKind === 'overview' ? 'overview' : 'panel');
export const separatorPane = (pane: 'sidebar' | 'panel', s: Pick<PaneState, 'panelKind'>): PaneId => (pane === 'sidebar' ? 'sidebar' : slotPane(s));
export const isRail = (s: Pick<PaneState, 'panelKind' | 'overviewRail'>) => s.panelKind === 'overview' && !!s.overviewRail;

function paneRoom(vw: number, sidebarOn: boolean) {
  return vw - SEP_W * 2 - CHAT_MIN - (sidebarOn ? 0 : REOPEN_W);
}

export function paneLayout(vw: number, s: PaneState): SlotWidths {
  const overview = s.panelKind === 'overview';
  const sidebarOn = s.sidebarOpen && vw >= SIDEBAR_INLINE_MIN && !panelSqueezesSidebar(vw, s.panelOpen && !overview);
  const panelOn = s.panelOpen && vw >= (overview ? PANEL_INLINE_MIN : PANEL_SOLO_MIN);
  const room = paneRoom(vw, sidebarOn);
  const sb = PANES.sidebar;
  const slot = slotPane(s);
  const pn = PANES[slot];
  const want = slot === 'panel' && s.panelExpanded ? pn.max : s.paneW[slot];
  const panel = !panelOn ? 0 : isRail(s) ? RAIL_W : clampPane(want, pn.min, pn.max, room - (sidebarOn ? sb.min : 0));
  const sidebar = sidebarOn ? clampPane(s.paneW.sidebar, sb.min, sb.max, room - panel) : 0;
  return { sidebar, panel };
}

export function paneRange(pane: 'sidebar' | 'panel', vw: number, s: PaneState): { min: number; max: number } {
  const now = paneLayout(vw, s);
  const other = pane === 'sidebar' ? now.panel : now.sidebar;
  const { min, max } = PANES[separatorPane(pane, s)];
  return { min, max: Math.max(min, Math.min(max, paneRoom(vw, now.sidebar > 0) - other)) };
}

export function applyPaneVars(w: SlotWidths) {
  const root = document.documentElement.style;
  root.setProperty('--sidebar-w', w.sidebar + 'px');
  root.setProperty('--panel-w', w.panel + 'px');
}

export function panelDefault(vw: number) {
  return Math.max(PANES.panel.def, Math.min(PANES.panel.max, Math.round((vw - PANES.sidebar.def - SEP_W * 2) / 2)));
}

export function readPaneWidths(vw: number): PaneWidths {
  const read = (pane: PaneId) => {
    const v = Number(getItem(PANES[pane].key));
    if (v > 0) return clampPane(v, PANES[pane].min, PANES[pane].max, Infinity);
    return pane === 'panel' ? panelDefault(vw) : PANES[pane].def;
  };
  return { sidebar: read('sidebar'), panel: read('panel'), overview: read('overview') };
}

export function writePaneWidth(pane: PaneId, width: number) {
  setItem(PANES[pane].key, String(Math.round(width)));
}
