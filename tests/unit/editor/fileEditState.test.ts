// Task 3 — dirty + external-change decisions (pure).
import { describe, it, expect } from 'vitest';
import {
  isDirty,
  externalChangeAction,
} from '../../../client/studio/components/fileEditState';

describe('isDirty', () => {
  it('true only when current differs from saved', () => {
    expect(isDirty('a', 'a')).toBe(false);
    expect(isDirty('a ', 'a')).toBe(true);
  });
});

describe('externalChangeAction', () => {
  it('no disk change -> noop', () => {
    expect(externalChangeAction({ dirty: false, mtimeChanged: false })).toBe(
      'noop',
    );
    expect(externalChangeAction({ dirty: true, mtimeChanged: false })).toBe(
      'noop',
    );
  });
  it('disk changed + clean buffer -> reload', () => {
    expect(externalChangeAction({ dirty: false, mtimeChanged: true })).toBe(
      'reload',
    );
  });
  it('disk changed + dirty buffer -> banner', () => {
    expect(externalChangeAction({ dirty: true, mtimeChanged: true })).toBe(
      'banner',
    );
  });
});
