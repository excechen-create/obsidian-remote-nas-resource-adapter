import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

const actualAmBundlePath = process.env.AM_BUNDLE_PATH ?? path.resolve('test-vault/.obsidian/plugins/adjustable-media/main.js');
export const hasActualAmBundle = existsSync(actualAmBundlePath);

type ViewerImage = { url: string; alt: string };
type AmViewer = { go(step: number): void; close(): void; imageEl: HTMLImageElement | null };

function createChild(parent: HTMLElement, tag: string, options: { cls?: string; attr?: Record<string, string>; text?: string } = {}) {
  const child = parent.ownerDocument.createElement(tag);
  if (options.cls) child.className = options.cls;
  for (const [name, value] of Object.entries(options.attr ?? {})) child.setAttribute(name, value);
  if (options.text) child.textContent = options.text;
  parent.appendChild(child);
  return child;
}

function sliceBetween(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(`AM bundle marker not found: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (end < 0) throw new Error(`AM bundle marker not found: ${endMarker}`);
  return source.slice(start, end);
}

export function createActualAmHarness() {
  const bundle = readFileSync(actualAmBundlePath, 'utf8');
  if(createHash('sha256').update(bundle).digest('hex')!=='b4b2f4fb7a3605a4312d6316d22cf6819e3316601ee833600804edaf9d3e1762')
    throw new Error('This test-only extraction harness supports only the audited AM 0.8.2 build');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://obsidian.test/',
  });
  const { window } = dom;
  const document = window.document;

  Object.assign(window.HTMLElement.prototype, {
    addClass(this: HTMLElement, ...names: string[]) {
      this.classList.add(...names);
      return this;
    },
    removeClass(this: HTMLElement, ...names: string[]) {
      this.classList.remove(...names);
      return this;
    },
    toggleClass(this: HTMLElement, name: string, force?: boolean) {
      this.classList.toggle(name, force);
      return this;
    },
    setCssProps(this: HTMLElement, properties: Record<string, string>) {
      for (const [name, value] of Object.entries(properties)) this.style.setProperty(name, value);
      return this;
    },
    setText(this: HTMLElement, value: string) {
      this.textContent = value;
      return this;
    },
    empty(this: HTMLElement) {
      this.replaceChildren();
      return this;
    },
    createDiv(this: HTMLElement, options: { cls?: string; attr?: Record<string, string>; text?: string } = {}) {
      return createChild(this, 'div', options);
    },
    createEl(this: HTMLElement, tag: string, options: { cls?: string; attr?: Record<string, string>; text?: string } = {}) {
      return createChild(this, tag, options);
    },
  });

  class TFile {}
  class Modal {
    app: unknown;
    modalEl = document.createElement('div');
    containerEl = document.createElement('div');
    contentEl = document.createElement('div');
    scope = { register() {} };

    constructor(app: unknown) {
      this.app = app;
      this.modalEl.className = 'modal';
      this.containerEl.className = 'modal-container';
      this.containerEl.appendChild(this.modalEl);
      this.modalEl.appendChild(this.contentEl);
    }

    open() {
      document.body.appendChild(this.containerEl);
      (this as unknown as { onOpen(): void }).onOpen();
      return this;
    }

    close() {
      (this as unknown as { onClose(): void }).onClose();
      this.containerEl.remove();
    }
  }

  const loadCalls: Array<{ item: Element; url: string; width: number; height: number; isMultiItemRow: boolean }> = [];
  const app = {
    metadataCache: {
      getFirstLinkpathDest(target: string) {
        return new TFileWithPath(target);
      },
    },
    vault: {
      getResourcePath(file: TFileWithPath) {
        return `app://vault/${file.path}`;
      },
      getAbstractFileByPath() {
        return null;
      },
    },
  };
  class TFileWithPath extends TFile {
    path: string;
    constructor(path: string) {
      super();
      this.path = path;
    }
  }

  const context = vm.createContext({
    document,
    window,
    console,
    TFile: TFileWithPath,
    mt: { TFile: TFileWithPath, Platform: { resourcePathPrefix: 'app://vault/' }, normalizePath: (path: string) => path },
    On: { Modal, setIcon: () => undefined },
    app,
    y: (key: string) => key,
    ee: () => undefined,
    Zd: 10,
    el: 1.2,
    jd: 2.5,
    Ht: 1,
    Ye: 0,
    pr: new Map(),
    Ja: new WeakMap(),
    Xa: new Map(),
    fr: new WeakSet(),
    Qa: new WeakSet(),
    ae: () => false,
    U: () => false,
    Ue: () => undefined,
    It: () => 0,
    Kd: () => null,
    ke: () => null,
    Za: () => undefined,
    Fn: () => false,
    Ka: (item: Element, url: string, width: number, height: number, isMultiItemRow: boolean) => {
      loadCalls.push({ item, url, width, height, isMultiItemRow });
    },
    Ga: (url: string) => (url.includes('#') ? url : `${url}#t=0.001`),
    Ua: () => undefined,
  });

  const renderFunctions = [
    sliceBetween(bundle, 'function ve(', 'function qa('),
    sliceBetween(bundle, 'function Gd(', 'function Xd('),
    sliceBetween(bundle, 'function Xd(', 'function qd('),
    sliceBetween(bundle, 'function jt(', 'function Vd('),
    sliceBetween(bundle, 'function Vd(', 'function Ua('),
  ].join('\n');
  vm.runInContext(renderFunctions, context);

  const viewerClass = sliceBetween(bundle, 'Nn=class extends On.Modal{', ';var He=require("obsidian")');
  vm.runInContext(`var Nn=class extends On.Modal{${viewerClass.split('{').slice(1).join('{')};globalThis.AmViewer=Nn;`, context);

  return {
    app,
    document,
    dom,
    loadCalls,
    render(root: HTMLElement, rows: Array<{ items: Array<{ embed: { kind: string; target: string; alt?: string } }> }>) {
      const model = {
        rows,
        skip: null,
        wrap: null,
        valign: null,
        textAlign: null,
        size: null,
        cols: null,
        gap: null,
        align: null,
        text: { left: null, right: null },
      };
      return (context as unknown as { ve(root: HTMLElement, options: unknown): HTMLElement }).ve(root, {
        model,
        editable: true,
        sourcePath: 'notes/source.md',
        app,
        component: {},
        renderTasks: [],
      });
    },
    openViewer(images: ViewerImage[], index = 0): AmViewer {
      const Viewer = (context as unknown as { AmViewer: new (app: unknown, images: ViewerImage[], index: number) => AmViewer }).AmViewer;
      const viewer = new Viewer(app, images, index) as AmViewer & { open(): unknown };
      viewer.open();
      return viewer;
    },
  };
}
