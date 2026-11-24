import { useMediaUrl } from '../lib/media';
import { DialogCloseButton, DialogShell, DialogTitle } from './ui';

/** The one full-size picture viewer: attached pictures and look-backs both open here. */
export function ImageLightbox({ mediaRef, alt = 'Attached picture', onClose }: { mediaRef: string; alt?: string; onClose: () => void }) {
  const url = useMediaUrl(mediaRef);
  return (
    <DialogShell open onOpenChange={(o) => !o && onClose()} className="max-h-[92vh] max-w-[92vw] overflow-hidden bg-transparent p-0 shadow-none">
      <DialogTitle className="sr-only">{alt}</DialogTitle>
      {url && <img src={url} alt={alt} className="block max-h-[92vh] max-w-[92vw] rounded-lg object-contain" />}
      <div className="absolute right-2 top-2"><DialogCloseButton /></div>
    </DialogShell>
  );
}
