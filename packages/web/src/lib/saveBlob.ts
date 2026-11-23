/**
 * Re-typed as octet-stream so the URL is only ever something to save: opened as a page, an HTML or SVG type would
 * run in the app's origin.
 */
export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(new Blob([blob], { type: 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  // A moment's grace for a slow browser before the URL is revoked.
  setTimeout(() => URL.revokeObjectURL(url), 5_000);
}
