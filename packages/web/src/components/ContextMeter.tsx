import type { ContextUsage } from '@pocketrocket/shared';
import { useStore } from '../store';
import { contextKey, contextMeterProps } from '../lib/context';
import { Meter } from './ui';

export function ContextMeterView({ usage, className }: { usage: ContextUsage; className?: string }) {
  return <Meter label="Context" {...contextMeterProps(usage)} className={className} />;
}

export function ContextMeter({ botId, roomId, className }: { botId: string; roomId: string | undefined; className?: string }) {
  const usage = useStore((s) => (roomId ? s.contexts[contextKey(botId, roomId)] : undefined));
  if (!usage) return null;
  return <ContextMeterView usage={usage} className={className} />;
}
