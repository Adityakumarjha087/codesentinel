'use client';

import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { Overview } from '@/lib/types';
import { CATEGORY_COLOR, CATEGORY_LABEL, CATEGORIES, formatUsd, SEVERITIES, SEVERITY_COLOR, SEVERITY_LABEL } from '@/lib/utils';

const axis = { stroke: 'var(--muted-foreground)', fontSize: 12, tickLine: false, axisLine: false } as const;
const tooltipStyle = {
  contentStyle: { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--foreground)', fontSize: 12 },
  labelStyle: { color: 'var(--foreground)' },
};

export function FindingsTimelineChart({ data }: { data: Overview['timeline'] }) {
  const rows = data.map((d) => ({ ...d, label: d.date.slice(5) }));
  return (
    <div className="h-72" role="img" aria-label="Findings per day stacked by severity">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={rows} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
          <XAxis dataKey="label" {...axis} interval="preserveStartEnd" minTickGap={24} />
          <YAxis allowDecimals={false} {...axis} />
          <Tooltip {...tooltipStyle} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          {[...SEVERITIES].reverse().map((s) => (
            <Area key={s} type="monotone" dataKey={s} name={SEVERITY_LABEL[s]} stackId="1" stroke={SEVERITY_COLOR[s]} fill={SEVERITY_COLOR[s]} fillOpacity={0.55} />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export function CategoryChart({ data }: { data: Overview['byCategory'] }) {
  const rows = CATEGORIES.map((c) => ({ category: CATEGORY_LABEL[c], key: c, count: data.find((d) => d.category === c)?.count ?? 0 }));
  return (
    <div className="h-64" role="img" aria-label="Findings by category">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 16, left: 16, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
          <XAxis type="number" allowDecimals={false} {...axis} />
          <YAxis type="category" dataKey="category" width={90} {...axis} />
          <Tooltip {...tooltipStyle} cursor={{ fill: 'var(--muted)' }} />
          <Bar dataKey="count" name="Findings" radius={[0, 4, 4, 0]}>
            {rows.map((r) => (
              <Cell key={r.key} fill={CATEGORY_COLOR[r.key]} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function CostByRepoChart({ data }: { data: Overview['usage']['byRepo'] }) {
  return (
    <div className="h-64" role="img" aria-label="LLM cost by repository">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 4, right: 8, left: -8, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
          <XAxis dataKey="repo" {...axis} tickFormatter={(v: string) => v.split('/')[1] ?? v} />
          <YAxis {...axis} tickFormatter={(v: number) => `$${v.toFixed(3)}`} />
          <Tooltip {...tooltipStyle} cursor={{ fill: 'var(--muted)' }} formatter={(v) => formatUsd(Number(v))} />
          <Bar dataKey="costUsd" name="Cost (USD)" fill="var(--primary)" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
