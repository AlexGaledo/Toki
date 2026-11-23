import type { Settings } from '@pocketrocket/shared';
import { setItem } from './persist';

export type ThemeMode = Settings['theme'];

function systemPrefersDark(): boolean {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
}

export function resolveDark(mode: ThemeMode): boolean {
  if (mode === 'dark') return true;
  if (mode === 'light') return false;
  return systemPrefersDark();
}

export function applyTheme(mode: ThemeMode) {
  document.documentElement.classList.toggle('dark', resolveDark(mode));
  setItem('pocketrocket.theme', mode);
}

export function applyFont(font: Settings['font']) {
  document.documentElement.dataset.font = font;
  setItem('pocketrocket.font', font);
}

let mediaListenerAttached = false;
export function watchSystemTheme(getMode: () => ThemeMode) {
  if (mediaListenerAttached) return;
  mediaListenerAttached = true;
  try {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      if (getMode() === 'system') applyTheme('system');
    };
    mq.addEventListener('change', onChange);
  } catch {
    /* ignore */
  }
}
