import { config as uglyAppConfig } from 'ugly-app/eslint';

export default [
  {
    files: ['**/*.{ts,tsx}'],
  },
  {
    ignores: [
      '**/*.js',
      '**/*.cjs',
      '**/*.mjs',
      'dist/**',
      'node_modules/**',
      'vite.config.ts',
      'vitest.config.ts',
      'playwright.config.ts',
      'tests/**',
    ],
  },
  {
    languageOptions: {
      parserOptions: {
        project: true,
        tsconfigRootDir: import.meta.dirname,
        ecmaFeatures: { jsx: true },
      },
    },
  },
  ...uglyAppConfig,
];
