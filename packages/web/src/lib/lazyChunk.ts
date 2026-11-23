import { getItem, removeItem, setItem } from './persist';

const KEY = 'pocketrocket.chunk-reloaded';

/**
 * After a hub update the hashed chunk a tab asks for can be gone (the service worker caches /assets/*): reload once,
 * unless `canReload()` says unsaved work would be lost.
 */
export function importChunk<T>(load: () => Promise<T>, canReload: () => boolean = () => true, reload: () => void = () => location.reload()): Promise<T> {
  return load().then(
    (m) => { removeItem(KEY, 'session'); return m; },
    (err: unknown) => {
      if (canReload() && getItem(KEY, 'session') !== '1') {
        setItem(KEY, '1', 'session');
        reload();
        return new Promise<T>(() => undefined);
      }
      throw err;
    },
  );
}
