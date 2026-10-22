import { CalculatedPrice } from '../types';

/**
 * Calculates corporate discount pricing with support for Western and Eastern Arabic numerals.
 */
export function calculateDiscountedPrice(
  priceStr: string,
  discountPercent: number
): CalculatedPrice | null {
  if (!priceStr) return null;

  // Convert Eastern Arabic and Arabic-Indic numerals to Western (0-9)
  const cleanPriceStr = priceStr.replace(/[\u0660-\u0669\u06F0-\u06F9٠-٩]/g, (d) =>
    String(d.charCodeAt(0) & 0xf)
  );

  const numericPart = cleanPriceStr.replace(/[^0-9.]/g, '');
  const price = parseFloat(numericPart);
  if (isNaN(price)) return null;

  // Apply discount percentage (e.g., 20 means 20% off)
  const discountAmount = (price * Math.max(0, Math.min(discountPercent, 100))) / 100;
  const finalPrice = Math.max(0, price - discountAmount);

  // Preserve currency descriptor if present
  const currencyMatch = priceStr.match(/[A-Za-z]+|[\u0600-\u06FF]+/);
  const currency = currencyMatch ? currencyMatch[0] : 'ج.م';

  return {
    original: price,
    discounted: finalPrice,
    currency,
  };
}

/**
 * Formats a number with tabular digits and optional fraction limits
 */
export function formatCurrencyAmount(amount: number, minimumFractionDigits = 0): string {
  return amount.toLocaleString(undefined, {
    minimumFractionDigits,
    maximumFractionDigits: 2,
  });
}
