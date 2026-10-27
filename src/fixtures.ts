import { AdapterError } from './errors';
import type { Loader } from './transport';
import {fixturePng} from './fixture-image';
export const fixtureOrigin = 'https://nas-poc.invalid';
export const fixtureMappings = [{windowsRoot:'C:\\NAS-PoC\\images',webdavRoot:'/fixtures'}];
// Generated test image only; no filesystem or network access in the synthetic loader.
export function syntheticLoader(delay: () => number): Loader {
  const allowed = new Set(['中文 图片.png','second.png']);
  return async url => {
    const target=new URL(url);
    if(target.origin!==fixtureOrigin || target.search || target.hash || !target.pathname.startsWith('/fixtures/'))throw new AdapterError('NAS_DISABLED');
    if(!allowed.has(decodeURIComponent(target.pathname.slice('/fixtures/'.length))))throw new AdapterError('NOT_FOUND');
    await new Promise(resolve=>setTimeout(resolve,delay()));
    return {bytes:Uint8Array.from(atob(fixturePng),v=>v.charCodeAt(0)).buffer,mime:'image/png'};
  };
}
