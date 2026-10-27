import { errorCode } from './errors';
import type { ResolvedResource } from './paths';
import type { ResourceLease, ResourcePool } from './resources';
type Resolver = (source: string) => ResolvedResource;
interface Binding {
  source: string; lease: ResourceLease; objectUrl?: string; priorTitle: string | null;
  priorState: string | null; priorError: string | null; errorListener: () => void;
}
interface Scope { observer: MutationObserver; kind: 'view' | 'viewer' }
/** Uses DOM only; never accesses AM model, instance, constructors or event handlers. */
export class DomAdapter {
  private scopes = new Map<Element,Scope>();
  private bindings = new Map<HTMLImageElement,Binding>();
  private bodyObserver: MutationObserver;
  private stopped = false;
  constructor(private document: Document, private pool: ResourcePool, private resolve: Resolver) {
    const Observer = document.defaultView!.MutationObserver;
    // Discovery is limited to direct body children (Modal containers), not a global subtree observer.
    this.bodyObserver = new Observer(records => {
      for (const record of records) for (const node of record.addedNodes) this.discoverViewer(node);
      this.sweep();
    });
    this.bodyObserver.observe(document.body,{ childList:true });
    for (const node of document.body.children) this.discoverViewer(node);
  }
  private discoverViewer(node: Node): void {
    if (node.nodeType !== 1) return;
    const element = node as Element;
    const viewer = element.matches('.vml-viewer') ? element : element.querySelector('.vml-viewer');
    if (viewer) this.attach(viewer,'viewer');
  }
  attach(root: Element, kind: 'view' | 'viewer' = 'view'): void {
    if (this.stopped || this.scopes.has(root)) return;
    const observer = new this.document.defaultView!.MutationObserver(records => {
      for (const record of records) {
        if (record.type === 'attributes') {
          if (record.attributeName === 'src' && record.target.nodeName === 'IMG') this.bind(record.target as HTMLImageElement);
          else if ((record.target as Element).matches('.markdown-source-view,.markdown-reading-view,.markdown-preview-view')) this.scan(root);
        } else for (const node of record.addedNodes) if (node.nodeType === 1) this.scan(node as Element);
      }
      this.sweep();
    });
    this.scopes.set(root,{observer,kind});
    observer.observe(root,{ childList:true,subtree:true,attributes:true,attributeFilter:['src','class','style'] });
    this.scan(root);
  }
  detach(root: Element): void {
    this.scopes.get(root)?.observer.disconnect();this.scopes.delete(root);this.sweep();
  }
  scan(root: Element): void {
    if (this.stopped) return;
    if (root.nodeName === 'IMG') this.bind(root as HTMLImageElement);
    for (const img of root.querySelectorAll<HTMLImageElement>('img')) this.bind(img);
  }
  private eligible(image: HTMLImageElement): boolean {
    if (!image.isConnected || this.stopped) return false;
    for (const [root,scope] of this.scopes) {
      if (!root.contains(image)) continue;
      if (scope.kind === 'viewer') return image.matches('.vml-viewer__image');
      const preview = image.closest('.markdown-preview-view');
      const reading = image.closest('.markdown-reading-view') ?? preview;
      if (preview && reading && this.document.defaultView!.getComputedStyle(reading).display !== 'none') return true;
      // AM's existing interactive layout is also the entrance to its viewer.
      // Ordinary Live Preview images and hidden AM measurement copies are excluded.
      const source = image.closest('.markdown-source-view');
      if (source && image.closest('.vml-layout') && !image.closest('.vml-wrap-measure') &&
        this.document.defaultView!.getComputedStyle(source).display !== 'none') return true;
    }
    return false;
  }
  private bind(image: HTMLImageElement): void {
    if (!this.eligible(image)) { this.release(image); return; }
    const source = image.getAttribute('src') ?? '';
    const previous = this.bindings.get(image);
    if (previous && source === previous.objectUrl) return;
    if (previous && source === previous.source) {
      // AM may reset the original source on an existing image during rerender/switch.
      if(previous.objectUrl){image.setAttribute('src',previous.objectUrl);image.dataset.nasState='ready';}
      return;
    }
    this.release(image);
    if (!source) return;
    let resource: ResolvedResource;
    try { resource = this.resolve(source); } catch { return; }
    let lease: ResourceLease;
    try { lease = this.pool.acquire(resource.key,resource.url); } catch (error) {
      // Track failed bindings too, so markers are restored on node reuse/unload.
      lease={result:Promise.reject(error),release:()=>{}};
    }
    const binding: Binding = {source,lease,priorTitle:image.getAttribute('title'),priorState:image.getAttribute('data-nas-state'),
      priorError:image.getAttribute('data-nas-error'),errorListener:()=>{
        if(this.bindings.get(image)===binding && image.getAttribute('src')===binding.objectUrl) {
          image.dataset.nasState='error';image.dataset.nasError='IMAGE';
        }
      }};
    this.bindings.set(image,binding);image.dataset.nasState='loading';delete image.dataset.nasError;
    image.addEventListener('error',binding.errorListener);
    void lease.result.then(url=>{
      if (this.bindings.get(image)!==binding || !this.eligible(image) || image.getAttribute('src')!==source) return;
      binding.objectUrl=url;image.setAttribute('src',url);image.dataset.nasState='ready';
    }).catch(error=>{
      if(this.bindings.get(image)!==binding || !this.eligible(image) || image.getAttribute('src')!==source) return;
      image.dataset.nasState='error';image.dataset.nasError=errorCode(error);
      image.setAttribute('title',`远程图片加载失败：${errorCode(error)}`);
    });
  }
  private release(image: HTMLImageElement): void {
    const binding=this.bindings.get(image);if(!binding)return;
    this.bindings.delete(image);image.removeEventListener('error',binding.errorListener);
    if(binding.objectUrl && image.getAttribute('src')===binding.objectUrl)image.setAttribute('src',binding.source);
    if(image.getAttribute('title')?.startsWith('远程图片加载失败：'))this.restore(image,'title',binding.priorTitle);
    this.restore(image,'data-nas-state',binding.priorState);this.restore(image,'data-nas-error',binding.priorError);
    binding.lease.release();
  }
  private restore(image: Element,key: string,value: string|null): void {
    if(value===null)image.removeAttribute(key);else image.setAttribute(key,value);
  }
  sweep(): void {
    for(const [root,scope] of this.scopes)if(!root.isConnected){scope.observer.disconnect();this.scopes.delete(root);}
    for(const image of this.bindings.keys())if(!this.eligible(image))this.release(image);
  }
  refresh(): void { this.sweep();for(const root of this.scopes.keys())this.scan(root); }
  stats(): { scopes:number; bindings:number } {return {scopes:this.scopes.size,bindings:this.bindings.size};}
  dispose(): void {
    if(this.stopped)return;this.stopped=true;this.bodyObserver.disconnect();
    for(const scope of this.scopes.values())scope.observer.disconnect();this.scopes.clear();
    for(const image of this.bindings.keys())this.release(image);
  }
}
