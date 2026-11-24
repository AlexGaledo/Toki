import { useCallback, useEffect, useState } from 'react';
import type { GameToolsStatus } from '@pocketrocket/shared';
import { useStore } from '../store';
import { api } from './api';

/** I1: the desktop shell launches Studio from this exact URL; the page gets no answer, so status is re-read after. */
export function openStudio(): void {
  window.open(location.origin + '/?launch=studio', '_blank');
}

/**
 * When to re-read `GET /api/game-tools`: on the hub's `game-tools.changed` event (Toki's own Blender and the fixes)
 * and when the window regains focus (Studio or another Blender changed outside Toki). There is no timer: each read
 * runs a tasklist on the hub.
 */
export function watchGameTools(
  reload: () => void,
  deps: { onRev: (fn: () => void) => () => void; focus: Pick<Window, 'addEventListener' | 'removeEventListener'> },
): () => void {
  const off = deps.onRev(reload);
  deps.focus.addEventListener('focus', reload);
  return () => {
    off();
    deps.focus.removeEventListener('focus', reload);
  };
}

const onGameToolsRev = (fn: () => void) => useStore.subscribe((s, prev) => { if (s.gameToolsRev !== prev.gameToolsRev) fn(); });

export function useGameTools(opts: { enabled?: boolean } = {}) {
  const { enabled = true } = opts;
  const [status, setStatus] = useState<GameToolsStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    api.gameTools.status().then((s) => { setStatus(s); setError(null); }, (e: Error) => setError(e.message));
  }, []);
  useEffect(() => {
    if (!enabled) return;
    reload();
    return watchGameTools(reload, { onRev: onGameToolsRev, focus: window });
  }, [enabled, reload]);
  return { status, error, reload, set: setStatus };
}
