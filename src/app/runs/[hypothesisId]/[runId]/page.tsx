"use client";

import { toast } from "sonner";
import { useEffect, useState, useCallback, useRef, use } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/status-badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import type { Hypothesis, StatusResponse, RunResult, MetricsResponse, MetricSeries } from "@/lib/api";
import { getHypothesis, getStatus, getEvents, getResults, stopRun, downloadBundle, deleteResult, getMetrics } from "@/lib/api";
import { MetricChart, type PlotSeries } from "@/components/metric-chart";
import { useRouter } from "next/navigation";
import {
  ArrowLeftIcon, SquareIcon, DownloadIcon, Trash2Icon,
  ClockIcon, ZapIcon, ShieldCheckIcon, AlertTriangleIcon, LayersIcon, Loader2Icon,
} from "lucide-react";

function formatElapsed(secs: number): string {
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`;
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
}

interface EventItem {
  type: string;
  timestamp: string;
  [key: string]: unknown;
}

export default function RunDetailPage({
  params,
}: {
  params: Promise<{ hypothesisId: string; runId: string }>;
}) {
  const { hypothesisId, runId } = use(params);
  const router = useRouter();
  const [hypothesis, setHypothesis] = useState<Hypothesis | null>(null);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);
  const [events, setEvents] = useState<EventItem[]>([]);
  const [metrics, setMetrics] = useState<MetricsResponse | null>(null);
  const [tab, setTab] = useState<"stats" | "events" | "metrics">("stats");
  // Grafana-style shared window. `null` means the whole hypothesis run;
  // otherwise `[fromMs, toMs]` drives the x-axis of every chart. Updated by
  // drag-select on any chart; double-click on a chart clears it.
  const [customRange, setCustomRange] = useState<[number, number] | null>(null);
  const [downloading, setDownloading] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const isRunning = status?.status === "running" && status?.run_id === runId;

  const loadData = useCallback(async () => {
    try {
      // Fetch every sample for this run; the range picker happens client-side
      // so drag-zooming is instant instead of triggering refetches.
      const [h, s, evText, results, m] = await Promise.all([
        getHypothesis(hypothesisId),
        getStatus(hypothesisId),
        getEvents(hypothesisId).catch(() => ""),
        getResults(hypothesisId).catch(() => []),
        getMetrics(hypothesisId, runId).catch(() => null),
      ]);
      setHypothesis(h);
      setStatus(s);
      if (m) setMetrics(m);

      // Find this run's result
      const thisResult = results.find((r) => r.run_id === runId);
      if (thisResult) setResult(thisResult);

      // Parse events for this run
      const parsed: EventItem[] = [];
      for (const line of evText.split("\n")) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.run_id === runId || !ev.run_id) parsed.push(ev);
        } catch { /* skip */ }
      }
      setEvents(parsed.slice(-200).reverse());
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to load");
    }
  }, [hypothesisId, runId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    if (isRunning) {
      pollRef.current = setInterval(loadData, 2000);
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [isRunning, loadData]);

  async function handleStop() {
    try {
      await stopRun(hypothesisId);
      toast.success("Run stopped");
      loadData();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to stop");
    }
  }

  async function handleDownload() {
    setDownloading(true);
    try {
      await downloadBundle(hypothesisId);
      toast.success("Bundle downloaded");
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Download failed");
    } finally {
      setDownloading(false);
    }
  }

  async function handleDelete() {
    if (!result) return;
    if (!confirm("Delete this run? This cannot be undone.")) return;
    try {
      await deleteResult(hypothesisId, result.id);
      toast.success("Run deleted");
      router.push(`/templates/${hypothesisId}`);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Delete failed");
    }
  }

  const progress = status?.run_id === runId ? status?.progress : null;
  const ops = progress?.completed_ops ?? result?.total_response_ops ?? 0;
  const opsPerSec = progress?.ops_per_sec ?? 0;
  const elapsed = progress?.elapsed_secs ?? 0;
  const checkPassed = progress?.passed_checkpoints ?? result?.passed_checkpoints ?? 0;
  const checkTotal = progress?.total_checkpoints ?? result?.total_checkpoints ?? 0;
  const checkFailed = progress?.failed_checkpoints ?? result?.failed_checkpoints ?? 0;
  const failures = progress?.safety_violations ?? result?.safety_violations ?? 0;

  // Hypothesis run time window (ms). For a running run we extrapolate from
  // elapsed_secs because the status endpoint doesn't report a started_at.
  const runEndMs =
    result?.finished_at != null
      ? Date.parse(result.finished_at)
      : Date.now();
  const runStartMs =
    result?.started_at != null
      ? Date.parse(result.started_at)
      : isRunning
        ? Date.now() - elapsed * 1000
        : runEndMs;

  // Effective `[from, to]` for the metrics tab. Starts as the full run
  // window; drag-selecting on any chart narrows it, double-clicking any chart
  // resets it back to the full run.
  const effectiveFrom = customRange ? customRange[0] : runStartMs;
  const effectiveTo   = customRange ? customRange[1] : runEndMs;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Link href="/runs">
          <Button variant="ghost" size="sm">
            <ArrowLeftIcon className="size-4 mr-1" /> Runs
          </Button>
        </Link>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold text-zinc-100">
              {hypothesis?.name ?? "..."}
            </h1>
            <StatusBadge status={isRunning ? "running" : (result?.stop_reason === "completed" ? "passed" : status?.status ?? "idle") as "idle" | "running" | "passed" | "failed" | "stopped"} />
            <span className="font-mono text-xs text-zinc-500">
              {runId.slice(-12)}
            </span>
          </div>
        </div>
        <div className="flex gap-2">
          {isRunning && (
            <Button variant="destructive" size="sm" onClick={handleStop}>
              <SquareIcon className="size-3 mr-1" /> Stop
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={handleDownload} disabled={downloading}>
            {downloading ? <Loader2Icon className="size-3 mr-1 animate-spin" /> : <DownloadIcon className="size-3 mr-1" />}
            {downloading ? "Preparing..." : "Bundle"}
          </Button>
          {!isRunning && result && (
            <Button variant="destructive" size="sm" onClick={handleDelete}>
              <Trash2Icon className="size-3 mr-1" /> Delete
            </Button>
          )}
        </div>
      </div>

      {/* Progress bar for running */}
      {isRunning && (
        <div className="h-1 rounded-full bg-zinc-800 overflow-hidden">
          <div className="h-full bg-blue-500 animate-pulse" style={{ width: "100%" }} />
        </div>
      )}

      {/* Stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <StatCard icon={<LayersIcon className="size-4" />} label="Total Ops" value={ops.toLocaleString()} highlight={isRunning} />
        <StatCard icon={<ZapIcon className="size-4" />} label="Ops/sec" value={isRunning ? Math.round(opsPerSec).toString() : "-"} highlight={isRunning} color="text-blue-400" />
        <StatCard icon={<ClockIcon className="size-4" />} label="Elapsed" value={elapsed > 0 ? formatElapsed(elapsed) : "-"} highlight={isRunning} />
        <StatCard icon={<ShieldCheckIcon className="size-4" />} label="Checkpoints" value={`${checkPassed}/${checkTotal}`} color={checkFailed > 0 ? "text-red-400" : "text-emerald-400"} />
        <StatCard icon={<AlertTriangleIcon className="size-4" />} label="Failures" value={failures.toString()} color={failures > 0 ? "text-red-400" : "text-zinc-400"} />
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-zinc-800">
        <button
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${tab === "stats" ? "border-blue-500 text-zinc-100" : "border-transparent text-zinc-500 hover:text-zinc-300"}`}
          onClick={() => setTab("stats")}
        >
          Details
        </button>
        <button
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${tab === "metrics" ? "border-blue-500 text-zinc-100" : "border-transparent text-zinc-500 hover:text-zinc-300"}`}
          onClick={() => setTab("metrics")}
        >
          Metrics{metrics ? ` (${metrics.metrics.length})` : ""}
        </button>
        <button
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${tab === "events" ? "border-blue-500 text-zinc-100" : "border-transparent text-zinc-500 hover:text-zinc-300"}`}
          onClick={() => setTab("events")}
        >
          Events ({events.length})
        </button>
      </div>

      {/* Tab content */}
      {tab === "stats" && (
        <div className="space-y-4">
          <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4 space-y-3">
            <h3 className="text-sm font-semibold text-zinc-300">Run Info</h3>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div><span className="text-zinc-500">Template:</span> <Link href={`/templates/${hypothesisId}`} className="text-zinc-200 hover:underline">{hypothesis?.name}</Link></div>
              <div><span className="text-zinc-500">Generator:</span> <span className="text-zinc-200 font-mono">{hypothesis?.generator}</span></div>
              <div><span className="text-zinc-500">Adapter:</span> <span className="text-zinc-200 font-mono">{hypothesis?.adapter || "none"}</span></div>
              <div><span className="text-zinc-500">Duration:</span> <span className="text-zinc-200 font-mono">{hypothesis?.duration || "forever"}</span></div>
              {result && <div><span className="text-zinc-500">Stop reason:</span> <span className="text-zinc-200">{result.stop_reason}</span></div>}
              {result?.finished_at && <div><span className="text-zinc-500">Finished:</span> <span className="text-zinc-200">{new Date(result.finished_at).toLocaleString()}</span></div>}
            </div>
          </div>
        </div>
      )}

      {tab === "metrics" && (
        <MetricsTab
          metrics={metrics}
          xMin={effectiveFrom}
          xMax={effectiveTo}
          isCustomRange={customRange != null}
          onRangeSelect={(fromMs, toMs) => setCustomRange([fromMs, toMs])}
          onRangeReset={() => setCustomRange(null)}
        />
      )}

      {tab === "events" && (
        <div className="rounded-lg border border-zinc-800 overflow-hidden max-h-[600px] overflow-y-auto">
          {events.length === 0 ? (
            <p className="text-zinc-500 text-center py-8 text-sm">No events</p>
          ) : (
            <div className="divide-y divide-zinc-800">
              {events.map((ev, i) => (
                <EventRow key={i} ev={ev} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StatCard({ icon, label, value, highlight, color }: {
  icon: React.ReactNode; label: string; value: string; highlight?: boolean; color?: string;
}) {
  return (
    <div className={`rounded-lg border border-zinc-800 bg-zinc-900 p-3 ${highlight ? "ring-1 ring-blue-500/30" : ""}`}>
      <div className="flex items-center gap-2 text-zinc-500 text-xs mb-1">
        {icon} {label}
      </div>
      <div className={`text-lg font-semibold font-mono ${color ?? "text-zinc-100"}`}>
        {value}
      </div>
    </div>
  );
}

function EventRow({ ev }: { ev: EventItem }) {
  const [expanded, setExpanded] = useState(false);
  const expandable = ev.type === "OperationBatch" || ev.type === "SafetyViolation";
  const ops = ev.type === "OperationBatch" && Array.isArray(ev.ops)
    ? ev.ops as Array<{op_id: string; op_type: string; payload: Record<string, unknown>; status: string}>
    : null;

  return (
    <div>
      <div
        className={`flex items-center gap-3 px-3 py-2 text-xs ${expandable ? "cursor-pointer hover:bg-zinc-800/50" : ""} ${ev.type === "SafetyViolation" ? "bg-red-500/5" : ""} ${ev.type === "Checkpoint" && ev.passed === false ? "bg-red-500/5" : ""}`}
        onClick={() => expandable && setExpanded(!expanded)}
      >
        <span className="font-mono text-zinc-500 w-[75px] shrink-0">
          {ev.timestamp ? new Date(ev.timestamp).toLocaleTimeString() : "-"}
        </span>
        <span className="w-[130px] shrink-0"><EventBadge type={ev.type} /></span>
        <span className="font-mono text-zinc-400 truncate flex-1">
          {eventSummary(ev)}
        </span>
        {expandable && (
          <span className="text-zinc-600 shrink-0">{expanded ? "▼" : "▶"}</span>
        )}
      </div>
      {expanded && ev.type === "OperationBatch" && ops && (
        <div className="bg-zinc-900/50 border-t border-zinc-800 px-4 py-2 space-y-1">
          {ops.map((op: Record<string, unknown>, j: number) => {
            const verified = op.verified as boolean | undefined;
            const expected = op.expected as unknown;
            const actual = op.actual as unknown;
            const payload = op.payload as Record<string, unknown>;
            const response = op.response as Record<string, unknown> | undefined;
            const hasResponse = response && Object.keys(response).length > 0;
            return (
              <div key={j}>
                <div className="flex items-center gap-2 font-mono text-xs">
                  <span className="text-zinc-500 w-[70px]">{String(op.op_id)}</span>
                  <span className={`w-[100px] ${op.status === "ok" ? "text-emerald-400" : op.status === "not_found" ? "text-amber-400" : "text-red-400"}`}>
                    {String(op.op_type)}
                  </span>
                  <span className="text-zinc-400 flex-1 truncate">
                    {Object.entries(payload).map(([k, v]) => `${k}=${v}`).join(" ")}
                  </span>
                  <span className={`w-[80px] text-right ${op.status === "ok" ? "text-emerald-400" : op.status === "not_found" ? "text-amber-400" : "text-red-400"}`}>
                    {String(op.status)}
                  </span>
                  {verified !== undefined && (
                    <span className={`w-[16px] text-right ${verified ? "text-emerald-400" : "text-red-400"}`}>
                      {verified ? "✓" : "✗"}
                    </span>
                  )}
                </div>
                {hasResponse && (
                  <div className="ml-[78px] mt-0.5 text-xs font-mono text-zinc-500">
                    <span className="text-zinc-600">response: </span>
                    {Object.entries(response).map(([k, v]) => (
                      <span key={k} className="mr-2">
                        <span className="text-zinc-500">{k}=</span>
                        <span className="text-zinc-400">{typeof v === "object" ? JSON.stringify(v) : String(v)}</span>
                      </span>
                    ))}
                  </div>
                )}
                {verified === false && expected !== undefined && (
                  <div className="ml-[78px] mt-0.5 mb-1 text-xs font-mono">
                    <span className="text-emerald-400">expected: </span>
                    <span className="text-zinc-300">{JSON.stringify(expected)}</span>
                    <span className="text-red-400 ml-3">actual: </span>
                    <span className="text-zinc-300">{JSON.stringify(actual)}</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {expanded && ev.type === "SafetyViolation" && (
        <div className="bg-red-500/5 border-t border-red-800/30 px-4 py-2 space-y-1 font-mono text-xs">
          <div className="text-zinc-400">Op: <span className="text-zinc-200">{String(ev.op_id)} ({String(ev.op)})</span></div>
          <div className="text-emerald-400">Expected: <span className="text-zinc-200">{String(ev.expected)}</span></div>
          <div className="text-red-400">Actual: <span className="text-zinc-200">{String(ev.actual)}</span></div>
        </div>
      )}
    </div>
  );
}

function EventBadge({ type }: { type: string }) {
  const colors: Record<string, string> = {
    RunStarted: "bg-blue-500/10 text-blue-400 border-blue-800",
    RunCompleted: "bg-emerald-500/10 text-emerald-400 border-emerald-800",
    RunStopped: "bg-amber-500/10 text-amber-400 border-amber-800",
    OperationBatch: "bg-indigo-500/10 text-indigo-400 border-indigo-800",
    BatchFailed: "bg-red-500/10 text-red-400 border-red-800",
    Checkpoint: "bg-cyan-500/10 text-cyan-400 border-cyan-800",
    SafetyViolation: "bg-red-500/10 text-red-400 border-red-800",
  };
  return (
    <Badge variant="outline" className={`text-xs font-mono ${colors[type] ?? "border-zinc-700 text-zinc-400"}`}>
      {type}
    </Badge>
  );
}

function eventSummary(ev: EventItem): string {
  const parts: string[] = [];
  if (ev.batch_id) parts.push(`batch=${ev.batch_id}`);

  // OperationBatch — show ops summary + duration
  if (ev.type === "OperationBatch" && Array.isArray(ev.ops)) {
    const ops = ev.ops as Array<{op_id: string; op_type: string; payload: Record<string, unknown>; status: string}>;
    parts.push(`${ops.length} ops`);
    if (ev.duration_ms !== undefined) parts.push(`${ev.duration_ms}ms`);
    const types = new Map<string, number>();
    for (const op of ops) {
      types.set(op.op_type, (types.get(op.op_type) || 0) + 1);
    }
    const summary = Array.from(types.entries()).map(([t, c]) => `${t}:${c}`).join(", ");
    parts.push(summary);
    const failed = ops.filter(o => o.status !== "ok" && o.status !== "not_found");
    if (failed.length > 0) parts.push(`⚠ ${failed.length} non-ok`);
    return parts.join(" | ");
  }

  // Checkpoint — show passed/failed + keys + duration
  if (ev.type === "Checkpoint") {
    if (ev.checkpoint_id) parts.push(String(ev.checkpoint_id));
    parts.push(ev.passed ? "✓ passed" : "✗ failed");
    if (ev.keys !== undefined) parts.push(`${ev.keys} keys`);
    if (ev.duration_ms !== undefined) parts.push(`${ev.duration_ms}ms`);
    if (!ev.passed && Array.isArray(ev.details)) {
      const failed = (ev.details as Array<{matched: boolean}>).filter(d => !d.matched).length;
      parts.push(`${failed} mismatched`);
    }
    return parts.join(" | ");
  }

  // SafetyViolation — show the mismatch clearly
  if (ev.type === "SafetyViolation") {
    if (ev.op_id) parts.push(`${ev.op_id}`);
    if (ev.op) parts.push(`${ev.op}`);
    if (ev.expected) parts.push(`expected: ${ev.expected}`);
    if (ev.actual) parts.push(`actual: ${ev.actual}`);
    return parts.join(" | ");
  }

  if (ev.duration_ms !== undefined) parts.push(`${ev.duration_ms}ms`);
  if (ev.size !== undefined) parts.push(`ops=${ev.size}`);
  if (ev.keys_checked !== undefined) parts.push(`keys=${ev.keys_checked}`);
  if (ev.failures !== undefined) parts.push(`failures=${ev.failures}`);
  if (ev.pass_rate !== undefined) parts.push(`pass_rate=${ev.pass_rate}`);
  if (ev.stop_reason) parts.push(`reason=${ev.stop_reason}`);
  if (ev.error) parts.push(`error=${ev.error}`);
  return parts.join(" | ") || "-";
}

// ── Metrics tab ──────────────────────────────────────────────────────────
//
// The pilot scrapes the Java SDK's Prometheus exporter and stores one sample
// per series per scrape. Here we turn those raw samples into chart-friendly
// panels rendered with uPlot:
//   - Ops / sec         — rate of regret_adapter_op_total by op_type
//   - P50 op latency    — from regret_adapter_op_duration_seconds_p50
//   - P99 op latency    — from regret_adapter_op_duration_seconds_p99
//   - gRPC errors / sec — rate of regret_adapter_grpc_errors_total by method
//
// P50/P95/P99 are computed server-side in pilot/src/api/metrics.rs via
// histogram_quantile on the stored `_bucket` samples, so the frontend only
// has to plot them directly.

function formatRange(fromMs: number, toMs: number): string {
  const sameDay = new Date(fromMs).toDateString() === new Date(toMs).toDateString();
  const opts: Intl.DateTimeFormatOptions = sameDay
    ? { hour: "2-digit", minute: "2-digit", second: "2-digit" }
    : { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" };
  return `${new Date(fromMs).toLocaleString(undefined, opts)} → ${new Date(toMs).toLocaleString(undefined, opts)}`;
}

function MetricsTab({
  metrics,
  xMin,
  xMax,
  isCustomRange,
  onRangeSelect,
  onRangeReset,
}: {
  metrics: MetricsResponse | null;
  xMin: number;
  xMax: number;
  isCustomRange: boolean;
  onRangeSelect: (fromMs: number, toMs: number) => void;
  onRangeReset: () => void;
}) {
  if (!metrics) {
    return <p className="text-zinc-500 text-center py-8 text-sm">Loading metrics…</p>;
  }
  const hasAny = metrics.metrics.some((m) => m.series.some((s) => s.points.length > 0));

  const byName: Record<string, MetricSeries[]> = Object.fromEntries(
    metrics.metrics.map((g) => [g.name, g.series]),
  );

  const opsRate = groupByLabel(byName["regret_adapter_op_total"] ?? [], "op_type")
    .map((s) => ({ label: s.label, points: rateOfCounter(s.points) }))
    .filter((s) => s.points.length > 0);

  const opP50 = seriesToPlot(byName["regret_adapter_op_duration_seconds_p50"] ?? [], "op_type");
  const opP99 = seriesToPlot(byName["regret_adapter_op_duration_seconds_p99"] ?? [], "op_type");

  const errRate = groupByLabel(byName["regret_adapter_grpc_errors_total"] ?? [], "method")
    .map((s) => ({ label: s.label, points: rateOfCounter(s.points) }))
    .filter((s) => s.points.length > 0);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <span className="font-mono text-zinc-400">{formatRange(xMin, xMax)}</span>
        {isCustomRange ? (
          <button
            type="button"
            onClick={onRangeReset}
            className="px-2 py-0.5 rounded border border-zinc-700 text-zinc-300 hover:border-zinc-500 hover:text-zinc-100"
            title="Reset the shared range to the full run"
          >
            Reset range
          </button>
        ) : (
          <span className="text-zinc-600">drag on any chart to zoom · double-click to reset</span>
        )}
      </div>

      {!hasAny ? (
        <p className="text-zinc-500 text-center py-8 text-sm">No metrics in this window.</p>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <ChartCard title="Ops / sec"         subtitle="regret_adapter_op_total (by op_type)"                series={opsRate} unit="/s" xMin={xMin} xMax={xMax} onRangeSelect={onRangeSelect} onRangeReset={onRangeReset} />
          <ChartCard title="P50 op latency"    subtitle="regret_adapter_op_duration_seconds p50 (by op_type)" series={opP50}   unit="s"  xMin={xMin} xMax={xMax} onRangeSelect={onRangeSelect} onRangeReset={onRangeReset} />
          <ChartCard title="P99 op latency"    subtitle="regret_adapter_op_duration_seconds p99 (by op_type)" series={opP99}   unit="s"  xMin={xMin} xMax={xMax} onRangeSelect={onRangeSelect} onRangeReset={onRangeReset} />
          <ChartCard title="gRPC errors / sec" subtitle="regret_adapter_grpc_errors_total (by method)"        series={errRate} unit="/s" xMin={xMin} xMax={xMax} onRangeSelect={onRangeSelect} onRangeReset={onRangeReset} />
        </div>
      )}
    </div>
  );
}

function ChartCard({
  title,
  subtitle,
  series,
  unit,
  xMin,
  xMax,
  onRangeSelect,
  onRangeReset,
}: {
  title: string;
  subtitle: string;
  series: PlotSeries[];
  unit: string;
  xMin?: number;
  xMax?: number;
  onRangeSelect?: (fromMs: number, toMs: number) => void;
  onRangeReset?: () => void;
}) {
  // `min-w-0` is critical: CSS grid items default to `min-width: auto`, which
  // lets a wide legend push the whole card past its grid cell.
  return (
    <div className="min-w-0 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900 p-4">
      <div className="mb-2">
        <h3 className="text-sm font-semibold text-zinc-200">{title}</h3>
        <p className="text-xs text-zinc-500 font-mono">{subtitle}</p>
      </div>
      <MetricChart
        series={series}
        unit={unit}
        height={200}
        xMin={xMin}
        xMax={xMax}
        onRangeSelect={onRangeSelect}
        onRangeReset={onRangeReset}
      />
    </div>
  );
}

// ── Data shaping helpers ─────────────────────────────────────────────────

// Group a list of (counter) series by a single label key, summing values of
// series that share the same value of that key across any other labels.
function groupByLabel(series: MetricSeries[], labelKey: string): PlotSeries[] {
  const buckets = new Map<string, Map<number, number>>();
  for (const s of series) {
    const label = s.labels[labelKey] || "—";
    let agg = buckets.get(label);
    if (!agg) {
      agg = new Map();
      buckets.set(label, agg);
    }
    for (const [ts, v] of s.points) {
      agg.set(ts, (agg.get(ts) ?? 0) + v);
    }
  }
  return Array.from(buckets.entries())
    .map(([label, m]) => ({
      label,
      points: Array.from(m.entries()).sort((a, b) => a[0] - b[0]) as [number, number][],
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

// Compute per-second rate from a monotonic counter series. Counter resets are
// treated as a zero delta so a single bad scrape doesn't pull the series down.
function rateOfCounter(points: [number, number][]): [number, number][] {
  if (points.length < 2) return [];
  const out: [number, number][] = [];
  for (let i = 1; i < points.length; i++) {
    const [t0, v0] = points[i - 1];
    const [t1, v1] = points[i];
    const dtSec = (t1 - t0) / 1000;
    if (dtSec <= 0) continue;
    const dv = Math.max(0, v1 - v0);
    out.push([t1, dv / dtSec]);
  }
  return out;
}

// Convert raw API series into PlotSeries, grouping by `labelKey` (e.g. op_type)
// and passing values through unchanged. Used for pre-computed percentile groups
// where the server already did the math.
function seriesToPlot(series: MetricSeries[], labelKey: string): PlotSeries[] {
  return series
    .map((s) => ({
      label: s.labels[labelKey] || "—",
      points: s.points.slice().sort((a, b) => a[0] - b[0]) as [number, number][],
    }))
    .filter((s) => s.points.length > 0)
    .sort((a, b) => a.label.localeCompare(b.label));
}
