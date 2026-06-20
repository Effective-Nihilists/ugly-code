export function formatCurrency(amount: number, currency = '$'): string {
  const n = Number.isFinite(amount) ? amount : 0;
  const prefix = currency === '$' ? '$' : `${currency} `;
  return `${prefix}${n.toFixed(2)}`;
}
