import { useEffect, useState } from 'react';
import type { ProviderLimitState } from '@pocketrocket/shared';
import { useStore } from '../store';
import { activeLimits } from './limits';

export function useLimits(): ProviderLimitState[] {
  const limits = useStore((s) => s.limits);
  const [now, setNow] = useState(() => Date.now());
  const live = activeLimits(limits, now);
  const next = live.reduce((a, l) => Math.min(a, l.until), Infinity);
  useEffect(() => {
    if (!Number.isFinite(next)) return;
    // setTimeout caps near 24.8 days; a longer wait just re-checks then.
    const t = setTimeout(() => setNow(Date.now()), Math.min(Math.max(0, next - Date.now()) + 250, 2 ** 31 - 1));
    return () => clearTimeout(t);
  }, [next]);
  return live;
}
