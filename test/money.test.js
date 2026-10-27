import { describe, it, expect } from 'vitest';
import { computeBill, lineAmount } from '../src/lib/money.js';

const gst5 = [{ name: 'CGST', rate: 2.5 }, { name: 'SGST', rate: 2.5 }];
const gst18 = [{ name: 'CGST', rate: 9 }, { name: 'SGST', rate: 9 }];

describe('lineAmount', () => {
  it('adds addons per unit', () => {
    expect(lineAmount({ unitPrice: 24900, addons: [{ price: 3000 }], qty: 2 })).toBe(55800);
  });
  it('handles fractional qty', () => {
    expect(lineAmount({ unitPrice: 80000, qty: 0.25 })).toBe(20000);
  });
});

describe('computeBill', () => {
  it('exclusive tax, no discount', () => {
    const b = computeBill([{ amount: 49800, taxComponents: gst5 }], { roundOff: 'none' });
    expect(b.taxes).toEqual([
      { name: 'CGST', rate: 2.5, taxable: 49800, amount: 1245 },
      { name: 'SGST', rate: 2.5, taxable: 49800, amount: 1245 },
    ]);
    expect(b.total).toBe(52290);
    expect(b.roundOff).toBe(0);
  });

  it('rounds to the nearest rupee', () => {
    const b = computeBill([{ amount: 49800, taxComponents: gst5 }]);
    expect(b.total).toBe(52300);
    expect(b.roundOff).toBe(10);
  });

  it('percent discount is taxed after discount', () => {
    const b = computeBill([{ amount: 100000, taxComponents: gst5 }], { discount: { kind: 'percent', value: 10 }, roundOff: 'none' });
    expect(b.discount).toBe(10000);
    expect(b.taxes[0].taxable).toBe(90000);
    expect(b.total).toBe(94500);
  });

  it('bill discount splits across mixed tax rates and adds up exactly', () => {
    const lines = [
      { amount: 33333, taxComponents: gst5 },
      { amount: 66667, taxComponents: gst18 },
    ];
    const b = computeBill(lines, { discount: { kind: 'flat', value: 10001 }, roundOff: 'none' });
    expect(b.discount).toBe(10001);
    const taxable5 = b.taxes.find((t) => t.rate === 2.5).taxable;
    const taxable18 = b.taxes.find((t) => t.rate === 9).taxable;
    expect(taxable5 + taxable18).toBe(100000 - 10001);
  });

  it('flat discount never exceeds the bill', () => {
    const b = computeBill([{ amount: 5000, taxComponents: gst5 }], { discount: { kind: 'flat', value: 99999 } });
    expect(b.discount).toBe(5000);
    expect(b.total).toBe(0);
  });

  it('inclusive tax keeps the menu price as the total', () => {
    const b = computeBill([{ amount: 10500, taxComponents: gst5 }], { pricesIncludeTax: true, roundOff: 'none' });
    expect(b.total).toBe(10500);
    expect(b.taxes[0].taxable).toBe(10000);
    expect(b.taxes[0].amount + b.taxes[1].amount).toBe(500);
  });

  it('service charge is on pre-tax value and is taxed', () => {
    const b = computeBill([{ amount: 100000, taxComponents: gst5 }], { serviceChargePercent: 10, roundOff: 'none' });
    expect(b.serviceCharge).toBe(10000);
    expect(b.taxes[0].taxable).toBe(110000);
    expect(b.total).toBe(115500);
  });

  it('untaxed items', () => {
    const b = computeBill([{ amount: 2000, taxComponents: [] }]);
    expect(b.taxes).toEqual([]);
    expect(b.total).toBe(2000);
  });

  it('printed bill always adds up (exclusive tax)', () => {
    const cases = [
      [{ amount: 79800, taxComponents: gst5 }],
      [{ amount: 33333, taxComponents: gst5 }, { amount: 66667, taxComponents: gst18 }, { amount: 999, taxComponents: [] }],
    ];
    for (const lines of cases) {
      for (const discount of [undefined, { kind: 'percent', value: 10 }, { kind: 'flat', value: 1234 }]) {
        for (const serviceChargePercent of [0, 5]) {
          const b = computeBill(lines, { discount, serviceChargePercent });
          const taxSum = b.taxes.reduce((s, t) => s + t.amount, 0);
          expect(b.subtotal - b.discount + b.serviceCharge + taxSum + b.roundOff).toBe(b.total);
          expect(b.total % 100).toBe(0);
        }
      }
    }
  });

  it('empty bill', () => {
    expect(computeBill([]).total).toBe(0);
  });
});
