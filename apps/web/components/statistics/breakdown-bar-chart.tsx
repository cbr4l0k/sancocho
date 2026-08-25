'use client';

import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts';

import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart';

/**
 * A single-series horizontal bar chart, shared by every count-by-project /
 * count-by-recipe breakdown on this screen.
 *
 * Monochrome accent fill, not a multi-colour palette: `docs/web-design.md`
 * rations colour ("large areas are ground and ink only … if a screen ever
 * looks colourful, something has been coloured that should not have been")
 * and reserves status tones for status. A single series has nothing to
 * differentiate by hue anyway — length already encodes the comparison — so
 * one accent fill is both the honest choice and the on-brand one.
 */
export type BreakdownDatum = { key: string; label: string; count: number };

const rowHeightPx = 34;
const minChartHeightPx = 96;

export function BreakdownBarChart({ data, countLabel }: { data: readonly BreakdownDatum[]; countLabel: string }) {
  const config: ChartConfig = { count: { label: countLabel, color: 'var(--sc-accent)' } };
  const height = Math.max(minChartHeightPx, data.length * rowHeightPx);

  return (
    <ChartContainer config={config} style={{ aspectRatio: 'auto', height }}>
      <BarChart data={[...data]} layout="vertical" margin={{ top: 4, right: 20, bottom: 4, left: 4 }}>
        <CartesianGrid horizontal={false} stroke="var(--sc-line)" />
        <XAxis type="number" tickLine={false} axisLine={false} allowDecimals={false} tick={{ fill: 'var(--sc-ink-3)' }} />
        <YAxis type="category" dataKey="label" tickLine={false} axisLine={false} width={132} tick={{ fill: 'var(--sc-ink-2)' }} />
        <ChartTooltip content={<ChartTooltipContent hideLabel nameKey="count" />} cursor={{ fill: 'var(--sc-ground-2)' }} />
        <Bar dataKey="count" fill="var(--color-count)" radius={4} barSize={14} />
      </BarChart>
    </ChartContainer>
  );
}
