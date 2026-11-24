import { useCallback, useEffect, useState } from 'react';
import type { GameToolsStatus } from '@pocketrocket/shared';
import { api } from './api';

/** I1: the desktop shell launches Studio from this exact URL; the page gets no answer, so status is re-read after. */
export function openStudio(): void {
  window.open(location.origin + '/?launch=studio', '_blank');
}

/**
 * `GET /api/game-tools`, re-read when the window regains focus (Studio or Blender change outside Toki) and, with
 * `everyMs`, on a timer: there is no WS event for it.
 */
export function useGameTools(opts: { enabled?: boolean; everyMs?: number } = {}) {
  const { enabled = true, everyMs } = opts;
  const [status, setStatus] = useState<GameToolsStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    api.gameTools.status().then((s) => { setStatus(s); setError(null); }, (e: Error) => setError(e.message));
  }, []);
  useEffect(() => {
    if (!enabled) return;
    reload();
    window.addEventListener('focus', reload);
    const timer = everyMs ? setInterval(() => { if (document.visibilityState === 'visible') reload(); }, everyMs) : null;
    return () => {
      window.removeEventListener('focus', reload);
      if (timer) clearInterval(timer);
    };
  }, [enabled, everyMs, reload]);
  return { status, error, reload, set: setStatus };
}
