"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import uPlot, { type AlignedData } from "uplot";
import "uplot/dist/uPlot.min.css";

export interface PlotSeries {
  label: string;
  /** `[ts_ms, value]` pairs, time-ordered. */
  points: [number, number][];
}

interface Props {
  series: PlotSeries[];
  /** Value unit hint for axis / legend formatting: `"s"`, `"/s"`, `"ops"`, `""`. */
  unit: string;
  height?: number;
  /** Lock the x-axis to this window (epoch ms). Defaults to auto scale. */
  xMin?: number;
  xMax?: number;
  /** Fired when the user drag-selects a sub-range (epoch ms). */
  onRangeSelect?: (fromMs: number, toMs: number) => void;
  /** Fired when the user double-clicks the chart to reset zoom. */
  onRangeReset?: () => void;
}

const CHART_COLORS = [
  "#60a5fa", "#34d399", "#f59e0b", "#f87171", "#a78bfa",
  "#22d3ee", "#fb923c", "#fbbf24", "#4ade80", "#e879f9",
  "#f472b6", "#2dd4bf", "#fde047", "#c084fc", "#38bdf8",
];

function seriesColor(i: number): string {
  return CHART_COLORS[i % CHART_COLORS.length];
}

export function formatValue(v: number | null | undefined, unit: string): string {
  if (v == null || !isFinite(v as number)) return "—";
  const n = v as number;
  if (unit === "s") {
    if (n >= 1) return `${n.toFixed(2)}s`;
    if (n >= 0.001) return `${(n * 1000).toFixed(2)}ms`;
    if (n > 0) return `${(n * 1_000_000).toFixed(0)}µs`;
    return "0";
  }
  if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(1)}k${unit}`;
  if (Math.abs(n) >= 10) return `${n.toFixed(0)}${unit}`;
  return `${n.toFixed(2)}${unit}`;
}

/**
 * Build uPlot's AlignedData shape: `[xs, y1, y2, …]`.
 * Each ys[i] is aligned to xs, filling missing timestamps with `null` so
 * uPlot renders gaps instead of interpolating across them.
 */
function buildData(series: PlotSeries[]): AlignedData {
  const tsSet = new Set<number>();
  for (const s of series) {
    for (const [t] of s.points) tsSet.add(Math.round(t / 1000)); // uPlot wants seconds
  }
  const xs = Array.from(tsSet).sort((a, b) => a - b);

  const ys: (number | null)[][] = series.map((s) => {
    const map = new Map<number, number>();
    for (const [t, v] of s.points) map.set(Math.round(t / 1000), v);
    return xs.map((t) => (map.has(t) ? (map.get(t) as number) : null));
  });

  return [xs, ...ys] as unknown as AlignedData;
}

/** Latest non-null value in a series, or null if empty. */
function lastValue(series: PlotSeries): number | null {
  for (let i = series.points.length - 1; i >= 0; i--) {
    const v = series.points[i][1];
    if (v != null && isFinite(v)) return v;
  }
  return null;
}

export function MetricChart({
  series,
  unit,
  height = 200,
  xMin,
  xMax,
  onRangeSelect,
  onRangeReset,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  // Latest callbacks — stashed in refs so the uPlot hooks (captured once on
  // chart creation) always see the current React handlers without having to
  // recreate the chart on every parent re-render.
  const onSelectRef = useRef(onRangeSelect);
  const onResetRef = useRef(onRangeReset);
  useEffect(() => { onSelectRef.current = onRangeSelect; }, [onRangeSelect]);
  useEffect(() => { onResetRef.current  = onRangeReset;  }, [onRangeReset]);

  const [width, setWidth] = useState<number>(0);
  // Which x index the cursor is over; null when not hovering.
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  // Solo: when set to an index i, only series i is visible. Null = show all.
  const [soloIdx, setSoloIdx] = useState<number | null>(null);

  const data = useMemo(() => buildData(series), [series]);

  // uPlot wants seconds, not milliseconds, on time axes.
  const xMinSec = xMin != null ? Math.floor(xMin / 1000) : undefined;
  const xMaxSec = xMax != null ? Math.ceil(xMax / 1000) : undefined;

  // Observe container width so the chart fits the parent card.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // Create (and destroy) the uPlot instance.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || width === 0 || series.length === 0) return;

    // Avoid stacking child nodes from previous mounts.
    el.innerHTML = "";

    const opts: uPlot.Options = {
      width,
      height,
      padding: [10, 16, 0, 0],
      cursor: {
        // Drag to select; `setScale: false` means uPlot won't self-zoom.
        // The selection gets converted to a shared-range update in the
        // `setSelect` hook below, and the page propagates it to every chart.
        drag: { x: true, y: false, setScale: false, uni: 50 },
        focus: { prox: 16 },
      },
      select: { show: true, left: 0, top: 0, width: 0, height: 0 },
      focus: { alpha: 0.3 },
      // Disable uPlot's built-in table legend — we render our own React
      // legend below so labels are always visible and can wrap cleanly.
      legend: { show: false },
      scales: {
        x: {
          time: true,
          // Pin the visible window to the caller's [xMin, xMax] when given.
          // Without this, uPlot auto-scales to the sample extents and the
          // chart width changes every time samples arrive.
          range:
            xMinSec != null && xMaxSec != null && xMaxSec > xMinSec
              ? () => [xMinSec, xMaxSec]
              : undefined,
        },
        y: { auto: true },
      },
      axes: [
        {
          stroke: "#a1a1aa",
          grid: { stroke: "#27272a", width: 1 },
          ticks: { stroke: "#3f3f46", width: 1 },
          font: "11px ui-monospace, SFMono-Regular, Menlo, monospace",
        },
        {
          stroke: "#a1a1aa",
          grid: { stroke: "#27272a", width: 1 },
          ticks: { stroke: "#3f3f46", width: 1 },
          font: "11px ui-monospace, SFMono-Regular, Menlo, monospace",
          size: (self, values) => {
            if (!values || values.length === 0) return 60;
            const maxLen = Math.max(...values.map((v) => String(v).length));
            return Math.max(60, maxLen * 8 + 12);
          },
          values: (_u, splits) => splits.map((v) => formatValue(v, unit)),
        },
      ],
      series: [
        { label: "time" },
        ...series.map((s, i) => ({
          label: s.label,
          stroke: seriesColor(i),
          width: 1.5,
          points: { show: false },
        })),
      ],
      hooks: {
        setCursor: [
          (u) => {
            const idx = u.cursor.idx;
            setHoverIdx(idx == null ? null : idx);
          },
        ],
        setSelect: [
          (u) => {
            const sel = u.select;
            if (!sel || sel.width <= 2) return; // ignore accidental taps
            // Convert pixel selection → x-scale values → epoch ms.
            const fromSec = u.posToVal(sel.left, "x");
            const toSec = u.posToVal(sel.left + sel.width, "x");
            if (!isFinite(fromSec) || !isFinite(toSec) || toSec <= fromSec) return;
            onSelectRef.current?.(Math.round(fromSec * 1000), Math.round(toSec * 1000));
            // Clear the blue rectangle — the shared range update will handle
            // showing the new window via the pinned scale.
            u.setSelect({ left: 0, width: 0, top: 0, height: 0 }, false);
          },
        ],
      },
    };

    const plot = new uPlot(opts, data, el);
    plotRef.current = plot;

    // Double-click on the chart resets the shared range.
    const dblHandler = () => onResetRef.current?.();
    el.addEventListener("dblclick", dblHandler);

    return () => {
      el.removeEventListener("dblclick", dblHandler);
      plot.destroy();
      plotRef.current = null;
    };
    // Recreate on structural changes: number of series, unit, size, or locked range.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series.length, unit, height, width, xMinSec, xMaxSec]);

  // Push new data into the existing chart without rebuilding it.
  useEffect(() => {
    if (plotRef.current && series.length > 0) {
      plotRef.current.setData(data);
    }
  }, [data, series.length]);

  // Apply solo state to uPlot: show only the solo'd series, hide the rest.
  useEffect(() => {
    const plot = plotRef.current;
    if (!plot) return;
    // uPlot series are 1-indexed (index 0 is the x axis); pass `false` to
    // skip firing setSeries hooks back at us.
    for (let i = 0; i < series.length; i++) {
      const visible = soloIdx == null || soloIdx === i;
      plot.setSeries(i + 1, { show: visible }, false);
    }
  }, [soloIdx, series.length]);

  const toggleSolo = (i: number) => {
    setSoloIdx((prev) => (prev === i ? null : i));
  };

  // Values to show in the legend: hover value when the cursor is over the
  // plot, otherwise the latest sample for each series (always visible).
  const legendValues: (number | null)[] = useMemo(() => {
    if (hoverIdx == null) return series.map((s) => lastValue(s));
    // hoverIdx is an index into the aligned x axis; map back to each series' y.
    return series.map((_, i) => {
      const col = data[i + 1] as (number | null)[] | undefined;
      return col ? (col[hoverIdx] ?? null) : null;
    });
  }, [hoverIdx, series, data]);

  if (series.length === 0) {
    return <p className="text-xs text-zinc-600 py-8 text-center">no data yet</p>;
  }

  return (
    <div className="min-w-0 w-full">
      <div
        ref={containerRef}
        className="min-w-0 w-full overflow-hidden"
        style={{ height }}
      />
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs font-mono min-w-0">
        {series.map((s, i) => {
          const dimmed = soloIdx != null && soloIdx !== i;
          return (
            <button
              key={s.label}
              type="button"
              onClick={() => toggleSolo(i)}
              className={`flex items-center gap-1.5 cursor-pointer select-none transition-opacity ${
                dimmed ? "opacity-35" : "opacity-100"
              } text-zinc-400 hover:text-zinc-200`}
              title={soloIdx === i ? "Click to show all series" : `Click to solo ${s.label}`}
            >
              <span
                className="inline-block size-2 rounded-sm shrink-0"
                style={{ backgroundColor: seriesColor(i) }}
              />
              <span className="text-zinc-300">{s.label}</span>
              <span className="text-zinc-500">{formatValue(legendValues[i], unit)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
