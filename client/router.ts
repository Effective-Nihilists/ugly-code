import { createRouter } from 'ugly-app/client';
import { pages } from '../shared/pages';
import { allPages } from './allPages';

// `Link` is the typed SPA link for internal navigation. Use it (or
// `useRouter().push(...)`) instead of a bare `<a href="/route">`, which does a
// full-page reload (white flash + repaint) instead of a smooth transition.
export const { RouterProvider, RouterView, useRouter, Link } = createRouter({
  pages,
  allPages,
});
