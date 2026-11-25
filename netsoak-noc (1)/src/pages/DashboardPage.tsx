import { useEffect, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Download,
  Eye,
  EyeOff,
  Play,
  RefreshCw,
  ShieldCheck,
  Square,
  WifiOff,
} from 'lucide-react';
import {
  formatBytesToGb,
  formatDuration,
  formatMbps,
} from '../../shared/networkMath';
import type {
  AppSettings,
  LiveMetricsSnapshot,
  ServerHealthResponse,
  SessionStatus,
  StoredSessionSummary,
  TelemetrySample,
  TestEvent,
} from '../../shared/types';
import { EventLogPanel } from '../components/EventLogPanel';
import { ThroughputChart } from '../components/ThroughputChart';
import { getSessionSamplesDownsampled } from '../database/indexedDb';
import type { BackgroundKeepAliveState } from '../hooks/useBackgroundKeepAlive';
import type { RecoverableSession } from '../hooks/useSoakEngine';
import type { WakeLockState } from '../hooks/useWakeLock';

interface DashboardPageProps {
  activeMetrics: LiveMetricsSnapshot | null;
  rollingSamples: TelemetrySample[];
  liveEvents: TestEvent[];
  history: StoredSessionSummary[];
  serverHealth: ServerHealthResponse | null;
  serverError: string | null;
  settings: AppSettings;
  wakeLock: WakeLockState;
  backgroundKeepAlive: BackgroundKeepAliveState;
  quotaWarning: string | null;
  recoverableSession: RecoverableSession | null;
  onResumeRecovered: () => void;
  onDismissRecovered: () => void;
  onStopTest: () => void;
  onGoToNewTest: () => void;
  onOpenReport: (sessionId: string) => void;
  onExportCsv: (sessionId: string, createdAt: number) => void;
}

const STATUS_META: Record<
  SessionStatus,
  { label: string; colorClass: string; Icon: typeof Activity }
> = {
  initializing: { label: 'Initializing', colorClass: 'text-cyan-400', Icon: RefreshCw },
  running: { label: 'Running', colorClass: 'text-emerald-400', Icon: Activity },
  paused: { label: 'Paused', colorClass: 'text-amber-400', Icon: AlertTriangle },
  reconnecting: { label: 'Reconnecting', colorClass: 'text-amber-400', Icon: RefreshCw },
  completed: { label: 'Completed', colorClass: 'text-emerald-400', Icon: CheckCircle2 },
  stopped: { label: 'Stopped', colorClass: 'text-slate-300', Icon: Square },
  error: { label: 'Error', colorClass: 'text-red-400', Icon: WifiOff },
};

export function DashboardPage({
  activeMetrics,
  rollingSamples,
  liveEvents,
  history,
  serverHealth,
  serverError,
  settings,
  wakeLock,
  backgroundKeepAlive,
  quotaWarning,
  recoverableSession,
  onResumeRecovered,
  onDismissRecovered,
  onStopTest,
  onGoToNewTest,
  onOpenReport,
  onExportCsv,
}: DashboardPageProps) {
  const [chartRange, setChartRange] = useState<'60s' | 'full'>(settings.defaultChartRange);
  const [fullSamples, setFullSamples] = useState<TelemetrySample[]>([]);
  const [loadingFull, setLoadingFull] = useState(false);

  const isRunning =
    activeMetrics?.status === 'running' ||
    activeMetrics?.status === 'initializing' ||
    activeMetrics?.status === 'reconnecting';

  useEffect(() => {
    setChartRange(settings.defaultChartRange);
  }, [settings.defaultChartRange]);

  useEffect(() => {
    if (chartRange !== 'full' || !activeMetrics?.sessionId) return;
    let cancelled = false;
    setLoadingFull(true);
    void getSessionSamplesDownsampled(activeMetrics.sessionId, 240)
      .then((rows) => {
        if (!cancelled) {
          setFullSamples(rows.length > 0 ? rows : rollingSamples);
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingFull(false);
      });
    return () => {
      cancelled = true;
    };
  }, [chartRange, activeMetrics?.sessionId, activeMetrics?.activeTestingSeconds, rollingSamples]);

  const displayedSamples = chartRange === '60s' ? rollingSamples : fullSamples;

  return (
    <div className="space-y-6">
      {recoverableSession && !activeMetrics && (
        <div className="bg-[#0B1120] border border-amber-500/40 rounded-lg p-4 flex flex-wrap items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-sm font-semibold text-amber-300">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              <span>Interrupted Session Detected ({recoverableSession.summary.session_id})</span>
            </div>
            <p className="text-xs text-slate-400">
              Server session is still active with{' '}
              <span className="font-mono tabular-nums text-slate-200">
                {formatDuration(recoverableSession.remainingSeconds)}
              </span>{' '}
              remaining ({recoverableSession.summary.config.direction},{' '}
              {recoverableSession.summary.config.parallelStreams} streams).
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={onDismissRecovered}
              className="px-3.5 py-2 text-xs font-medium text-slate-300 bg-slate-800 hover:bg-slate-700 rounded-md cursor-pointer"
            >
              Mark Stopped
            </button>
            <button
              type="button"
              onClick={onResumeRecovered}
              className="px-4 py-2 text-xs font-semibold bg-cyan-500 hover:bg-cyan-400 text-slate-950 rounded-md cursor-pointer"
            >
              Resume Test
            </button>
          </div>
        </div>
      )}

      {quotaWarning && (
        <div className="bg-[#0B1120] border border-amber-500/40 rounded-lg p-4 flex items-center gap-3 text-xs text-amber-300">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>{quotaWarning}</span>
        </div>
      )}

      {serverError && (
        <div className="bg-[#0B1120] border border-red-500/40 rounded-lg p-4 flex items-center gap-3 text-xs text-red-300">
          <WifiOff className="h-4 w-4 shrink-0" />
          <span>Backend connection error: {serverError}</span>
        </div>
      )}

      {!activeMetrics ? (
        /* Idle NOC Overview State */
        <div className="space-y-6">
          <div className="bg-[#0B1120] border border-slate-800/90 rounded-lg p-6 lg:p-8 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-6">
            <div className="space-y-2 max-w-2xl">
              <h1 className="font-display text-2xl font-semibold text-slate-100 text-balance">
                Network Soak &amp; Sustained Bandwidth Diagnostics
              </h1>
              <p className="text-sm text-slate-400 leading-relaxed">
                Execute sustained download, upload, and bidirectional WebSocket stress tests for up
                to 24 continuous hours. Real-time throughput is measured in a dedicated Web Worker,
                logged every second to IndexedDB, and protected by automatic reconnection recovery.
              </p>
              <div className="pt-2 flex flex-wrap items-center gap-3 text-xs text-slate-400">
                <span>64 KB incompressible frames</span>
                <span aria-hidden="true">·</span>
                <span>perMessageDeflate disabled</span>
                <span aria-hidden="true">·</span>
                <span>Token-bucket rate control</span>
              </div>
            </div>

            <div className="shrink-0">
              <button
                type="button"
                onClick={onGoToNewTest}
                className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold rounded-md bg-cyan-500 hover:bg-cyan-400 text-slate-950 transition-colors cursor-pointer whitespace-nowrap"
              >
                <Play className="h-4 w-4 fill-current" />
                <span>Configure New Soak Test</span>
              </button>
            </div>
          </div>

          {/* Balanced Server Limits & Environment Strip */}
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
            <div className="bg-[#0B1120] border border-slate-800/90 rounded-lg p-4">
              <div className="text-xs text-slate-400">Max Session Duration</div>
              <div className="mt-1 font-mono tabular-nums text-xl font-semibold text-slate-100">
                {serverHealth ? formatDuration(serverHealth.limits.maxDurationSeconds) : '24:00:00'}
              </div>
              <div className="mt-1 text-xs text-slate-500">Enforced server-side ceiling</div>
            </div>

            <div className="bg-[#0B1120] border border-slate-800/90 rounded-lg p-4">
              <div className="text-xs text-slate-400">Bandwidth Safety Cap</div>
              <div className="mt-1 font-mono tabular-nums text-xl font-semibold text-cyan-400">
                {serverHealth
                  ? serverHealth.limits.maxBandwidthMbps === 0
                    ? 'Uncapped'
                    : `${serverHealth.limits.maxBandwidthMbps} Mbps`
                  : 'Uncapped'}
              </div>
              <div className="mt-1 text-xs text-slate-500">Server safety ceiling</div>
            </div>

            <div className="bg-[#0B1120] border border-slate-800/90 rounded-lg p-4">
              <div className="text-xs text-slate-400">Concurrent Streams / Client</div>
              <div className="mt-1 font-mono tabular-nums text-xl font-semibold text-slate-100">
                {serverHealth ? `${serverHealth.limits.maxParallelStreams} WS` : '6 WS'}
              </div>
              <div className="mt-1 text-xs text-slate-500">
                Up to {serverHealth?.limits.maxActiveSessionsPerClient ?? 2} active sessions per IP
              </div>
            </div>

            <div className="bg-[#0B1120] border border-slate-800/90 rounded-lg p-4">
              <div className="text-xs text-slate-400">Cumulative Data History</div>
              <div className="mt-1 font-mono tabular-nums text-xl font-semibold text-emerald-400">
                {formatBytesToGb(
                  history.reduce(
                    (acc, item) =>
                      acc + (item.total_download_bytes || 0) + (item.total_upload_bytes || 0),
                    0
                  )
                )}
              </div>
              <div className="mt-1 text-xs text-slate-500 font-mono tabular-nums">
                DL{' '}
                {formatBytesToGb(
                  history.reduce((acc, item) => acc + (item.total_download_bytes || 0), 0)
                )}{' '}
                · UL{' '}
                {formatBytesToGb(
                  history.reduce((acc, item) => acc + (item.total_upload_bytes || 0), 0)
                )}{' '}
                ({history.length} runs)
              </div>
            </div>
          </div>

          {/* Recent Sessions Quick Table */}
          <div className="bg-[#0B1120] border border-slate-800/90 rounded-lg p-5">
            <div className="flex items-center justify-between gap-4 mb-4">
              <div>
                <h2 className="font-display text-sm font-semibold text-slate-100">
                  Recent Diagnostic Runs
                </h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  Select a completed run to inspect full-session throughput telemetry or export CSV.
                </p>
              </div>
            </div>

            {history.length === 0 ? (
              <div className="py-10 text-center border border-dashed border-slate-800 rounded-md">
                <p className="text-sm text-slate-400">No soak tests recorded yet.</p>
                <button
                  type="button"
                  onClick={onGoToNewTest}
                  className="mt-3 px-4 py-2 text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-100 rounded-md cursor-pointer"
                >
                  Start First Test
                </button>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="border-b border-slate-800 text-slate-400">
                      <th className="py-2.5 pr-4 font-medium">Session ID</th>
                      <th className="py-2.5 px-3 font-medium">Direction</th>
                      <th className="py-2.5 px-3 font-medium text-right">Active Time</th>
                      <th className="py-2.5 px-3 font-medium text-right">Avg DL</th>
                      <th className="py-2.5 px-3 font-medium text-right">Avg UL</th>
                      <th className="py-2.5 px-3 font-medium text-right">Downloaded</th>
                      <th className="py-2.5 px-3 font-medium text-right">Uploaded</th>
                      <th className="py-2.5 px-3 font-medium text-right">Total</th>
                      <th className="py-2.5 px-3 font-medium">Status</th>
                      <th className="py-2.5 pl-3 font-medium text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/70">
                    {history.slice(0, 5).map((item) => (
                      <tr key={item.session_id} className="hover:bg-slate-900/40">
                        <td className="py-2.5 pr-4 font-mono tabular-nums text-slate-200">
                          {item.session_id}
                        </td>
                        <td className="py-2.5 px-3 capitalize text-slate-300">
                          {item.config.direction}
                        </td>
                        <td className="py-2.5 px-3 font-mono tabular-nums text-right text-slate-300">
                          {formatDuration(item.active_seconds)}
                        </td>
                        <td className="py-2.5 px-3 font-mono tabular-nums text-right text-cyan-300">
                          {item.config.direction === 'upload'
                            ? '—'
                            : `${formatMbps(item.avg_download_mbps)} Mbps`}
                        </td>
                        <td className="py-2.5 px-3 font-mono tabular-nums text-right text-emerald-300">
                          {item.config.direction === 'download'
                            ? '—'
                            : `${formatMbps(item.avg_upload_mbps)} Mbps`}
                        </td>
                        <td className="py-2.5 px-3 font-mono tabular-nums text-right text-cyan-300">
                          {formatBytesToGb(item.total_download_bytes)}
                        </td>
                        <td className="py-2.5 px-3 font-mono tabular-nums text-right text-emerald-300">
                          {formatBytesToGb(item.total_upload_bytes)}
                        </td>
                        <td className="py-2.5 px-3 font-mono tabular-nums text-right text-slate-200">
                          {formatBytesToGb(item.total_download_bytes + item.total_upload_bytes)}
                        </td>
                        <td className="py-2.5 px-3 capitalize text-slate-300">{item.status}</td>
                        <td className="py-2.5 pl-3 text-right whitespace-nowrap">
                          <button
                            type="button"
                            onClick={() => onOpenReport(item.session_id)}
                            className="text-cyan-400 hover:text-cyan-300 font-medium mr-3 cursor-pointer"
                          >
                            Report
                          </button>
                          <button
                            type="button"
                            onClick={() => onExportCsv(item.session_id, item.created_at)}
                            className="text-slate-300 hover:text-slate-100 font-medium cursor-pointer"
                          >
                            CSV
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      ) : (
        /* Live Active / Recently Completed Monitoring Cockpit */
        <div className="space-y-6">
          {/* Session Control & Status Bar */}
          <div className="bg-[#0B1120] border border-slate-800/90 rounded-lg p-4 lg:p-5 flex flex-wrap items-center justify-between gap-4">
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-3">
                {(() => {
                  const meta = STATUS_META[activeMetrics.status];
                  const Icon = meta.Icon;
                  return (
                    <span className={`inline-flex items-center gap-1.5 text-sm font-semibold ${meta.colorClass}`}>
                      <Icon
                        className={`h-4 w-4 shrink-0 ${
                          activeMetrics.status === 'reconnecting' || activeMetrics.status === 'initializing'
                            ? 'animate-spin'
                            : ''
                        }`}
                      />
                      <span>{meta.label}</span>
                    </span>
                  );
                })()}
                <span aria-hidden="true" className="text-slate-600">
                  ·
                </span>
                <span className="font-mono tabular-nums text-xs text-slate-200">
                  {activeMetrics.sessionId}
                </span>
                <span aria-hidden="true" className="text-slate-600">
                  ·
                </span>
                <span className="text-xs text-slate-400 capitalize">
                  {activeMetrics.config.direction} · {activeMetrics.activeStreams}/
                  {activeMetrics.config.parallelStreams} streams
                </span>
              </div>

              <div className="text-xs text-slate-400">
                Configured Target:{' '}
                <span className="font-mono tabular-nums text-slate-200">
                  {activeMetrics.config.targetMbps === 0
                    ? 'Uncapped (measured live)'
                    : `${activeMetrics.config.targetMbps} Mbps`}
                </span>
                <span className="mx-2 text-slate-600">·</span>
                Connection: <span className="capitalize text-slate-200">{activeMetrics.connectionState}</span>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              {/* Background Priority Keep-Alive Toggle */}
              <button
                type="button"
                onClick={() => {
                  const next = !backgroundKeepAlive.enabled;
                  backgroundKeepAlive.setEnabled(next);
                  if (next) backgroundKeepAlive.ensureActivatedFromGesture();
                }}
                title="Uses Web Locks and silent audio keep-alive to prevent browser timer throttling when you switch tabs, open other websites, or use other apps."
                className={`inline-flex items-center gap-2 px-3 py-2 text-xs font-medium rounded-md border transition-colors whitespace-nowrap cursor-pointer ${
                  backgroundKeepAlive.enabled
                    ? 'bg-slate-800 border-emerald-500/40 text-emerald-300'
                    : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
                }`}
              >
                <ShieldCheck className="h-3.5 w-3.5 shrink-0" />
                <span>
                  Background Priority: {backgroundKeepAlive.enabled ? 'ON' : 'OFF'}
                </span>
              </button>

              {/* Screen Wake Lock Toggle */}
              <button
                type="button"
                onClick={() => wakeLock.setEnabled(!wakeLock.enabled)}
                disabled={!wakeLock.supported}
                title={
                  wakeLock.supported
                    ? 'Prevents normal screen sleep while test is running; cannot prevent OS hardware suspension.'
                    : 'Screen Wake Lock API is not supported in this browser.'
                }
                className={`inline-flex items-center gap-2 px-3 py-2 text-xs font-medium rounded-md border transition-colors whitespace-nowrap cursor-pointer ${
                  !wakeLock.supported
                    ? 'bg-slate-900 border-slate-800 text-slate-500 cursor-not-allowed'
                    : wakeLock.enabled
                      ? 'bg-slate-800 border-cyan-500/40 text-cyan-300'
                      : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
                }`}
              >
                {wakeLock.enabled && wakeLock.supported ? (
                  <Eye className="h-3.5 w-3.5 shrink-0" />
                ) : (
                  <EyeOff className="h-3.5 w-3.5 shrink-0" />
                )}
                <span>
                  Keep Screen Awake: {!wakeLock.supported ? 'Unsupported' : wakeLock.enabled ? 'ON' : 'OFF'}
                </span>
              </button>

              {isRunning ? (
                <button
                  type="button"
                  onClick={onStopTest}
                  className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-md bg-red-600 hover:bg-red-500 text-white transition-colors whitespace-nowrap cursor-pointer"
                >
                  <Square className="h-3.5 w-3.5 fill-current" />
                  <span>STOP TEST</span>
                </button>
              ) : (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => onExportCsv(activeMetrics.sessionId, activeMetrics.wallStartedAt)}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-md bg-slate-800 hover:bg-slate-700 text-slate-100 whitespace-nowrap cursor-pointer"
                  >
                    <Download className="h-3.5 w-3.5" />
                    <span>Export CSV</span>
                  </button>
                  <button
                    type="button"
                    onClick={onGoToNewTest}
                    className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-md bg-cyan-500 hover:bg-cyan-400 text-slate-950 whitespace-nowrap cursor-pointer"
                  >
                    <Play className="h-3.5 w-3.5 fill-current" />
                    <span>New Test</span>
                  </button>
                </div>
              )}
            </div>
          </div>

          {wakeLock.error && (
            <div className="text-xs text-amber-400 bg-[#0B1120] border border-amber-500/30 rounded-md px-4 py-2.5">
              Wake Lock notice: {wakeLock.error}. Screen sleeping prevention is unavailable; keep tab active for uninterrupted sampling.
            </div>
          )}

          {/* Primary Download & Upload Telemetry Readouts */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            {/* Download Panel */}
            <div className="bg-[#0B1120] border border-slate-800/90 rounded-lg p-5">
              <div className="flex items-center justify-between pb-3 border-b border-slate-800/80">
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
                  <ArrowDown className="h-4 w-4 text-cyan-400" />
                  <span>Download Throughput</span>
                </div>
                <span className="text-xs font-mono tabular-nums text-slate-400">
                  {activeMetrics.config.direction === 'upload' ? 'Inactive in Upload mode' : 'Measured Live'}
                </span>
              </div>

              <div className="mt-4 flex items-baseline gap-2">
                <span className="font-mono tabular-nums text-4xl font-bold text-cyan-400">
                  {activeMetrics.config.direction === 'upload'
                    ? '—'
                    : formatMbps(activeMetrics.download.currentMbps)}
                </span>
                <span className="text-sm font-mono text-slate-400">Mbps</span>
              </div>

              <div className="mt-5 grid grid-cols-2 sm:grid-cols-4 gap-4 pt-4 border-t border-slate-800/80 text-xs">
                <div>
                  <div className="text-slate-400">Average</div>
                  <div className="mt-1 font-mono tabular-nums text-sm font-semibold text-slate-100">
                    {activeMetrics.config.direction === 'upload'
                      ? '—'
                      : `${formatMbps(activeMetrics.download.averageMbps)} Mbps`}
                  </div>
                </div>
                <div>
                  <div className="text-slate-400">Minimum</div>
                  <div className="mt-1 font-mono tabular-nums text-sm font-semibold text-slate-100">
                    {activeMetrics.config.direction === 'upload'
                      ? '—'
                      : `${formatMbps(activeMetrics.download.minMbps)} Mbps`}
                  </div>
                </div>
                <div>
                  <div className="text-slate-400">Max Observed</div>
                  <div className="mt-1 font-mono tabular-nums text-sm font-semibold text-slate-100">
                    {activeMetrics.config.direction === 'upload'
                      ? '—'
                      : `${formatMbps(activeMetrics.download.maxMbps)} Mbps`}
                  </div>
                </div>
                <div>
                  <div className="text-slate-400">Downloaded</div>
                  <div className="mt-1 font-mono tabular-nums text-sm font-semibold text-slate-100">
                    {formatBytesToGb(activeMetrics.download.totalBytes)}
                  </div>
                </div>
              </div>
            </div>

            {/* Upload Panel */}
            <div className="bg-[#0B1120] border border-slate-800/90 rounded-lg p-5">
              <div className="flex items-center justify-between pb-3 border-b border-slate-800/80">
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
                  <ArrowUp className="h-4 w-4 text-emerald-400" />
                  <span>Upload Throughput</span>
                </div>
                <span className="text-xs font-mono tabular-nums text-slate-400">
                  {activeMetrics.config.direction === 'download' ? 'Inactive in Download mode' : 'Measured Live'}
                </span>
              </div>

              <div className="mt-4 flex items-baseline gap-2">
                <span className="font-mono tabular-nums text-4xl font-bold text-emerald-400">
                  {activeMetrics.config.direction === 'download'
                    ? '—'
                    : formatMbps(activeMetrics.upload.currentMbps)}
                </span>
                <span className="text-sm font-mono text-slate-400">Mbps</span>
              </div>

              <div className="mt-5 grid grid-cols-2 sm:grid-cols-4 gap-4 pt-4 border-t border-slate-800/80 text-xs">
                <div>
                  <div className="text-slate-400">Average</div>
                  <div className="mt-1 font-mono tabular-nums text-sm font-semibold text-slate-100">
                    {activeMetrics.config.direction === 'download'
                      ? '—'
                      : `${formatMbps(activeMetrics.upload.averageMbps)} Mbps`}
                  </div>
                </div>
                <div>
                  <div className="text-slate-400">Minimum</div>
                  <div className="mt-1 font-mono tabular-nums text-sm font-semibold text-slate-100">
                    {activeMetrics.config.direction === 'download'
                      ? '—'
                      : `${formatMbps(activeMetrics.upload.minMbps)} Mbps`}
                  </div>
                </div>
                <div>
                  <div className="text-slate-400">Max Observed</div>
                  <div className="mt-1 font-mono tabular-nums text-sm font-semibold text-slate-100">
                    {activeMetrics.config.direction === 'download'
                      ? '—'
                      : `${formatMbps(activeMetrics.upload.maxMbps)} Mbps`}
                  </div>
                </div>
                <div>
                  <div className="text-slate-400">Uploaded</div>
                  <div className="mt-1 font-mono tabular-nums text-sm font-semibold text-slate-100">
                    {formatBytesToGb(activeMetrics.upload.totalBytes)}
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Session Information Grid */}
          <div className="bg-[#0B1120] border border-slate-800/90 rounded-lg p-5">
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4 text-xs">
              <div>
                <div className="text-slate-400">Active Test Time</div>
                <div className="mt-1 font-mono tabular-nums text-base font-semibold text-slate-100">
                  {formatDuration(activeMetrics.activeTestingSeconds)}
                </div>
                <div className="text-[11px] text-slate-500 font-mono tabular-nums">
                  Wall {formatDuration(activeMetrics.wallElapsedSeconds)}
                </div>
              </div>

              <div>
                <div className="text-slate-400">Remaining Time</div>
                <div className="mt-1 font-mono tabular-nums text-base font-semibold text-slate-100">
                  {formatDuration(activeMetrics.remainingSeconds)}
                </div>
                <div className="text-[11px] text-slate-500 font-mono tabular-nums">
                  Target {formatDuration(activeMetrics.config.durationSeconds)}
                </div>
              </div>

              <div>
                <div className="text-slate-400">Total Transferred</div>
                <div className="mt-1 font-mono tabular-nums text-base font-semibold text-slate-100">
                  {formatBytesToGb(
                    activeMetrics.download.totalBytes + activeMetrics.upload.totalBytes
                  )}
                </div>
                <div className="text-[11px] text-slate-500">Combined DL + UL</div>
              </div>

              <div>
                <div className="text-slate-400">Disconnects</div>
                <div
                  className={`mt-1 font-mono tabular-nums text-base font-semibold ${
                    activeMetrics.disconnectCount > 0 ? 'text-amber-400' : 'text-slate-100'
                  }`}
                >
                  {activeMetrics.disconnectCount}
                </div>
                <div className="text-[11px] text-slate-500 font-mono tabular-nums">
                  {activeMetrics.reconnectAttempts} reconnect attempt
                  {activeMetrics.reconnectAttempts === 1 ? '' : 's'}
                </div>
              </div>

              <div>
                <div className="text-slate-400">Connection Uptime</div>
                <div
                  className={`mt-1 font-mono tabular-nums text-base font-semibold ${
                    activeMetrics.uptimePercent >= 99
                      ? 'text-emerald-400'
                      : activeMetrics.uptimePercent >= 90
                        ? 'text-amber-400'
                        : 'text-red-400'
                  }`}
                >
                  {activeMetrics.uptimePercent.toFixed(2)}%
                </div>
                <div className="text-[11px] text-slate-500 font-mono tabular-nums">
                  Outage {formatDuration(activeMetrics.outageSeconds)}
                </div>
              </div>

              <div>
                <div className="text-slate-400">Target vs Measured</div>
                <div className="mt-1 font-mono tabular-nums text-base font-semibold text-slate-100">
                  {activeMetrics.config.targetMbps === 0
                    ? 'Uncapped'
                    : `${activeMetrics.config.targetMbps} Mbps`}
                </div>
                <div className="text-[11px] text-slate-500">
                  {activeMetrics.config.parallelStreams} parallel stream
                  {activeMetrics.config.parallelStreams > 1 ? 's' : ''}
                </div>
              </div>
            </div>
          </div>

          {/* Live Throughput Graph */}
          <ThroughputChart
            samples={displayedSamples}
            showDownload={
              activeMetrics.config.direction === 'download' ||
              activeMetrics.config.direction === 'bidirectional'
            }
            showUpload={
              activeMetrics.config.direction === 'upload' ||
              activeMetrics.config.direction === 'bidirectional'
            }
            rangeMode={chartRange}
            onRangeModeChange={setChartRange}
            loadingFull={loadingFull}
            targetMbps={activeMetrics.config.targetMbps}
          />

          {/* Live Event Log */}
          <EventLogPanel
            events={liveEvents}
            autoScroll={settings.autoScrollEventLog}
          />
        </div>
      )}
    </div>
  );
}
