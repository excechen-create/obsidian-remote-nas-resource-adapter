import { AdapterError } from './errors';
export interface Mapping { windowsRoot: string; webdavRoot: string }
export interface ResolvedResource { key: string; url: string; extension: 'png' | 'jpg' | 'jpeg' | 'webp' }
interface WindowsPath { drive: string; parts: string[] }
const invalid = (message: string): never => { throw new AdapterError('PATH', message); };
function checkSegment(part: string): string {
  if (part === '..') return invalid('Parent traversal is not accepted');
  if (/[\x00-\x1f\x7f<>:"|?*]/.test(part) || /[. ]$/.test(part)) return invalid('Invalid Windows segment');
  if (/%[0-9a-f]{2}/i.test(part)) return invalid('Ambiguous nested encoding');
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) return invalid('Reserved Windows name');
  return part;
}
/** Parse before URL construction: WHATWG URL would silently remove dot segments. */
export function parseWindowsPath(source: string, resourcePrefix?: string): WindowsPath {
  let text = source;
  let encoded = false;
  if (resourcePrefix && resourcePrefix !== 'file:///' && text.startsWith(resourcePrefix)) {
    const prefix = new URL(resourcePrefix);
    if (prefix.protocol !== 'app:' || prefix.pathname !== '/' || prefix.search || prefix.hash)
      return invalid('Invalid host resource prefix');
    text = text.slice(resourcePrefix.length).replace(/^\//, ''); encoded = true;
  } else if (/^file:/i.test(text)) {
    const match = /^file:\/\/(?:localhost)?\/(.*)$/i.exec(text);
    if (!match) return invalid('Only local file URLs are accepted');
    text = match[1]!; encoded = true;
  } else if (!/^[a-z]:[\\/]/i.test(text)) return invalid('Expected an absolute Windows path');
  if (encoded) {
    if (/[?#]/.test(text) || /%(?![0-9a-f]{2})/i.test(text)) return invalid('Ambiguous file URI');
    try { text = decodeURIComponent(text); } catch { return invalid('Invalid UTF-8 encoding'); }
  }
  if (!/^[a-z]:[\\/]/i.test(text)) return invalid('UNC, relative and device paths are unsupported');
  const drive = text[0]!.toUpperCase();
  const parts: string[] = [];
  for (const part of text.slice(3).split(/[\\/]+/)) {
    if (!part || part === '.') continue;
    parts.push(checkSegment(part));
  }
  return { drive, parts };
}
function webdavParts(root: string): string[] {
  if (!root.startsWith('/') || root.startsWith('//') || /[\\?#\x00-\x1f\x7f]/.test(root))
    throw new AdapterError('PATH', 'WebDAV root must be an absolute, unencoded path');
  return root.split('/').filter(Boolean).map(part => {
    if (part === '.' || part === '..' || /%[0-9a-f]{2}/i.test(part))
      throw new AdapterError('PATH', 'Ambiguous WebDAV root');
    return part;
  });
}
export function checkedOrigin(endpoint: string): string {
  const origin = new URL(endpoint);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash)
    throw new AdapterError('HOST', 'Only an HTTPS origin without credentials is accepted');
  return origin.origin;
}
export function resolveResource(source: string, endpoint: string, mappings: readonly Mapping[], resourcePrefix?: string): ResolvedResource {
  const origin = checkedOrigin(endpoint);
  const path = parseWindowsPath(source, resourcePrefix);
  const candidates = mappings.map(mapping => ({ mapping, root: parseWindowsPath(mapping.windowsRoot), remote: webdavParts(mapping.webdavRoot) }))
    .filter(({ root }) => root.drive === path.drive && root.parts.length < path.parts.length &&
      root.parts.every((part, index) => part.toLowerCase() === path.parts[index]?.toLowerCase()))
    .sort((a, b) => b.root.parts.length - a.root.parts.length);
  if (!candidates.length) throw new AdapterError('UNMAPPED');
  const best = candidates[0]!;
  if (candidates[1]?.root.parts.length === best.root.parts.length) throw new AdapterError('PATH', 'Ambiguous duplicate roots');
  const suffix = path.parts.slice(best.root.parts.length);
  const extension = suffix.at(-1)!.split('.').at(-1)!.toLowerCase();
  if (!['png', 'jpg', 'jpeg', 'webp'].includes(extension)) throw new AdapterError('IMAGE', 'Unsupported image extension');
  const url = `${origin}/${[...best.remote, ...suffix].map(encodeURIComponent).join('/')}`;
  if (new URL(url).origin !== origin) throw new AdapterError('HOST');
  return { key: url, url, extension: extension as ResolvedResource['extension'] };
}
