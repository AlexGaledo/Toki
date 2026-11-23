import type { Bot } from '@pocketrocket/shared';

const LEAD_RE = /(^|-)(lead|chief|coordinator|router|pm)(-|$)/i;

export function pickCoordinator(members: Bot[]): Bot | null {
  return members.find((b) => LEAD_RE.test(b.handle)) ?? members.find((b) => /\b(lead|coordinator|chief)\b/i.test(b.title)) ?? members[0] ?? null;
}
