import { useSyncExternalStore } from 'react';
import { getItem, setItem } from './persist';

export type Layout = 'classic' | 'toki';

export const LAYOUT_KEY = 'pocketrocket.layout';
export const LAYOUT_PREVIEW_KEY = 'pocketrocket.layoutPreview';

export function parseLayout(raw: string | null): Layout {
  return raw === 'classic' ? 'classic' : 'toki';
}

type LayoutSetting = 'auto' | 'toki' | 'classic' | undefined;

export function layoutFromSetting(setting: LayoutSetting): Layout {
  return setting === 'classic' ? 'classic' : 'toki';
}

export function layoutToMigrate(setting: LayoutSetting): Layout | null {
  return (setting ?? 'auto') === 'auto' && getItem(LAYOUT_KEY) === 'classic' ? 'classic' : null;
}

/** The hash, which holds the token, is never read here. */
export function asksForPreview(search: string): boolean {
  return new URLSearchParams(search).get('layout') === 'preview';
}

const listeners = new Set<() => void>();
let current: Layout = parseLayout(getItem(LAYOUT_KEY));

function apply(layout: Layout) {
  if (typeof document !== 'undefined') document.documentElement.dataset.layout = layout;
}

export function getLayout(): Layout {
  return current;
}

export function setLayout(next: Layout): void {
  if (next === current) return;
  current = next;
  setItem(LAYOUT_KEY, next);
  apply(next);
  for (const l of listeners) l();
}

export function layoutSwitchShown(): boolean {
  return true;
}

export function initLayout(): void {
  apply(current);
  try {
    if (!asksForPreview(window.location.search)) return;
    setItem(LAYOUT_PREVIEW_KEY, '1');
    const params = new URLSearchParams(window.location.search);
    params.delete('layout');
    const query = params.toString();
    window.history.replaceState(window.history.state, '', window.location.pathname + (query ? '?' + query : '') + window.location.hash);
  } catch {
    // No window or no history (tests, a sandboxed frame): the switch just stays hidden.
  }
}

export function subscribeLayout(onChange: () => void) {
  listeners.add(onChange);
  return () => { listeners.delete(onChange); };
}

export function useLayout(): Layout {
  return useSyncExternalStore(subscribeLayout, getLayout, getLayout);
}
