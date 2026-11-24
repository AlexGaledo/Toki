import { useState } from 'react';
import type { LookBack } from '../lib/lookBacks';
import { useMediaUrl } from '../lib/media';
import { ImageLightbox } from './ImageLightbox';
import { cn } from './ui';

/**
 * Look-back thumbnails (D2), shown with the work line even while it is folded. Each box has a fixed size before and
 * after the picture loads, so nothing below it moves. They open in the same viewer as attached pictures.
 */
export function LookBacks({ items }: { items: LookBack[] }) {
  const [open, setOpen] = useState<LookBack | null>(null);
  return (
    <>
      <div className="mt-1.5 flex flex-wrap gap-2">
        {items.map((l) => <LookBackThumb key={l.messageId} item={l} onOpen={() => setOpen(l)} />)}
      </div>
      {open && <ImageLightbox mediaRef={open.ref} alt={open.alt} onClose={() => setOpen(null)} />}
    </>
  );
}

function LookBackThumb({ item, onOpen }: { item: LookBack; onOpen: () => void }) {
  const url = useMediaUrl(item.ref);
  const box = 'block h-24 w-32 shrink-0 overflow-hidden rounded-md bg-card2 ring-1 ring-line';
  if (!url) return <div className={box} role="img" aria-label={item.alt + ' (loading)'} />;
  return (
    <button type="button" onClick={onOpen} title="Open larger"
      className={cn(box, 'hover:ring-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent')}>
      <img src={url} alt={item.alt} width={128} height={96} className="h-full w-full object-contain" />
    </button>
  );
}
