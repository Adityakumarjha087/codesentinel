import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { finding, reviewItem } from '@/test/fixtures';
import { BudgetMeter } from './dashboard/budget-meter';
import { CategoryChart, FindingsTimelineChart } from './dashboard/charts';
import { StatCard } from './dashboard/stat-card';
import { FindingCard } from './review/finding-card';
import { ReviewsTable } from './review/reviews-table';
import { EmptyState, ErrorState, LoadingState } from './states';
import { GitPullRequest } from 'lucide-react';

describe('FindingCard', () => {
  it('shows severity, location, explanation and the suggested diff', () => {
    render(<FindingCard finding={finding()} canEdit={false} />);
    expect(screen.getByRole('article', { name: 'Possible SQL injection' })).toBeInTheDocument();
    expect(screen.getByText('High')).toBeInTheDocument();
    expect(screen.getByText('Security')).toBeInTheDocument();
    expect(screen.getByText('src/db.ts:12 · getUser')).toBeInTheDocument();
    expect(screen.getByText(/\+ db\.query\("SELECT 1 WHERE id = \$1"/)).toBeInTheDocument();
    expect(screen.getByText('security/sql-injection · 90% confidence')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Accept/ })).not.toBeInTheDocument();
  });

  it('lets maintainers accept or dismiss and reopen', async () => {
    const onStatus = vi.fn();
    const onSelect = vi.fn();
    const { rerender } = render(<FindingCard finding={finding()} canEdit onStatus={onStatus} onSelect={onSelect} />);
    await userEvent.click(screen.getByRole('button', { name: 'Accept: Possible SQL injection' }));
    expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ id: 'f1' }), 'accepted');
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss: Possible SQL injection' }));
    expect(onStatus).toHaveBeenLastCalledWith(expect.anything(), 'rejected');
    await userEvent.click(screen.getByText(/src\/db\.ts:12/));
    expect(onSelect).toHaveBeenCalled();
    rerender(<FindingCard finding={finding({ status: 'accepted' })} canEdit onStatus={onStatus} />);
    await userEvent.click(screen.getByRole('button', { name: 'Reopen: Possible SQL injection' }));
    expect(onStatus).toHaveBeenLastCalledWith(expect.anything(), 'open');
  });

  it('renders delete-line suggestions and out-of-diff findings', () => {
    render(<FindingCard finding={finding({ suggestion: '', inDiff: false })} canEdit={false} />);
    expect(screen.getByText('(delete line)')).toBeInTheDocument();
    expect(screen.getByText('outside diff')).toBeInTheDocument();
  });
});

describe('ReviewsTable', () => {
  it('lists reviews with links, severity counts and cost', () => {
    render(<ReviewsTable items={[reviewItem(), reviewItem({ id: 'r2', findingsCount: 0, bySeverity: {}, status: 'skipped' })]} />);
    expect(screen.getAllByRole('link', { name: '#101 Add customer search' })[0]).toHaveAttribute('href', '/reviews/r1');
    expect(screen.getByText('Critical')).toBeInTheDocument();
    expect(screen.getAllByText('$0.01')).toHaveLength(2);
    expect(screen.getAllByText('13k')).toHaveLength(2);
    expect(screen.getByText('none')).toBeInTheDocument();
    expect(screen.getByText('skipped')).toBeInTheDocument();
  });
});

describe('state components', () => {
  it('renders loading, empty and error states accessibly', async () => {
    const retry = vi.fn();
    render(
      <>
        <LoadingState label="Loading reviews" />
        <EmptyState title="Nothing here" description="Connect a repo" />
        <ErrorState error={new Error('Boom')} onRetry={retry} />
      </>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Loading reviews');
    expect(screen.getByText('Nothing here')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Boom');
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalled();
  });
});

describe('dashboard widgets', () => {
  it('renders stat cards and budget meters', () => {
    render(
      <>
        <StatCard label="Acceptance rate" value="63%" hint="40 accepted" icon={GitPullRequest} />
        <BudgetMeter used={1_800_000} budget={2_000_000} />
      </>,
    );
    expect(screen.getByTestId('stat-acceptance-rate')).toHaveTextContent('63%');
    const meter = screen.getByRole('meter', { name: 'Monthly token budget used' });
    expect(meter).toHaveAttribute('aria-valuenow', '90');
    expect(screen.getByText('1.8M / 2.0M')).toBeInTheDocument();
  });

  it('renders charts with accessible labels', () => {
    render(
      <>
        <FindingsTimelineChart data={[{ date: '2026-01-01', total: 2, critical: 1, high: 1, medium: 0, low: 0, info: 0, bug: 1, security: 1, performance: 0, readability: 0 }]} />
        <CategoryChart data={[{ category: 'security', count: 3 }]} />
      </>,
    );
    expect(screen.getByRole('img', { name: 'Findings per day stacked by severity' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Findings by category' })).toBeInTheDocument();
  });
});
