import { describe, expect, it } from 'vitest';
import { chooseHomeView } from '../../client/lib/homeView';

describe('chooseHomeView', () => {
  it('outside Studio always shows the install landing', () => {
    expect(chooseHomeView({ native: false, authed: false })).toBe('landing');
    expect(chooseHomeView({ native: false, authed: true })).toBe('landing');
  });
  it('inside Studio shows the IDE when authed, login when not', () => {
    expect(chooseHomeView({ native: true, authed: true })).toBe('shell');
    expect(chooseHomeView({ native: true, authed: false })).toBe('login');
  });
});
