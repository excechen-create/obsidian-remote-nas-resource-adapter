import { afterEach, describe, expect, it, vi } from 'vitest';
import { DomAdapter } from '../src/dom-adapter';
import { ResourcePool } from '../src/resources';
import { resolveResource } from '../src/paths';
import type { ImageData } from '../src/images';
const image: ImageData={bytes:new ArrayBuffer(10),mime:'image/png'};
const first='file:///C:/NAS-PoC/images/first.png',second='file:///C:/NAS-PoC/images/second.png';
const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
function setup(options={}) {
  document.body.replaceChildren();
  const pending=new Map<string,(data:ImageData)=>void>();
  const load=vi.fn((url:string)=>new Promise<ImageData>(resolve=>pending.set(url,resolve)));
  let id=0;const revoke=vi.fn();
  const pool=new ResourcePool(load,{idleBytes:0,...options},{create:()=>`blob:mock-${++id}`,revoke});
  const adapter=new DomAdapter(document,pool,source=>resolveResource(source,'https://nas.example',[{windowsRoot:'C:/NAS-PoC/images',webdavRoot:'/images'}]));
  const root=document.createElement('div');root.innerHTML='<div class="markdown-preview-view"></div>';document.body.append(root);adapter.attach(root);
  const preview=root.firstElementChild!;
  const add=(src=first,parent=preview)=>{const img=document.createElement('img');img.src=src;parent.append(img);return img;};
  return {pool,adapter,root,preview,add,pending,load,revoke,resolve:(name='first.png')=>pending.get(`https://nas.example/images/${name}`)!(image)};
}
afterEach(()=>{document.body.replaceChildren();vi.useRealTimers();});
describe('DOM bindings independent of shared requests and cached URLs',()=>{
  it('matrix+viewer share transport, own leases, and viewer close preserves matrix URL',async()=>{
    const s=setup();const matrix=s.add();const modal=document.createElement('div');modal.className='modal-container';
    modal.innerHTML='<div class="modal vml-viewer"><img class="vml-viewer__image"></div>';document.body.append(modal);
    const viewer=modal.querySelector('img')!;viewer.src=first;await flush();
    expect(s.load).toHaveBeenCalledTimes(1);expect(s.pool.stats().refs).toBe(2);s.resolve();await flush();
    expect(viewer.src).toBe(matrix.src);expect(matrix.src).toMatch(/^blob:/);
    modal.remove();await flush();expect(s.pool.stats().refs).toBe(1);expect(s.revoke).not.toHaveBeenCalled();
    matrix.remove();await flush();expect(s.pool.stats().refs).toBe(0);expect(s.revoke).toHaveBeenCalledTimes(1);s.adapter.dispose();s.pool.dispose();
  });
  it('viewer reuses image node; rapid note switch+close isolates late responses',async()=>{
    const s=setup();const matrix=s.add();const modal=document.createElement('div');modal.className='modal-container';
    modal.innerHTML='<div class="vml-viewer"><img class="vml-viewer__image"></div>';document.body.append(modal);
    const viewer=modal.querySelector('img')!;viewer.src=first;await flush();
    viewer.src=second;matrix.remove();await flush();expect(s.load).toHaveBeenCalledTimes(2);
    const newNote=s.add(second);await flush();modal.remove();await flush();expect(s.pool.stats().refs).toBe(1);
    s.resolve();await flush();expect(newNote.src).toContain('second.png');expect(viewer.src).toContain('second.png');
    s.resolve('second.png');await flush();expect(newNote.src).toMatch(/^blob:/);expect(viewer.src).not.toMatch(/^blob:/);
    expect(s.pool.stats().refs).toBe(1);s.adapter.dispose();s.pool.dispose();expect(s.revoke).toHaveBeenCalledTimes(2);
  });
  it('source changes before MutationObserver runs cannot accept the stale promise result',async()=>{
    const s=setup();const img=s.add();await flush();s.resolve();img.src=second;await flush();
    expect(img.src).toContain('second.png');s.resolve('second.png');await flush();expect(img.src).toMatch(/^blob:/);
    s.adapter.dispose();s.pool.dispose();
  });
  it('note rerender and src reset reuse cached resource without repeated downloads',async()=>{
    const s=setup({idleBytes:100});const img=s.add();await flush();s.resolve();await flush();const url=img.src;
    img.src=first;await flush();expect(img.src).toBe(url);
    img.remove();const replacement=s.add();await flush();expect(replacement.src).toBe(url);expect(s.load).toHaveBeenCalledTimes(1);
    s.adapter.dispose();s.pool.dispose();
  });
  it('moves between observed containers without double binding or early revocation',async()=>{
    const s=setup();const img=s.add();await flush();s.resolve();await flush();const url=img.src;
    const root2=document.createElement('div');root2.className='markdown-preview-view';document.body.append(root2);s.adapter.attach(root2);
    root2.append(img);await flush();expect(img.src).toBe(url);expect(s.pool.stats().refs).toBe(1);expect(s.revoke).not.toHaveBeenCalled();
    s.adapter.dispose();s.pool.dispose();
  });
  it('ignores unrelated nodes, vault images, video, ordinary LP and hidden measurements',async()=>{
    const s=setup();s.add('app://vault/internal.png');
    const outside=document.createElement('img');outside.src=first;document.body.append(outside);
    const source=document.createElement('div');source.className='markdown-source-view';source.innerHTML=`<img src="${first}"><div class="vml-wrap-measure"><div class="vml-layout"><img src="${first}"></div></div>`;s.root.append(source);
    const video=document.createElement('video');video.src=first;s.preview.append(video);await flush();
    expect(s.load).not.toHaveBeenCalled();s.adapter.dispose();s.pool.dispose();
  });
  it('mode switch releases hidden source layout but adapts visible Reading View',async()=>{
    const s=setup();const source=document.createElement('div');source.className='markdown-source-view';source.innerHTML='<div class="vml-layout"></div>';s.root.append(source);
    const img=s.add(first,source.firstElementChild!);await flush();s.resolve();await flush();expect(img.src).toMatch(/^blob:/);
    source.style.display='none';await flush();expect(s.pool.stats().refs).toBe(0);expect(img.src).toBe(first);
    s.adapter.dispose();s.pool.dispose();
  });
  it('disposing restores original attributes/src and prevents reattachment or stale writes',async()=>{
    const s=setup();const img=s.add();img.title='original';await flush();s.resolve();await flush();
    s.adapter.dispose();s.pool.dispose();expect(img.src).toBe(first);expect(img.title).toBe('original');expect(img.hasAttribute('data-nas-state')).toBe(false);
    s.add();await flush();expect(s.adapter.stats()).toEqual({scopes:0,bindings:0});expect(s.pool.stats().refs).toBe(0);
  });
  it('backpressure error markers are removed on unload',async()=>{
    const s=setup({maxEntries:0});const img=s.add();await flush();expect(img.dataset.nasError).toBe('BUSY');
    s.adapter.dispose();s.pool.dispose();expect(img.hasAttribute('data-nas-state')).toBe(false);expect(img.hasAttribute('data-nas-error')).toBe(false);
  });
});
