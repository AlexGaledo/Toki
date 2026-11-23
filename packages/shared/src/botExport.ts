import { z } from 'zod';
import { BOT_ICON_KEYS, type Bot } from './models.js';
import { MAX_BOT_DESCRIPTION_CHARS } from './protocol.js';

/**
 * Every object is strict: an unknown field is an error, so a file cannot smuggle settings in next to the checked
 * ones. Holds nothing machine- or account-specific: no tokens, keys, rules, rooms or paths.
 */
export const BOT_EXPORT_FORMAT = 'pocketrocket.bot';
export const BOT_EXPORT_VERSION = 1;
export const MAX_BOT_EXPORT_BYTES = 1024 * 1024;
export const MAX_EXPORT_SKILLS = 20;
export const MAX_EXPORT_SKILL_BYTES = 64 * 1024;
export const MAX_EXPORT_MEMORY_BYTES = 8 * 1024;

/** Device names Windows will not let a folder have (a skill is a folder named after it). */
export const WINDOWS_RESERVED_NAME = /^(con|nul|aux|prn|com[1-9]|lpt[1-9])$/;

const withinBytes = (max: number) => (s: string) => new TextEncoder().encode(s).length <= max;

export const BotExportSkillSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{1,48}$/, 'skill names use lowercase letters, digits and dashes').refine((n) => !WINDOWS_RESERVED_NAME.test(n), 'that skill name is reserved on Windows'),
  description: z.string().min(1).max(300),
  markdown: z.string().refine(withinBytes(MAX_EXPORT_SKILL_BYTES), 'a skill is over 64 KB'),
}).strict();

export const BotExportSchema = z.object({
  format: z.literal(BOT_EXPORT_FORMAT),
  version: z.literal(BOT_EXPORT_VERSION),
  exportedAt: z.number().int().nonnegative().optional(),
  bot: z.object({
    name: z.string().min(1).max(40),
    handle: z.string().regex(/^[a-z0-9_-]{2,24}$/),
    title: z.string().max(80).default(''),
    description: z.string().max(MAX_BOT_DESCRIPTION_CHARS).default(''),
    avatar: z.enum([...BOT_ICON_KEYS, '']).default(''),
  }).strict(),
  skills: z.array(BotExportSkillSchema).max(MAX_EXPORT_SKILLS).default([]),
  memory: z.string().refine(withinBytes(MAX_EXPORT_MEMORY_BYTES), 'memory is over 8 KB').optional(),
}).strict();
export type BotExport = z.infer<typeof BotExportSchema>;

export interface BotExportResult {
  file: BotExport;
  redactions: number;
  skipped: { name: string; reason: 'too_big' | 'too_many' }[];
}

export interface BotImportResult {
  bot: Bot;
  handleRenamed: boolean;
  skills: { name: string; renamed: boolean }[];
  memoryImported: boolean;
}
