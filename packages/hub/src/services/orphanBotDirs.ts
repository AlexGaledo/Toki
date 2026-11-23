import fs from 'node:fs';
import path from 'node:path';

export const BOT_ID_DIR = /^[A-Za-z0-9_-]{6,64}$/;

export function findOrphanBotDirs(botsDir: string, botIds: Iterable<string>): string[] {
  const live = new Set(botIds);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(botsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && BOT_ID_DIR.test(e.name) && !live.has(e.name))
    .map((e) => e.name)
    .sort();
}

export function reportOrphanBotDirs(botsDir: string, botIds: Iterable<string>, log: (s: string) => void = console.log): number {
  const n = findOrphanBotDirs(botsDir, botIds).length;
  if (n) log('[bots] ' + n + ' folder' + (n === 1 ? '' : 's') + ' in ' + botsDir + ' belong to no bot; run `node scripts/prune-orphan-bot-dirs.mjs` to review and move them to data/trash');
  return n;
}
