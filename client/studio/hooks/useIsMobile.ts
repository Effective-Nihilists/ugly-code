import { useEffect, useState } from 'react';

// Mobile breakpoint: at/below this width we swap the workspace to its drawer
// layout. 768px is the conventional tablet/phone cutoff.
export const MOBILE_MAX_WIDTH = 768;

// Pure predicate — node-testable without a DOM (the repo's vitest env is `node`).
export function isMobileWidth(
  width: number,
  maxWidth = MOBILE_MAX_WIDTH,
): boolean {
  return width <= maxWidth;
}

// True when the viewport is at or below `maxWidth` (default 768px). Mirrors the
// landing page's useIsDesktop() but generalized + inverted for the workspace
// drawer breakpoint. Used for conditional STRUCTURE swaps (drawer vs inline
// sidebar), which CSS media queries can't express on their own. Reactive
// behavior is exercised by the 390px e2e (tests/e2e/mobile-layout.spec.ts).
export function useIsMobile(maxWidth = MOBILE_MAX_WIDTH): boolean {
  const [isMobile, setIsMobile] = useState<boolean>(() =>
    typeof window === 'undefined'
      ? false
      : isMobileWidth(window.innerWidth, maxWidth),
  );
  useEffect(() => {
    const onResize = (): void => {
      setIsMobile(isMobileWidth(window.innerWidth, maxWidth));
    };
    onResize();
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
    };
  }, [maxWidth]);
  return isMobile;
}
