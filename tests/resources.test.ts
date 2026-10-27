import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResourcePool } from '../src/resources';
import type { ImageData } from '../src/images';
import { RequestQueue } from '../src/request-queue';
const image = (size = 12): ImageData => ({ bytes:new ArrayBuffer(size),mime:'image/png' });
export function deferred<T>() { let resolve!: (v:T)=>void, reject!: (v:unknown)=>void; const promise = new Promise<T>((a,b)=>{resolve=a;reject=b;}); return { promise,resolve,reject }; }
const flush = async () => { for(let i=0;i<12;i++) await Promise.resolve(); };
function setup(options = {}) {
  let counter=0; const creates=vi.fn(()=>`blob:test-${++counter}`), revokes=vi.fn();
  const pending = new Map<string,ReturnType<typeof deferred<ImageData>>>();
  const loader = vi.fn((url:string) => { const d = deferred<ImageData>(); pending.set(url,d); return d.promise; });
  const pool = new ResourcePool(loader, options,{create:creates,revoke:revokes});
  return {pool,loader,pending,creates,revokes};
}
afterEach(()=>vi.useRealTimers());
describe('independent transport/cache/lease lifetimes', () => {
  it('deduplicates matrix and viewer leases; closing viewer preserves matrix resource', async () => {
    const {pool,loader,pending,revokes}=setup({idleBytes:0});
    const matrix=pool.acquire('a','a'), viewer=pool.acquire('a','a'); await flush();
    expect(loader).toHaveBeenCalledTimes(1); expect(pool.stats().refs).toBe(2);
    pending.get('a')!.resolve(image()); const [a,b]=await Promise.all([matrix.result,viewer.result]);
    expect(a).toBe(b); viewer.release(); viewer.release(); expect(revokes).not.toHaveBeenCalled();
    matrix.release(); await flush(); expect(revokes).toHaveBeenCalledExactlyOnceWith(a); pool.dispose();
  });
  it('logical timeout keeps physical slot and dedup until uncancellable request settles', async () => {
    vi.useFakeTimers(); const {pool,loader,pending,creates}=setup({concurrency:1,timeoutMs:50});
    const a=pool.acquire('a','a'); const failure=expect(a.result).rejects.toMatchObject({code:'TIMEOUT'}); await flush();
    await vi.advanceTimersByTimeAsync(51); await failure;
    const again=pool.acquire('a','a'), b=pool.acquire('b','b');
    await expect(again.result).rejects.toMatchObject({code:'TIMEOUT'});
    expect(pool.stats().inFlight).toBe(1); expect(loader).toHaveBeenCalledTimes(1);
    pending.get('a')!.resolve(image()); await flush();
    expect(creates).not.toHaveBeenCalled(); expect(loader).toHaveBeenCalledTimes(2);
    pending.get('b')!.resolve(image()); await b.result;
    a.release();again.release();b.release();pool.dispose();
  });
  it('unload immediately rejects waiting leases; a late running response creates no URL', async () => {
    const {pool,pending,creates}=setup({concurrency:1});
    const a=pool.acquire('a','a'), b=pool.acquire('b','b'); await flush(); pool.dispose();
    await expect(a.result).rejects.toMatchObject({code:'UNLOADED'});
    await expect(b.result).rejects.toMatchObject({code:'UNLOADED'});
    pending.get('a')!.resolve(image()); await flush();
    expect(creates).not.toHaveBeenCalled(); expect(pool.stats()).toMatchObject({entries:0,urls:0,inFlight:0,queued:0});
    a.release();b.release(); expect(()=>pool.acquire('x','x')).toThrow('UNLOADED');
  });
  it('UI loading deadline includes queue wait; an expired queued job never starts transport',async()=>{
    vi.useFakeTimers();const {pool,pending,loader,creates}=setup({concurrency:1,timeoutMs:20});
    const a=pool.acquire('a','a'),b=pool.acquire('b','b');
    const failures=Promise.all([expect(a.result).rejects.toMatchObject({code:'TIMEOUT'}),expect(b.result).rejects.toMatchObject({code:'TIMEOUT'})]);
    await flush();await vi.advanceTimersByTimeAsync(21);await failures;
    expect(pool.stats()).toMatchObject({inFlight:1,queued:1,requestsStarted:1});
    pending.get('a')!.resolve(image());await flush();expect(loader).toHaveBeenCalledTimes(1);expect(creates).not.toHaveBeenCalled();
    expect(pool.stats()).toMatchObject({inFlight:0,queued:0});a.release();b.release();pool.dispose();
  });
  it('caches released images within byte budget and evicts LRU idle entries only', async () => {
    const {pool,pending,revokes,loader}=setup({idleBytes:12});
    const a=pool.acquire('a','a'); await flush();pending.get('a')!.resolve(image());await a.result;await flush();a.release();
    const again=pool.acquire('a','a');await again.result;expect(loader).toHaveBeenCalledTimes(1);again.release();
    const b=pool.acquire('b','b');await flush();pending.get('b')!.resolve(image());await b.result;await flush();
    expect(revokes).not.toHaveBeenCalled();b.release();expect(revokes).toHaveBeenCalledTimes(1);pool.dispose();
  });
  it('rejects large payload before allocating URL', async () => {
    const {pool,pending,creates}=setup({maxImageBytes:10});const a=pool.acquire('a','a');await flush();
    pending.get('a')!.resolve(image(11));await expect(a.result).rejects.toMatchObject({code:'TOO_LARGE'});
    expect(creates).not.toHaveBeenCalled();a.release();pool.dispose();
  });
  it('bounded entries protect against an unbounded number of retained bindings', async () => {
    const {pool,pending}=setup({maxEntries:1});const a=pool.acquire('a','a');await flush();
    expect(()=>pool.acquire('b','b')).toThrow('BUSY');pending.get('a')!.resolve(image());await a.result;a.release();pool.dispose();
  });
  it('total byte cap preserves active leases and evicts idle data before admitting new data',async()=>{
    const {pool,pending,revokes}=setup({totalBytes:10,idleBytes:10});
    const a=pool.acquire('a','a');await flush();pending.get('a')!.resolve(image(8));const aUrl=await a.result;
    const b=pool.acquire('b','b');await flush();pending.get('b')!.resolve(image(8));await expect(b.result).rejects.toMatchObject({code:'BUSY'});
    expect(revokes).not.toHaveBeenCalled();a.release();b.release();
    const c=pool.acquire('c','c');await flush();pending.get('c')!.resolve(image(8));await c.result;
    expect(revokes).toHaveBeenCalledExactlyOnceWith(aUrl);expect(pool.stats().activeBytes).toBe(8);c.release();pool.dispose();
  });
  it('cooldown reuses failure rather than generating a retry storm', async () => {
    vi.useFakeTimers(); const {pool,pending,loader}=setup({cooldownMs:100});
    const a=pool.acquire('a','a');await flush();pending.get('a')!.reject(new Error('hidden-sensitive-url'));
    await expect(a.result).rejects.toMatchObject({code:'NETWORK'});await flush();a.release();
    const b=pool.acquire('a','a');await expect(b.result).rejects.toMatchObject({code:'NETWORK'});b.release();
    expect(loader).toHaveBeenCalledTimes(1);await vi.advanceTimersByTimeAsync(101);
    const c=pool.acquire('a','a');await flush();expect(loader).toHaveBeenCalledTimes(2);
    pending.get('a')!.resolve(image());await c.result;c.release();pool.dispose();
  });
  it('queue disposal does not pretend to cancel active work', async () => {
    const queue=new RequestQueue(1);const wait=deferred<number>();const a=queue.run(()=>wait.promise);
    const b=queue.run(async()=>2);await flush();queue.dispose();await expect(b).rejects.toThrow('UNLOADED');
    expect(queue.active).toBe(1);wait.resolve(1);expect(await a).toBe(1);await flush();expect(queue.active).toBe(0);
  });
});
