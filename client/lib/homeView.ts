// Which root view to render. The landing page (install Ugly Studio) is shown
// ONLY outside the Studio browser; inside, it's the IDE or a login prompt.
export type HomeView = 'landing' | 'shell' | 'login';

export function chooseHomeView(s: {
  native: boolean;
  authed: boolean;
}): HomeView {
  if (!s.native) return 'landing';
  return s.authed ? 'shell' : 'login';
}
