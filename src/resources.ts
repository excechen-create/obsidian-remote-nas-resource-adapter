import { AdapterError } from './errors';
import type { Loader } from './transport';
import { RequestQueue } from './request-queue';
export interface ResourceLease { result: Promise<string>; release(): void }
export interface ObjectUrls { create(data: Blob): string; revoke(url: string): void }
export interface PoolOptions { idleBytes: number; totalBytes: number; maxImageBytes: number; timeoutMs: number; cooldownMs: number; concurrency: number; maxEntries: number }
export const defaults: PoolOptions = { idleBytes: 32*1024*1024, totalBytes:64*1024*1024, maxImageBytes: 20*1024*1024, timeoutMs: 20000, cooldownMs: 5000, concurrency: 2, maxEntries: 128 };
interface Entry {
  refs: number; result: Promise<string>; url?: string; bytes: number; lastUsed: number;
  pending: boolean; failed: boolean; failedAt: number; timer?: ReturnType<typeof setTimeout>;
  controller: AbortController;
  reject(reason: Error): void;
}
export class ResourcePool {
  private entries = new Map<string,Entry>();
  private stopped = false;
  readonly queue: RequestQueue;
  private options: PoolOptions;
  requestsStarted = 0;
  constructor(private loader: Loader, options: Partial<PoolOptions> = {}, private urls: ObjectUrls = {
    create: data => URL.createObjectURL(data), revoke: url => URL.revokeObjectURL(url)
  }) { this.options = { ...defaults, ...options }; this.queue = new RequestQueue(this.options.concurrency); }
  acquire(key: string, url: string): ResourceLease {
    if (this.stopped) throw new AdapterError('UNLOADED');
    let entry = this.entries.get(key);
    if (entry?.failed && !entry.pending && !entry.refs && Date.now()-entry.failedAt >= this.options.cooldownMs) {
      this.evict(key,entry); entry = undefined;
    }
    if (!entry) {
      this.trim(true);
      if (this.entries.size >= this.options.maxEntries) throw new AdapterError('BUSY');
      entry = this.start(key,url); this.entries.set(key,entry);
    }
    entry.refs++; entry.lastUsed = Date.now();
    const owned = entry;
    let released = false;
    return { result: owned.result, release: () => {
      if (released) return; released = true;
      owned.refs--; owned.lastUsed = Date.now(); this.trim();
    } };
  }
  private start(key: string, url: string): Entry {
    let resolve!: (value: string) => void;
    let reject!: (reason: Error) => void;
    const result = new Promise<string>((yes,no) => { resolve = yes; reject = no; });
    // Lease consumers may disappear before transport settles.
    void result.catch(() => {});
    const entry: Entry = { refs: 0, result, bytes: 0, lastUsed: Date.now(), pending: true, failed: false, failedAt: 0, controller:new AbortController(),
      reject: reason => { if (entry.failed || entry.url) return; entry.failed = true; entry.failedAt = Date.now(); reject(reason); } };
    // This is a UI loading deadline INCLUDING queue wait, not a network cancellation timer.
    entry.timer = setTimeout(() => {entry.reject(new AdapterError('TIMEOUT'));entry.controller.abort();}, this.options.timeoutMs);
    void this.queue.run(async () => {
      if (this.stopped || entry.failed || !entry.refs) throw new AdapterError('UNLOADED');
      this.requestsStarted++; return this.loader(url,{signal:entry.controller.signal});
    }).then(image => {
      if (this.stopped || entry.failed) return;
      if (image.bytes.byteLength > this.options.maxImageBytes) throw new AdapterError('TOO_LARGE');
      this.reserveBytes(image.bytes.byteLength);
      const objectUrl = this.urls.create(new Blob([image.bytes], { type: image.mime }));
      entry.url = objectUrl; entry.bytes = image.bytes.byteLength; resolve(objectUrl);
    }).catch(error => entry.reject(error instanceof AdapterError ? error : new AdapterError('NETWORK')))
      .finally(() => {
        clearTimeout(entry.timer); entry.pending = false; this.trim();
        if (this.stopped) this.evict(key,entry);
      });
    return entry;
  }
  private reserveBytes(bytes: number): void {
    let used=[...this.entries.values()].reduce((n,e)=>n+e.bytes,0);
    const idle=[...this.entries.entries()].filter(([,e])=>!e.refs&&!e.pending&&e.url).sort((a,b)=>a[1].lastUsed-b[1].lastUsed);
    for(const [key,entry] of idle) {
      if(used+bytes<=this.options.totalBytes)break;
      used-=entry.bytes;this.evict(key,entry);
    }
    if(used+bytes>this.options.totalBytes)throw new AdapterError('BUSY');
  }
  private trim(makeRoom = false): void {
    let idleBytes = [...this.entries.values()].filter(e => !e.refs).reduce((sum,e) => sum+e.bytes,0);
    const idle = [...this.entries.entries()].filter(([,e]) => !e.refs && !e.pending).sort((a,b) => a[1].lastUsed-b[1].lastUsed);
    for (const [key,entry] of idle) {
      const expiredError = entry.failed && Date.now()-entry.failedAt >= this.options.cooldownMs;
      if (idleBytes > this.options.idleBytes || expiredError || (makeRoom && this.entries.size >= this.options.maxEntries)) {
        idleBytes -= entry.bytes; this.evict(key,entry);
      }
    }
  }
  private evict(key: string, entry: Entry): void {
    if (entry.url) { this.urls.revoke(entry.url); entry.url = undefined; entry.bytes = 0; }
    if (this.entries.get(key) === entry) this.entries.delete(key);
  }
  stats(): { entries: number; refs: number; urls: number; idleBytes: number; activeBytes: number; inFlight: number; queued: number; requestsStarted: number } {
    const values = [...this.entries.values()];
    return { entries: values.length, refs: values.reduce((n,e) => n+e.refs,0), urls: values.filter(e=>!!e.url).length,
      idleBytes: values.filter(e=>!e.refs).reduce((n,e)=>n+e.bytes,0), activeBytes: values.filter(e=>e.refs).reduce((n,e)=>n+e.bytes,0),
      inFlight: this.queue.active, queued: this.queue.queued, requestsStarted: this.requestsStarted };
  }
  dispose(): void {
    if (this.stopped) return; this.stopped = true; this.queue.dispose();
    for (const [key,entry] of this.entries) {
      clearTimeout(entry.timer); entry.reject(new AdapterError('UNLOADED'));entry.controller.abort();this.evict(key,entry);
    }
  }
}
