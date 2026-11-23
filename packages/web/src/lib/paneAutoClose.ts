/** No imports, so `node --test` can load it straight from source (packages/web/test). */
export interface PaneAuto {
  inline: boolean;
  autoClosed: boolean;
}

export type PaneAct = 'close' | 'open' | null;

export function paneAutoStep(prev: PaneAuto, inline: boolean, open: boolean): { next: PaneAuto; act: PaneAct } {
  if (prev.inline && !inline && open) return { next: { inline, autoClosed: true }, act: 'close' };
  if (!prev.inline && inline && prev.autoClosed && !open) return { next: { inline, autoClosed: false }, act: 'open' };
  return { next: { inline, autoClosed: prev.autoClosed && !open }, act: null };
}
