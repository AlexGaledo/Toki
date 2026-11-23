import { getItem, removeItem, setItem, versionedKey } from './persist';

export const DRAFT_SAVE_MS = 400;

const draftKey = (roomId: string) => versionedKey('draft', 1) + '.' + roomId;

export function readDraft(roomId: string): string {
  return getItem(draftKey(roomId)) ?? '';
}

export function writeDraft(roomId: string, text: string): void {
  if (text.trim()) setItem(draftKey(roomId), text);
  else removeItem(draftKey(roomId));
}
