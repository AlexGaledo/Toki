import { useStore } from '../store';
import { useLayout } from './layout';

export function useNewLayout(): boolean {
  const device = useStore((s) => s.device);
  return useLayout() === 'toki' && !device;
}
