/** Amounts are integers in minor units (100 butut = 1 dalasi). Never use floats for money. */
export function formatMinor(amountMinor: number, currency: string): string {
  return new Intl.NumberFormat('en', { style: 'currency', currency }).format(amountMinor / 100);
}
