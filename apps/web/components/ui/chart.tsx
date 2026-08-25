'use client';

import * as React from 'react';
import * as RechartsPrimitive from 'recharts';
import type { TooltipValueType } from 'recharts';

import { cn } from '@/lib/utils';

/**
 * Vendored from `@shadcn/chart` (`bunx shadcn@latest view @shadcn/chart`) and
 * re-skinned onto our tokens, following the same rule every other primitive in
 * `components/ui/` was built under: none of shadcn's default palette classes
 * (`text-muted-foreground`, `bg-background`, `border-border`, …) survive.
 *
 * One deliberate simplification from the upstream file: shadcn's `ChartStyle`
 * emits a `--color-*` block per theme, keyed off a `.dark` class selector,
 * because shadcn's own tokens are plain (non-theme-reactive) hex values that
 * need a second declaration under `.dark`. Our tokens (`--sc-*`) are already
 * theme-reactive CSS custom properties — `--sc-accent` resolves differently
 * under `prefers-color-scheme`/`[data-theme]` with no help needed here — so a
 * series `color` is normally passed as `var(--sc-accent)` and just works in
 * both themes without a second declaration. `ChartConfig` therefore only
 * supports `color`, not shadcn's `theme` dual-key alternative.
 */
export type ChartConfig = Record<string, { label?: React.ReactNode; color?: string }>;

type ChartContextProps = { config: ChartConfig };

const ChartContext = React.createContext<ChartContextProps | null>(null);

function useChart() {
  const context = React.useContext(ChartContext);
  if (!context) throw new Error('useChart must be used within a <ChartContainer />');
  return context;
}

const INITIAL_DIMENSION = { width: 320, height: 200 } as const;

function ChartContainer({
  id,
  className,
  children,
  config,
  initialDimension = INITIAL_DIMENSION,
  ...props
}: React.ComponentProps<'div'> & {
  config: ChartConfig;
  children: React.ComponentProps<typeof RechartsPrimitive.ResponsiveContainer>['children'];
  initialDimension?: { width: number; height: number };
}) {
  const uniqueId = React.useId();
  const chartId = `chart-${id ?? uniqueId.replace(/:/g, '')}`;

  return (
    <ChartContext.Provider value={{ config }}>
      <div
        data-slot="chart"
        data-chart={chartId}
        className={cn(
          'flex aspect-video justify-center text-xs',
          '[&_.recharts-cartesian-axis-tick_text]:fill-ink-3',
          "[&_.recharts-cartesian-grid_line[stroke='#ccc']]:stroke-line",
          '[&_.recharts-curve.recharts-tooltip-cursor]:stroke-line-strong',
          "[&_.recharts-dot[stroke='#fff']]:stroke-transparent",
          '[&_.recharts-layer]:outline-hidden',
          "[&_.recharts-polar-grid_[stroke='#ccc']]:stroke-line",
          '[&_.recharts-radial-bar-background-sector]:fill-ground-2',
          '[&_.recharts-rectangle.recharts-tooltip-cursor]:fill-ground-2',
          "[&_.recharts-reference-line_[stroke='#ccc']]:stroke-line",
          '[&_.recharts-sector]:outline-hidden',
          "[&_.recharts-sector[stroke='#fff']]:stroke-transparent",
          '[&_.recharts-surface]:outline-hidden',
          className,
        )}
        {...props}
      >
        <ChartStyle id={chartId} config={config} />
        <RechartsPrimitive.ResponsiveContainer initialDimension={initialDimension}>{children}</RechartsPrimitive.ResponsiveContainer>
      </div>
    </ChartContext.Provider>
  );
}

const ChartStyle = ({ id, config }: { id: string; config: ChartConfig }) => {
  const colorConfig = Object.entries(config).filter(([, entry]) => entry.color !== undefined);
  if (colorConfig.length === 0) return null;

  return (
    <style
      dangerouslySetInnerHTML={{
        __html: `[data-chart=${id}] {\n${colorConfig.map(([key, entry]) => `  --color-${key}: ${entry.color};`).join('\n')}\n}`,
      }}
    />
  );
};

const ChartTooltip = RechartsPrimitive.Tooltip;

type TooltipNameType = number | string;

function ChartTooltipContent({
  active,
  payload,
  className,
  indicator = 'dot',
  hideLabel = false,
  hideIndicator = false,
  label,
  labelFormatter,
  labelClassName,
  formatter,
  color,
  nameKey,
  labelKey,
}: React.ComponentProps<typeof RechartsPrimitive.Tooltip> &
  React.ComponentProps<'div'> & {
    hideLabel?: boolean;
    hideIndicator?: boolean;
    indicator?: 'line' | 'dot' | 'dashed';
    nameKey?: string;
    labelKey?: string;
  } & Omit<RechartsPrimitive.DefaultTooltipContentProps<TooltipValueType, TooltipNameType>, 'accessibilityLayer'>) {
  const { config } = useChart();

  const tooltipLabel = React.useMemo(() => {
    if (hideLabel || !payload?.length) return null;
    const [item] = payload;
    const key = `${labelKey ?? item?.dataKey ?? item?.name ?? 'value'}`;
    const itemConfig = getPayloadConfigFromPayload(config, item, key);
    const value = !labelKey && typeof label === 'string' ? (config[label]?.label ?? label) : itemConfig?.label;

    if (labelFormatter) {
      return <div className={cn('font-semibold text-ink', labelClassName)}>{labelFormatter(value, payload)}</div>;
    }
    if (!value) return null;
    return <div className={cn('font-semibold text-ink', labelClassName)}>{value}</div>;
  }, [label, labelFormatter, payload, hideLabel, labelClassName, config, labelKey]);

  if (!active || !payload?.length) return null;

  const nestLabel = payload.length === 1 && indicator !== 'dot';

  return (
    <div
      className={cn(
        'grid min-w-32 items-start gap-1.5 rounded-input border border-line bg-ground-1 px-2.5 py-1.5 text-xs shadow-[var(--sc-shadow-panel)]',
        className,
      )}
    >
      {!nestLabel ? tooltipLabel : null}
      <div className="grid gap-1.5">
        {payload
          .filter((item) => item.type !== 'none')
          .map((item, index) => {
            const key = `${nameKey ?? item.name ?? item.dataKey ?? 'value'}`;
            const itemConfig = getPayloadConfigFromPayload(config, item, key);
            const indicatorColor = color ?? item.payload?.fill ?? item.color;

            return (
              <div
                key={index}
                className={cn(
                  'flex w-full flex-wrap items-stretch gap-2 [&>svg]:h-2.5 [&>svg]:w-2.5 [&>svg]:text-ink-3',
                  indicator === 'dot' && 'items-center',
                )}
              >
                {formatter && item?.value !== undefined && item.name ? (
                  formatter(item.value, item.name, item, index, item.payload)
                ) : (
                  <>
                    {!hideIndicator ? (
                      <div
                        className={cn('shrink-0 rounded-[2px] border-(--color-border) bg-(--color-bg)', {
                          'h-2.5 w-2.5': indicator === 'dot',
                          'w-1': indicator === 'line',
                          'w-0 border-[1.5px] border-dashed bg-transparent': indicator === 'dashed',
                          'my-0.5': nestLabel && indicator === 'dashed',
                        })}
                        style={{ '--color-bg': indicatorColor, '--color-border': indicatorColor } as React.CSSProperties}
                      />
                    ) : null}
                    <div className={cn('flex flex-1 justify-between leading-none', nestLabel ? 'items-end' : 'items-center')}>
                      <div className="grid gap-1.5">
                        {nestLabel ? tooltipLabel : null}
                        <span className="text-ink-2">{itemConfig?.label ?? item.name}</span>
                      </div>
                      {item.value != null ? (
                        <span className="font-mono font-medium text-ink tabular-nums">
                          {typeof item.value === 'number' ? item.value.toLocaleString() : String(item.value)}
                        </span>
                      ) : null}
                    </div>
                  </>
                )}
              </div>
            );
          })}
      </div>
    </div>
  );
}

const ChartLegend = RechartsPrimitive.Legend;

function ChartLegendContent({
  className,
  hideIcon = false,
  payload,
  verticalAlign = 'bottom',
  nameKey,
}: React.ComponentProps<'div'> & { hideIcon?: boolean; nameKey?: string } & RechartsPrimitive.DefaultLegendContentProps) {
  const { config } = useChart();
  if (!payload?.length) return null;

  return (
    <div className={cn('flex items-center justify-center gap-4', verticalAlign === 'top' ? 'pb-3' : 'pt-3', className)}>
      {payload
        .filter((item) => item.type !== 'none')
        .map((item, index) => {
          const key = `${nameKey ?? item.dataKey ?? 'value'}`;
          const itemConfig = getPayloadConfigFromPayload(config, item, key);

          return (
            <div key={index} className="flex items-center gap-1.5 text-ink-2 [&>svg]:h-3 [&>svg]:w-3">
              {!hideIcon ? <div className="h-2 w-2 shrink-0 rounded-[2px]" style={{ backgroundColor: item.color }} /> : null}
              {itemConfig?.label}
            </div>
          );
        })}
    </div>
  );
}

function getPayloadConfigFromPayload(config: ChartConfig, payload: unknown, key: string) {
  if (typeof payload !== 'object' || payload === null) return undefined;

  const payloadPayload =
    'payload' in payload && typeof payload.payload === 'object' && payload.payload !== null ? payload.payload : undefined;

  let configLabelKey: string = key;

  if (key in payload && typeof payload[key as keyof typeof payload] === 'string') {
    configLabelKey = payload[key as keyof typeof payload] as string;
  } else if (
    payloadPayload &&
    key in payloadPayload &&
    typeof payloadPayload[key as keyof typeof payloadPayload] === 'string'
  ) {
    configLabelKey = payloadPayload[key as keyof typeof payloadPayload] as string;
  }

  return configLabelKey in config ? config[configLabelKey] : config[key];
}

export { ChartContainer, ChartLegend, ChartLegendContent, ChartStyle, ChartTooltip, ChartTooltipContent };
