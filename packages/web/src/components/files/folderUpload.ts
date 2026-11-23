import { MAX_FILE_UPLOAD_BYTES, MAX_FOLDER_UPLOAD_FILES, folderUploadSkip, isValidFileName } from '@pocketrocket/shared';

export interface PickedFile {
  rel: string;
  file: File;
}

export interface Gathered {
  files: PickedFile[];
  dirs: string[];
  junk: number;
  secrets: string[];
  badNames: string[];
  overCap: boolean;
  full: Set<string>;
}

/** iOS and Android show the attribute but pick files (or nothing). */
export const canPickFolder: boolean = (() => {
  if (typeof document === 'undefined' || typeof navigator === 'undefined') return false;
  if (!('webkitdirectory' in document.createElement('input'))) return false;
  const ua = navigator.userAgent;
  const iPadOS = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  return !/iPhone|iPad|iPod|Android/i.test(ua) && !iPadOS;
})();

class Collector {
  readonly g: Gathered = { files: [], dirs: [], junk: 0, secrets: [], badNames: [], overCap: false, full: new Set() };

  private mark(rel: string) {
    const parts = rel.split('/');
    for (let i = 1; i < parts.length; i++) this.g.full.add(parts.slice(0, i).join('/'));
  }

  dir(rel: string, name: string): boolean {
    if (folderUploadSkip(name, true)) { this.g.junk++; this.mark(rel); return false; }
    if (!isValidFileName(name)) { this.g.badNames.push(rel + '/'); this.mark(rel); return false; }
    this.g.dirs.push(rel);
    return true;
  }

  file(rel: string, name: string, file: () => File | Promise<File>): boolean | Promise<boolean> {
    this.mark(rel);
    const skip = folderUploadSkip(name, false);
    if (skip === 'junk') { this.g.junk++; return true; }
    if (skip === 'secret') { this.g.secrets.push(rel); return true; }
    if (!isValidFileName(name)) { this.g.badNames.push(rel); return true; }
    if (this.g.files.length >= MAX_FOLDER_UPLOAD_FILES) { this.g.overCap = true; return false; }
    const f = file();
    if (f instanceof Promise) return f.then((got) => { this.g.files.push({ rel, file: got }); return true; });
    this.g.files.push({ rel, file: f });
    return true;
  }
}

/** Empty folders don't come through <input webkitdirectory>. */
export function gatherFromInput(picked: File[]): Gathered {
  const c = new Collector();
  const kept = new Set<string>();
  const dropped = new Set<string>();
  outer: for (const f of picked) {
    const parts = (f.webkitRelativePath || f.name).split('/').filter(Boolean);
    for (let i = 0; i < parts.length - 1; i++) {
      const rel = parts.slice(0, i + 1).join('/');
      if (dropped.has(rel)) continue outer;
      if (kept.has(rel)) continue;
      if (!c.dir(rel, parts[i])) { dropped.add(rel); continue outer; }
      kept.add(rel);
    }
    if (c.file(parts.join('/'), parts[parts.length - 1], () => f) === false) break;
  }
  return c.g;
}

function readAll(dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = dir.createReader();
  const out: FileSystemEntry[] = [];
  // readEntries hands them over in batches (100 in Chrome) until an empty one.
  return new Promise((resolve, reject) => {
    const next = () => reader.readEntries((batch) => {
      if (!batch.length) return resolve(out);
      out.push(...batch);
      next();
    }, reject);
    next();
  });
}
const fileOf = (e: FileSystemFileEntry) => new Promise<File>((resolve, reject) => e.file(resolve, reject));

/** Entries must be taken with `webkitGetAsEntry()` while the drop event is running. */
export async function gatherFromDrop(entries: FileSystemEntry[]): Promise<Gathered> {
  const c = new Collector();
  const walk = async (entry: FileSystemEntry, rel: string): Promise<boolean> => {
    if (entry.isDirectory) {
      if (!c.dir(rel, entry.name)) return true;
      const children = await readAll(entry as FileSystemDirectoryEntry);
      for (const child of children) if (!(await walk(child, rel + '/' + child.name))) return false;
      return true;
    }
    if (entry.isFile) return c.file(rel, entry.name, () => fileOf(entry as FileSystemFileEntry));
    return true;
  };
  for (const e of entries) if (!(await walk(e, e.name))) break;
  return c.g;
}

export function emptyDirs(g: Gathered): string[] {
  const empty = g.dirs.filter((d) => !g.full.has(d));
  return empty.filter((d) => !empty.some((o) => o.startsWith(d + '/')));
}

export const tooBig = (f: PickedFile) => f.file.size > MAX_FILE_UPLOAD_BYTES;

export function splitRel(rel: string): [string, string] {
  const i = rel.lastIndexOf('/');
  return i < 0 ? ['', rel] : [rel.slice(0, i), rel.slice(i + 1)];
}
