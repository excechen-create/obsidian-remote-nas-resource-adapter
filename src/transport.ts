import { AdapterError } from './errors';
import { checkedImage, type ImageData } from './images';
export interface HttpRequest { url: string; method: 'GET'; headers: Record<string,string>; throw: false }
export interface HttpResponse { status: number; headers: Record<string,string>; arrayBuffer: ArrayBuffer }
export type Requester = (request: HttpRequest) => Promise<HttpResponse>;
export interface LoadContext { signal?: AbortSignal }
export type Loader = (url: string, context?: LoadContext) => Promise<ImageData>;
/** Deliberately unusable with credentials until a later, separately reviewed NAS milestone. */
export const realNasLoader: Loader = async () => { throw new AdapterError('NAS_DISABLED'); };
/** Loopback test helper: an injected requester allows deterministic status and credential tests. */
export function createTestHttpLoader(request: Requester, origin: string, authorization: () => string | null, maxBytes: number): Loader {
  const allowed = new URL(origin);
  if (allowed.protocol !== 'http:' || allowed.hostname !== '127.0.0.1' || allowed.username || allowed.password || allowed.pathname !== '/')
    throw new AdapterError('HOST');
  return async url => {
    const target = new URL(url);
    if (target.origin !== allowed.origin || target.username || target.password) throw new AdapterError('HOST');
    const token = authorization();
    let result: HttpResponse;
    try { result = await request({ url, method: 'GET', headers: token ? { Authorization: token } : {}, throw: false }); }
    catch { throw new AdapterError('NETWORK'); }
    if (result.status === 401 || result.status === 403) throw new AdapterError('AUTH');
    if (result.status === 404) throw new AdapterError('NOT_FOUND');
    if (result.status !== 200) throw new AdapterError('HTTP');
    return checkedImage(result.arrayBuffer, Object.entries(result.headers).find(([key]) => key.toLowerCase() === 'content-type')?.[1] ?? '', maxBytes);
  };
}
