// A cost readout that says $0.00 for every real turn is decoration, not information.
import { describe, it, expect } from 'vitest';
import { formatCurrency } from '../../client/studio/shared/Currency';

describe('formatCurrency', () => {
  it('shows sub-cent spend instead of rounding a real turn to $0.00', () => {
    // The reported case: a turn that genuinely cost $0.0058 displayed as "$0.00".
    expect(formatCurrency(0.0058)).toBe('$0.0058');
  });

  it('trims trailing zeros', () => {
    expect(formatCurrency(0.005)).toBe('$0.005');
    expect(formatCurrency(0.0010)).toBe('$0.001');
  });

  it('zero is still $0.00 (an honest zero, not a rounded one)', () => {
    expect(formatCurrency(0)).toBe('$0.00');
  });

  it('marks spend too small to render rather than claiming zero', () => {
    expect(formatCurrency(0.00001)).toBe('<$0.0001');
  });

  it('normal amounts keep 2dp', () => {
    expect(formatCurrency(1.5)).toBe('$1.50');
    expect(formatCurrency(0.01)).toBe('$0.01');
    expect(formatCurrency(12.345)).toBe('$12.35');
  });

  it('non-finite input is treated as zero', () => {
    expect(formatCurrency(NaN)).toBe('$0.00');
    expect(formatCurrency(Infinity)).toBe('$0.00');
  });

  it('honors a non-$ currency prefix', () => {
    expect(formatCurrency(2, 'EUR')).toBe('EUR 2.00');
  });
});
