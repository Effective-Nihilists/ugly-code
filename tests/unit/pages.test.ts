import { describe, expect, it } from 'vitest';
import { pages } from '../../shared/pages';

describe('Page definitions', () => {
  it('home page exists and is public', () => {
    const home = pages[''];
    expect(home).toBeDefined();
    expect(home.auth).toBe(false);
  });

  it('auth-demo page exists and is public', () => {
    const authDemo = pages['auth-demo'];
    expect(authDemo).toBeDefined();
    expect(authDemo.auth).toBe(false);
  });

  it('authenticated pages require auth', () => {
    // user/:userId is the authed route (definePage defaults to auth: true).
    expect(
      pages['user/:userId'].auth,
      'user/:userId should require auth',
    ).not.toBe(false);
  });
});
