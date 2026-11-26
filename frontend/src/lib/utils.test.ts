import { describe, expect, it } from 'vitest';
import { cn, formatDuration, formatNumber, formatPercent, formatUsd, hasRole, severityRank, timeAgo } from './utils';

describe('utils', () => {
  it('formats numbers, money, percentages and durations', () => {
    expect(formatNumber(950)).toBe('950');
    expect(formatNumber(1_250)).toBe('1.3k');
    expect(formatNumber(45_000)).toBe('45k');
    expect(formatNumber(2_500_000)).toBe('2.5M');
    expect(formatUsd(0.0042)).toBe('$0.0042');
    expect(formatUsd(12.5)).toBe('$12.50');
    expect(formatPercent(0.634)).toBe('63%');
    expect(formatPercent(null)).toBe('—');
    expect(formatDuration(450)).toBe('450ms');
    expect(formatDuration(2300)).toBe('2.3s');
    expect(formatDuration(null)).toBe('—');
  });

  it('formats relative time', () => {
    const now = Date.parse('2026-01-10T12:00:00Z');
    expect(timeAgo('2026-01-10T11:59:30Z', now)).toBe('just now');
    expect(timeAgo('2026-01-10T11:00:00Z', now)).toBe('1h ago');
    expect(timeAgo('2026-01-07T12:00:00Z', now)).toBe('3d ago');
    expect(timeAgo(null, now)).toBe('never');
  });

  it('checks role hierarchy and merges classes', () => {
    expect(hasRole('admin', 'maintainer')).toBe(true);
    expect(hasRole('viewer', 'maintainer')).toBe(false);
    expect(hasRole(undefined, 'viewer')).toBe(false);
    expect(cn('px-2', 'px-4', false && 'hidden')).toBe('px-4');
    expect(severityRank('critical')).toBeGreaterThan(severityRank('low'));
  });
});
