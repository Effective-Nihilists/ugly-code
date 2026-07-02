/**
 * Preact-native virtualizer hook wrapping @tanstack/virtual-core.
 *
 * This avoids @tanstack/react-virtual which imports from 'react' directly
 * and has compatibility issues with our Preact + preact/compat setup.
 * The virtual-core package is framework-agnostic (no React dependency).
 */

import {
  elementScroll,
  observeElementOffset,
  observeElementRect,
  PartialKeys,
  Virtualizer,
  VirtualizerOptions,
} from '@tanstack/virtual-core';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

type VirtualizerInputOptions<
  TScrollElement extends Element,
  TItemElement extends Element,
> = PartialKeys<
  VirtualizerOptions<TScrollElement, TItemElement>,
  'observeElementRect' | 'observeElementOffset' | 'scrollToFn'
>;

export function useVirtualizer<
  TScrollElement extends Element,
  TItemElement extends Element,
>(options: VirtualizerInputOptions<TScrollElement, TItemElement>) {
  // State-based rerender using useState counter.
  // We use requestAnimationFrame to batch updates and avoid re-entrant
  // rendering crashes in Preact's diffChildren.
  const [, setTick] = useState(0);
  const rafIdRef = useRef(0);

  // Track if we're mounted to avoid state updates after unmount
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelAnimationFrame(rafIdRef.current);
    };
  }, []);

  const rerender = useCallback(() => {
    if (!mountedRef.current) return;
    // Debounce with requestAnimationFrame to coalesce multiple onChange calls
    // and break out of Preact's commit/diff phase
    cancelAnimationFrame(rafIdRef.current);
    rafIdRef.current = requestAnimationFrame(() => {
      if (mountedRef.current) {
        setTick((t) => t + 1);
      }
    });
  }, []);

  const resolvedOptions: VirtualizerOptions<TScrollElement, TItemElement> = {
    observeElementRect,
    observeElementOffset,
    scrollToFn: elementScroll,
    ...options,
    onChange: (instance, sync) => {
      void sync;
      rerender();
      options.onChange?.(instance, sync);
    },
  };

  // Create virtualizer instance once
  const [instance] = useState(
    () => new Virtualizer<TScrollElement, TItemElement>(resolvedOptions),
  );

  // Update options on every render
  instance.setOptions(resolvedOptions);

  // Mount/unmount lifecycle (useLayoutEffect matches official @tanstack/react-virtual)
  useLayoutEffect(() => {
    return instance._didMount();
  }, []);

  // Pre-render update (synchronous layout measurement)
  useLayoutEffect(() => {
    instance._willUpdate();
  });

  return instance;
}
