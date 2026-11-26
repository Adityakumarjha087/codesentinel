import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import type { Category, Role, Severity } from './types';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];
export const CATEGORIES: Category[] = ['bug', 'security', 'performance', 'readability'];

export const SEVERITY_LABEL: Record<Severity, string> = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low', info: 'Info' };
export const CATEGORY_LABEL: Record<Category, string> = { bug: 'Bugs', security: 'Security', performance: 'Performance', readability: 'Readability' };

/** Chart colours (validated for contrast on light and dark surfaces). */
export const SEVERITY_COLOR: Record<Severity, string> = {
  critical: '#dc2626',
  high: '#ea580c',
  medium: '#d97706',
  low: '#2563eb',
  info: '#64748b',
};
export const CATEGORY_COLOR: Record<Category, string> = {
  bug: '#7c3aed',
  security: '#dc2626',
  performance: '#0891b2',
  readability: '#16a34a',
};

const ROLE_RANK: Record<Role, number> = { viewer: 0, maintainer: 1, admin: 2 };
export const hasRole = (role: Role | undefined, required: Role) => role !== undefined && ROLE_RANK[role] >= ROLE_RANK[required];

export function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

export function formatUsd(n: number): string {
  return n < 0.01 && n > 0 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

export function formatPercent(n: number | null): string {
  return n === null ? '—' : `${Math.round(n * 100)}%`;
}

export function timeAgo(iso: string | null, now = Date.now()): string {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export const severityRank = (s: Severity) => ['info', 'low', 'medium', 'high', 'critical'].indexOf(s);
