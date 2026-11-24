import type { Room } from '@pocketrocket/shared';
import { useStore } from '../store';
import { desktopCan } from '../lib/auth';
import { gameStrip } from '../lib/gameTools';
import { projectOfRoom } from '../lib/projects';
import { openStudio, useGameTools } from '../lib/useGameTools';
import { Badge, Button } from './ui';

/**
 * A game room's compact line (spec §2 UI): "Blender idle 3 min · Studio not open [Open Studio]". Re-read on
 * `game-tools.changed` and window focus, never on a timer.
 */
export function GameToolsStrip({ room }: { room: Room }) {
  const device = useStore((s) => s.device);
  const game = useStore((s) => projectOfRoom(s.projects, room.id)?.kind === 'game');
  const openDialog = useStore((s) => s.openDialog);
  const { status } = useGameTools({ enabled: game && !device });
  const strip = game && !device && status ? gameStrip(status) : null;
  if (!strip || !status) return null;
  const launcher = desktopCan('studio') && status.studio.reason === 'not-running';
  return (
    <div role="group" aria-label="Game tools" className="flex min-h-10 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-line px-5 py-1.5 text-hint max-md:pl-14">
      <Badge tone={strip.blender.tone}>{strip.blender.text}</Badge>
      <span aria-hidden className="text-dim">·</span>
      <Badge tone={strip.studio.tone}>{strip.studio.text}</Badge>
      <span className="ml-auto flex items-center gap-1.5">
        {launcher && <Button size="sm" onClick={openStudio}>Open Studio</Button>}
        {strip.needsFix && <Button size="sm" variant="ghost" onClick={() => openDialog({ kind: 'settings', section: 'game-tools' })}>Fix in Settings</Button>}
      </span>
    </div>
  );
}
