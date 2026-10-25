import { describe, it, expect } from 'vitest';
import { calculateDiscountedPrice, formatCurrencyAmount } from '../src/lib/pricing-calculator';

describe('Pricing Calculator', () => {
  it('should calculate contractor discounts accurately', () => {
    // 1000 EGP with 20% discount = 800 EGP
    const res = calculateDiscountedPrice('1000', 20);
    expect(res).not.toBeNull();
    expect(res?.original).toBe(1000);
    expect(res?.discounted).toBe(800);
    expect(res?.currency).toBe('ج.م');
  });

  it('should handle zero discount', () => {
    const res = calculateDiscountedPrice('1500', 0);
    expect(res?.original).toBe(1500);
    expect(res?.discounted).toBe(1500);
  });

  it('should return null for non-positive or invalid prices', () => {
    expect(calculateDiscountedPrice('0', 10)).toBeNull();
    expect(calculateDiscountedPrice('-500', 10)).toBeNull();
    expect(calculateDiscountedPrice('invalid', 10)).toBeNull();
  });

  it('should format currency with thousand separators', () => {
    expect(formatCurrencyAmount(12500)).toBe('12,500');
    expect(formatCurrencyAmount(500)).toBe('500');
  });
});
