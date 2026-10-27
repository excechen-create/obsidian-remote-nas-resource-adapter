import { AdapterError } from './errors';
interface Queued { run: () => void; reject: (reason: Error) => void }
/** Slots represent actual unsettled transport promises, not UI timeout promises. */
export class RequestQueue {
  private waiting: Queued[] = [];
  private stopped = false;
  active = 0;
  constructor(readonly concurrency = 2, readonly maxQueued = 64) {
    if (concurrency < 1) throw new Error('Invalid concurrency');
  }
  run<T>(task: () => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new AdapterError('UNLOADED'));
    if (this.waiting.length >= this.maxQueued) return Promise.reject(new AdapterError('BUSY'));
    return new Promise((resolve, reject) => {
      this.waiting.push({ reject, run: () => {
        this.active++;
        Promise.resolve().then(task).then(resolve,reject).finally(() => { this.active--; this.pump(); });
      } });
      this.pump();
    });
  }
  private pump(): void {
    while (!this.stopped && this.active < this.concurrency && this.waiting.length) this.waiting.shift()!.run();
  }
  get queued(): number { return this.waiting.length; }
  dispose(): void {
    this.stopped = true;
    for (const pending of this.waiting.splice(0)) pending.reject(new AdapterError('UNLOADED'));
  }
}
