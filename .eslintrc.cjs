module.exports = {
  root: true,
  env: { browser: true, es2022: true, node: true },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/strict',
    'plugin:@typescript-eslint/stylistic',
  ],
  parser: '@typescript-eslint/parser',
  parserOptions: { project: './tsconfig.json' },
  plugins: ['@typescript-eslint'],
  rules: {
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/no-floating-promises': 'error',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/no-empty-object-type': 'off',
    '@typescript-eslint/no-non-null-assertion': 'off',
    'no-console': 'off',
  },
};
