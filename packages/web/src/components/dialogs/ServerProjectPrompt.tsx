import { Server } from 'lucide-react';
import { useStore } from '../../store';
import { Button, DialogDescription, DialogShell, DialogTitle, cn } from '../ui';

/**
 * D4: a Server project opened while the server is offline, or outside the desktop app. The state machine is
 * `promptStep` in lib/hosts.ts; this only draws it. Stacked, so it also opens over Settings › Projects.
 */
export function ServerProjectPrompt() {
  const prompt = useStore((s) => s.serverPrompt);
  const connect = useStore((s) => s.promptConnect);
  const close = useStore((s) => s.closePrompt);
  if (!prompt) return null;
  const { stub, phase } = prompt;
  const elsewhere = phase === 'elsewhere';
  const status =
    phase === 'working' ? 'Connecting to your server…'
    : phase === 'failed' ? "Couldn't connect. The desktop notification says why."
    : '';
  return (
    <DialogShell open onOpenChange={(o) => { if (!o) close(); }} hasDescription stacked className="w-[440px] p-6">
      <DialogTitle className="flex items-center gap-2">
        <Server size={16} aria-hidden className="shrink-0 text-muted" />
        <span className="min-w-0 [overflow-wrap:anywhere]">{stub.name}</span>
      </DialogTitle>
      <DialogDescription className="mt-2 text-ui leading-relaxed text-muted">
        {elsewhere
          ? 'This project is on your server. Open it from the desktop app, which can connect to your server.'
          : 'This project is on your server. Connect to open it.'}
      </DialogDescription>
      <p role="status" className={cn(status && 'mt-3', 'text-ui', phase === 'failed' ? 'text-bad' : 'text-fg')}>{status}</p>
      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={close}>{elsewhere ? 'Close' : 'Cancel'}</Button>
        {!elsewhere && (
          // aria-disabled, not disabled: a disabled button drops keyboard focus out of the dialog. A press while working is a no-op.
          <Button variant="primary" aria-disabled={phase === 'working' || undefined} className={phase === 'working' ? 'opacity-40' : undefined} onClick={connect}>
            {phase === 'working' ? 'Connecting…' : phase === 'failed' ? 'Try again' : 'Connect'}
          </Button>
        )}
      </div>
    </DialogShell>
  );
}
