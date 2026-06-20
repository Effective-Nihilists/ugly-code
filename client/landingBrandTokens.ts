/**
 * Shared brand tokens for the public landing page.
 *
 * Mirrors the YouTube show's brand palette so the product pages and the show
 * feel like the same artifact. Uses the ugly-app CSS variable bridge for theme
 * portability (dark/light) where neutral tokens are concerned; the brand orange
 * stays constant in both themes.
 */

export const BRAND = '#FF5500';
export const BRAND_GRAD =
  'linear-gradient(135deg, #FF8041 0%, #FF5500 50%, #E63900 100%)';
export const BRAND_GLOW = 'rgba(255,85,0,0.14)';
export const BRAND_GLOW_STRONG = 'rgba(255,85,0,0.3)';

// IMPORTANT: the deployed Workers build does NOT define `--app-background` /
// `--app-foreground` on the page — the framework's theme CSS isn't bundled into
// the standalone landing page. A bare `var(--app-foreground)` then resolves to
// nothing → transparent backgrounds + unreadable text (the Windows download
// popup was the most visible symptom; it sat over a dark overlay with a
// see-through panel). So every neutral token carries an explicit DARK fallback.
// In dev (where the framework DOES define the theme) the fallback is ignored,
// keeping this theme-portable; in prod it renders the intended dark palette.
const FG = 'var(--app-foreground, #ededed)';
const BGV = 'var(--app-background, #0a0a0a)';

export const BG = BGV;
export const BG_ELEV = `color-mix(in srgb, ${FG} 6%, ${BGV})`;
export const BORDER = `color-mix(in srgb, ${FG} 16%, ${BGV})`;
export const BORDER_STRONG = `color-mix(in srgb, ${FG} 30%, ${BGV})`;
export const TEXT = FG;
export const TEXT_MUTED = `color-mix(in srgb, ${FG} 62%, transparent)`;
export const TEXT_FAINT = `color-mix(in srgb, ${FG} 38%, transparent)`;
export const ON_BRAND = '#ffffff';

export const OK = '#4ade80';
export const WARN = '#fbbf24';
export const ERR = '#f87171';

export const FONT_DISPLAY =
  "'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, sans-serif";
export const FONT_MONO =
  "'JetBrains Mono', 'SF Mono', 'Fira Code', ui-monospace, monospace";
export const FONT_BODY =
  "'Inter', -apple-system, BlinkMacSystemFont, sans-serif";
