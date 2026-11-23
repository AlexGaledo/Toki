import { z } from 'zod';

// Hub token only; a paired device is refused.
export type RoomFolderKind = 'project' | 'room' | 'dm';

export interface FileEntry {
  name: string;
  kind: 'dir' | 'file';
  size: number;
  mtime: number;
  ext: string;
}

export interface FileListing {
  roomId: string;
  folder: RoomFolderKind;
  projectSlug: string | null;
  path: string;
  entries: FileEntry[];
  truncated: boolean;
}

export const MAX_FILE_LIST_ENTRIES = 2000;
export const MAX_FILE_DOWNLOAD_BYTES = 50 * 1024 * 1024;
export const MAX_FILE_UPLOAD_BYTES = 25 * 1024 * 1024;
export const MAX_FILE_NAME_CHARS = 255;

const RelPath = z.string().max(4096);
/** Windows silently drops a trailing space or dot, so such a name would land as another file. */
export function isValidFileName(n: string): boolean {
  return (
    n.length > 0 && n.length <= MAX_FILE_NAME_CHARS && !/[\\/\u0000-\u001f]/.test(n) &&
    n !== '.' && n !== '..' && n.trim() === n && !n.endsWith('.')
  );
}
export const FileNameSchema = z.string().refine(isValidFileName, 'not a valid file name');

export const FileUploadSchema = z.object({
  path: RelPath.default(''),
  name: FileNameSchema,
  dataBase64: z.string().max(Math.ceil(MAX_FILE_UPLOAD_BYTES / 3) * 4 + 4).regex(/^[A-Za-z0-9+/]*={0,2}$/, 'not base64'),
  overwrite: z.boolean().optional(),
  parents: z.boolean().optional(),
});
export type FileUploadInput = z.input<typeof FileUploadSchema>;

export const FileFolderSchema = z.object({ path: RelPath.default(''), name: FileNameSchema, parents: z.boolean().optional() });
export type FileFolderInput = z.input<typeof FileFolderSchema>;

export const FileRenameSchema = z.object({ from: RelPath.min(1), to: RelPath.min(1) });
export type FileRenameInput = z.input<typeof FileRenameSchema>;

export const MAX_FOLDER_UPLOAD_FILES = 1000;
export const MAX_FOLDER_UPLOAD_BYTES = 500 * 1024 * 1024;
export const FOLDER_UPLOAD_CONFIRM_FILES = 200;

const JUNK_DIRS = new Set(['.git', 'node_modules']);
const JUNK_FILES = new Set(['.ds_store', 'thumbs.db']);
const SECRET_RE = /^(\.env.*|id_(rsa|dsa|ecdsa|ed25519).*|service-account.*\.json|.+\.(pem|key|p8|p12|pfx))$/i;
const SECRET_OK_RE = /^\.env\.(example|sample|template)(\..*)?$/i;

export function folderUploadSkip(name: string, isDir: boolean): 'junk' | 'secret' | null {
  const lower = name.toLowerCase();
  if (isDir) return JUNK_DIRS.has(lower) ? 'junk' : null;
  if (JUNK_FILES.has(lower)) return 'junk';
  if (SECRET_RE.test(name) && !SECRET_OK_RE.test(name)) return 'secret';
  return null;
}

export interface FileChangeResult {
  ok: true;
  path: string;
}
