import { describe, expect, it } from 'vitest';
import { createActualAmHarness, hasActualAmBundle } from './helpers/am-harness';

describe.skipIf(!hasActualAmBundle)('Adjustable Media 0.8.2 compiled DOM behavior in a simulated host (requires audited test-vault bundle)', () => {
  it('renders one-item and multi-item rows with the same media selector', () => {
    const harness = createActualAmHarness();
    const singleRoot = harness.document.createElement('div');
    const matrixRoot = harness.document.createElement('div');

    const singleLayout = harness.render(singleRoot, [
      { items: [{ embed: { kind: 'image', target: 'assets/one.png', alt: 'One' } }] },
    ]);
    const matrixLayout = harness.render(matrixRoot, [
      { items: [{ embed: { kind: 'image', target: 'assets/one.png', alt: 'One' } }, { embed: { kind: 'image', target: 'assets/two.png', alt: 'Two' } }] },
    ]);

    expect(singleLayout.matches('.vml-layout')).toBe(true);
    expect(singleLayout.querySelectorAll('.vml-item__media')).toHaveLength(1);
    expect(singleLayout.querySelector('.vml-item__media')).toBeInstanceOf(harness.document.defaultView!.HTMLImageElement);
    expect(matrixLayout.querySelectorAll('.vml-layout .vml-item__media')).toHaveLength(2);
    expect([...matrixLayout.querySelectorAll('.vml-item__media')].map((image) => image.getAttribute('src'))).toEqual([
      'app://vault/assets/one.png',
      'app://vault/assets/two.png',
    ]);
  });

  it('uses a separate modal viewer with one image node reused across image switches and detached on close', () => {
    const harness = createActualAmHarness();
    const matrixRoot = harness.document.createElement('div');
    harness.render(matrixRoot, [
      { items: [{ embed: { kind: 'image', target: 'assets/one.png', alt: 'One' } }, { embed: { kind: 'image', target: 'assets/two.png', alt: 'Two' } }] },
    ]);
    const matrixImage = matrixRoot.querySelector('.vml-item__media');
    const viewer = harness.openViewer([
      { url: 'app://vault/assets/one.png', alt: 'One' },
      { url: 'app://vault/assets/two.png', alt: 'Two' },
    ]);

    const viewerImage = harness.document.querySelector('.vml-viewer__image');
    expect(viewerImage).not.toBeNull();
    expect(viewerImage).not.toBe(matrixImage);
    expect(viewerImage?.getAttribute('src')).toBe('app://vault/assets/one.png');

    viewer.go(1);

    expect(harness.document.querySelector('.vml-viewer__image')).toBe(viewerImage);
    expect(viewerImage?.getAttribute('src')).toBe('app://vault/assets/two.png');
    expect(matrixImage?.getAttribute('src')).toBe('app://vault/assets/one.png');

    viewer.close();

    expect(viewerImage?.isConnected).toBe(false);
    expect(harness.document.querySelector('.vml-viewer')).toBeNull();
  });

  it('fires the renderer load callback after the image src is assigned', () => {
    const harness = createActualAmHarness();
    const root = harness.document.createElement('div');
    harness.render(root, [
      { items: [{ embed: { kind: 'image', target: 'assets/one.png', alt: 'One' } }] },
    ]);
    const image = root.querySelector('.vml-item__media') as HTMLImageElement;
    Object.defineProperties(image, {
      naturalWidth: { configurable: true, value: 320 },
      naturalHeight: { configurable: true, value: 240 },
    });

    expect(image.getAttribute('src')).toBe('app://vault/assets/one.png');
    image.dispatchEvent(new harness.document.defaultView!.Event('load'));

    expect(harness.loadCalls).toHaveLength(1);
    expect(harness.loadCalls[0]).toEqual({
      item: image.parentElement,
      url: 'app://vault/assets/one.png',
      width: 320,
      height: 240,
      isMultiItemRow: false,
    });
  });
});
