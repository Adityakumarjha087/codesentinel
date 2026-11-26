import { formatNumber } from '@/lib/utils';

export function BudgetMeter({ used, budget }: { used: number; budget: number }) {
  const pct = Math.min(100, Math.round((used / budget) * 100));
  const color = pct >= 90 ? 'bg-red-500' : pct >= 70 ? 'bg-amber-500' : 'bg-emerald-500';
  return (
    <div className="min-w-36">
      <div className="flex justify-between text-xs tabular-nums text-muted-foreground">
        <span>
          {formatNumber(used)} / {formatNumber(budget)}
        </span>
        <span>{pct}%</span>
      </div>
      <div className="mt-1 h-1.5 rounded-full bg-muted" role="meter" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Monthly token budget used">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
