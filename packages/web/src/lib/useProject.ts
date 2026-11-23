import { useEffect } from 'react';
import type { Bot, ProjectOverview } from '@pocketrocket/shared';
import { useStore, botById } from '../store';
import { useLayout } from './layout';
import { projectOfRoom } from './projects';
import type { ProjectInfo } from './api';

export function useToki(): boolean {
  const layout = useLayout();
  const device = useStore((s) => s.device);
  return layout === 'toki' && !device;
}

export function useActiveProject(): ProjectInfo | null {
  const toki = useToki();
  const project = useStore((s) => projectOfRoom(s.projects, s.activeRoomId));
  return toki ? project : null;
}

export function useOverview(slug: string | null | undefined): ProjectOverview | null | undefined {
  const overview = useStore((s) => (slug ? s.overviews[slug] : undefined));
  const known = useStore((s) => !!slug && slug in s.overviews);
  const load = useStore((s) => s.loadOverview);
  useEffect(() => {
    if (slug && !known) void load(slug);
  }, [slug, known, load]);
  return slug ? overview : null;
}

export function revealMessage(messageId: string, tries = 40): void {
  const step = (left: number) => {
    const el = document.querySelector('[data-msg="' + CSS.escape(messageId) + '"]')?.firstElementChild;
    if (el) {
      el.scrollIntoView({ block: 'center' });
      return;
    }
    if (left > 0) setTimeout(() => step(left - 1), 50);
  };
  requestAnimationFrame(() => step(tries));
}

export function useMapDrawing(slug: string): { bot: Bot | null; phase: 'sent' | 'done' | null; running: boolean } {
  const ask = useStore((s) => s.mapAsks[slug]);
  const bots = useStore((s) => s.bots);
  const running = useStore((s) => !!ask && Object.values(s.streaming).some((t) => t.botId === ask.botId && t.roomId === ask.roomId));
  return { bot: ask ? botById(bots, ask.botId) ?? null : null, phase: ask?.phase ?? null, running };
}
