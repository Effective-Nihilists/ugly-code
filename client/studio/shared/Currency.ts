/**
 * Format an AI cost for display.
 *
 * These are token costs: a normal turn runs fractions of a cent. Formatting everything
 * with `toFixed(2)` rendered every real turn as "$0.00" — a readout that only goes
 * non-zero once you've spent enough to stop caring, which is decoration rather than
 * information (a turn that actually cost $0.0058 displayed as $0.00). Sub-cent amounts
 * keep enough precision to be readable; a genuinely-zero cost still reads "$0.00".
 */
export function formatCurrency(amount: number, currency = '$'): string {
  const n = Number.isFinite(amount) ? amount : 0;
  const prefix = currency === '$' ? '$' : `${currency} `;
  if (n <= 0) return `${prefix}${(0).toFixed(2)}`;
  // Real spend, but below what any decimal rendering would show honestly.
  if (n < 0.0001) return `<${prefix}0.0001`;
  if (n < 0.01) {
    // Trim trailing zeros so 0.0058 → "$0.0058" and 0.005 → "$0.005" (not "$0.0050").
    const trimmed = n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
    return `${prefix}${trimmed}`;
  }
  return `${prefix}${n.toFixed(2)}`;
}
