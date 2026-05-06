// All money values must route through src/lib/formatCurrency.ts. Direct division by 100 in JSX is a bug.

/**
 * Format cents to dollars with proper decimal handling.
 * Always shows 2 decimal places for consistency (e.g., $19.50, $20.00).
 * Use this when the source value is in cents (e.g., *_cents columns).
 */
export const formatCents = (cents: number): string => {
  const dollars = cents / 100;
  return `$${dollars.toFixed(2)}`;
};

/**
 * Format cents to dollars as a raw number string (no $ symbol).
 */
export const formatCentsRaw = (cents: number): string => {
  const dollars = cents / 100;
  if (Number.isInteger(dollars)) {
    return dollars.toString();
  }
  return dollars.toFixed(2);
};

/**
 * Format a dollar number (already in dollars) to "$X.XX".
 * Use only when the source is known to be dollars (e.g., profile-overview wallet fields,
 * which divide cents by 100 server-side before returning).
 */
export const formatDollars = (dollars: number): string => `$${dollars.toFixed(2)}`;
