/** Amounts are integers in minor units (100 butut = 1 dalasi). Never use floats for money. */
export function formatMinor(amountMinor: number, currency: string): string {
  return new Intl.NumberFormat('en', { style: 'currency', currency }).format(amountMinor / 100);
}

/** "12.50" -> 1250. Returns null for invalid input. */
export function parseToMinor(input: string): number | null {
  const m = /^\d+(\.\d{1,2})?$/.exec(input.trim());
  if (!m) return null;
  const [whole, frac = ''] = input.trim().split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}
