import { useEffect, useState } from 'react';

interface VirtualKeyboardLike {
  boundingRect?: { height: number };
  addEventListener?: (type: string, fn: () => void) => void;
  removeEventListener?: (type: string, fn: () => void) => void;
}

/**
 * On-screen keyboard height in CSS px (0 when closed).
 *
 * The framework's KeyboardProvider folds the keyboard into `safeArea.bottom`, but
 * that path is dead inside the native iOS UglyBrowser shell: the keyboard OVERLAYS
 * content (`navigator.virtualKeyboard.overlaysContent = true`), so `visualViewport`
 * never shrinks and the framework — which re-derives height from visualViewport
 * occlusion — always computes 0. So we read the height directly from the two
 * sources that DO work:
 *  - Native shell: `navigator.virtualKeyboard.boundingRect.height`, set on every
 *    `keyboardWillShow` and announced via the `geometrychange` event.
 *  - Mobile Safari / PWA (no overlay): `visualViewport` occlusion.
 */
export function useKeyboardHeight(): number {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const nav = navigator as Navigator & {
      virtualKeyboard?: VirtualKeyboardLike;
    };
    const vk = nav.virtualKeyboard;
    const vv = window.visualViewport;
    const compute = () => {
      let kb = 0;
      if (vk?.boundingRect) {
        kb = Math.round(vk.boundingRect.height) || 0;
      }
      if (vv) {
        const occlusion = Math.max(
          0,
          Math.round(window.innerHeight - vv.height),
        );
        if (occlusion > 100) {
          kb = Math.max(kb, occlusion);
        }
      }
      setHeight((prev) => (prev !== kb ? kb : prev));
    };
    compute();
    vk?.addEventListener?.('geometrychange', compute);
    vv?.addEventListener('resize', compute);
    return () => {
      vk?.removeEventListener?.('geometrychange', compute);
      vv?.removeEventListener('resize', compute);
    };
  }, []);
  return height;
}
