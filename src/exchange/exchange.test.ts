import { describe, expect, it } from 'vitest';
import { feesFromFills, isUnknownOutcome } from './index';

describe('feesFromFills', () => {
  it('sums commissions by asset across fills', () => {
    const fees = feesFromFills(
      [
        { qty: '0.00005', commission: '0.00000005', commissionAsset: 'BTC' },
        { qty: '0.00003', commission: '0.00000003', commissionAsset: 'BTC' },
        { qty: '0.00002', commission: '0.0000041', commissionAsset: 'BNB' },
        { qty: '0.00001', commission: '0.0012', commissionAsset: 'USDT' },
      ],
      'BTC',
      'USDT',
    );
    expect(fees.base).toBeCloseTo(0.00000008, 12);
    expect(fees.quote).toBeCloseTo(0.0012, 10);
    expect(fees.other.BNB).toBeCloseTo(0.0000041, 12);
  });

  it('ignores zero and malformed entries', () => {
    expect(feesFromFills([{ commission: '0', commissionAsset: 'BTC' }, null, 'x', {}], 'BTC', 'USDT')).toEqual({
      base: 0,
      quote: 0,
      other: {},
    });
  });
});

describe('isUnknownOutcome', () => {
  it('treats network errors and -1006/-1007 as unknown, other codes as rejections', () => {
    expect(isUnknownOutcome(new Error('socket hang up'))).toBe(true);
    expect(isUnknownOutcome(Object.assign(new Error('x'), { code: -1007 }))).toBe(true);
    expect(isUnknownOutcome(Object.assign(new Error('x'), { code: -1006 }))).toBe(true);
    expect(isUnknownOutcome(Object.assign(new Error('x'), { code: -2010 }))).toBe(false);
  });
});
