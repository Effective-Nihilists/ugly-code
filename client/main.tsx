import { bootstrapApp, FeedbackButton } from 'ugly-app/client';
import { requests } from '../shared/api';
import en from '../shared/lang/en';
import { stringsDef } from '../shared/strings';
import { RouterProvider, RouterView } from './router';
import './styles.css';

bootstrapApp({
  requests,
  RouterProvider,
  render: () => (
    <>
      <RouterView />
      <FeedbackButton />
    </>
  ),
  strings: {
    defaultLang: stringsDef.defaultLang,
    langs: stringsDef.langs,
    defaultTable: en as unknown as Record<string, string>,
    loadTable: async (lang) => {
      const mod = await import(`../shared/lang/${lang}.ts`) as { default: Record<string, string> };
      return mod.default;
    },
  },
});
