// All billing maths. Amounts are integer paise. Nothing else in the codebase
// should add up money; call these instead.

const round = (n) => Math.round(n);

export const unitTotal = (unitPrice, addons = []) => unitPrice + addons.reduce((s, a) => s + a.price, 0);

export const lineAmount = (line) => round(unitTotal(line.unitPrice, line.addons) * line.qty);

/**
 * @param lines    [{ amount, taxComponents: [{ name, rate }] }]   amount in paise
 * @param options  { discount: { kind: 'percent'|'flat', value }, pricesIncludeTax,
 *                   serviceChargePercent, roundOff: 'nearest_rupee'|'none' }
 *
 * Discount is split across lines by amount. Service charge is charged on the
 * pre-tax value after discount and is taxed at the line's GST rate.
 */
export function computeBill(lines, options = {}) {
  const { discount, pricesIncludeTax = false, serviceChargePercent = 0, roundOff = 'nearest_rupee' } = options;

  const gross = lines.reduce((s, l) => s + l.amount, 0);

  let discountAmount = 0;
  if (discount && gross > 0) {
    discountAmount = discount.kind === 'percent'
      ? round((gross * Math.min(discount.value, 100)) / 100)
      : Math.min(discount.value, gross);
  }

  // Rounding remainder goes to the largest line so the shares add up exactly.
  const shares = lines.map((l) => (gross ? round((discountAmount * l.amount) / gross) : 0));
  const diff = discountAmount - shares.reduce((s, x) => s + x, 0);
  if (diff && lines.length) {
    const biggest = lines.reduce((bi, l, i) => (l.amount > lines[bi].amount ? i : bi), 0);
    shares[biggest] += diff;
  }

  const taxMap = new Map();
  let serviceCharge = 0;
  let exact = 0;

  lines.forEach((l, i) => {
    const afterDiscount = l.amount - shares[i];
    const rate = (l.taxComponents || []).reduce((s, c) => s + c.rate, 0);
    const base = pricesIncludeTax ? afterDiscount / (1 + rate / 100) : afterDiscount;
    const sc = (base * serviceChargePercent) / 100;
    const taxable = base + sc;
    serviceCharge += sc;

    for (const c of l.taxComponents || []) {
      const key = `${c.name}@${c.rate}`;
      const t = taxMap.get(key) || { name: c.name, rate: c.rate, taxable: 0, amount: 0 };
      t.taxable += taxable;
      t.amount += (taxable * c.rate) / 100;
      taxMap.set(key, t);
    }

    exact += pricesIncludeTax
      ? afterDiscount + sc * (1 + rate / 100)
      : taxable * (1 + rate / 100);
  });

  const taxes = [...taxMap.values()]
    .map((t) => ({ ...t, taxable: round(t.taxable), amount: round(t.amount) }))
    .sort((a, b) => a.rate - b.rate || a.name.localeCompare(b.name));

  // Exclusive pricing: build the total from the rounded figures printed on the
  // bill, so subtotal - discount + service charge + taxes + roundOff = total.
  exact = pricesIncludeTax
    ? round(exact)
    : gross - discountAmount + round(serviceCharge) + taxes.reduce((s, t) => s + t.amount, 0);
  const total = roundOff === 'nearest_rupee' ? round(exact / 100) * 100 : exact;

  return {
    subtotal: gross,
    discount: discountAmount,
    serviceCharge: round(serviceCharge),
    taxes,
    roundOff: total - exact,
    total,
  };
}
